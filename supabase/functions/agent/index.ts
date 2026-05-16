type Domain = "money" | "diet" | "fitness" | "wellness";
type SourceType = "text" | "image" | "audio" | "file" | "mixed";

type AgentRequest = {
  ingestionId: string;
  userId: string;
  sourceType: SourceType;
  text?: string;
  media?: Array<{ mimeType: string; base64: string; name?: string }>;
  mediaAssetIds?: string[];
  mode?: "auto" | Domain;
};

type ToolCall = {
  name: string;
  arguments: Record<string, unknown>;
  confidence: number;
};

const DEEPSEEK_MODEL = "deepseek-ai/deepseek-v4-pro";
const GEMINI_MEDIA_MODEL = "gemini-2.5-flash";

const toolNames = [
  "create_expense_candidate",
  "create_income_candidate",
  "create_transfer_candidate",
  "create_statement_row_candidate",
  "create_food_log_candidate",
  "estimate_food_macros",
  "create_workout_log_candidate",
  "create_body_metric_candidate",
  "create_wellness_note_candidate",
  "link_duplicate_candidates",
  "request_user_review",
  "apply_verified_action",
] as const;

function requireSecret(name: string) {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing secret: ${name}`);
  }
  return value;
}

function validateToolCall(call: ToolCall) {
  if (!toolNames.includes(call.name as (typeof toolNames)[number])) {
    throw new Error(`Unknown tool: ${call.name}`);
  }

  if (call.confidence < 0 || call.confidence > 1) {
    throw new Error(`Invalid confidence for ${call.name}`);
  }

  return call;
}

async function callDeepSeekAgent(request: AgentRequest): Promise<ToolCall[]> {
  const apiKey = requireSecret("NVIDIA_API_KEY");
  const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      temperature: 0,
      max_tokens: 2048,
      stream: false,
      messages: [
        {
          role: "system",
          content:
            "You convert messy personal logs into tool calls only. Never invent facts. " +
            "Prefer review when confidence is low. Do not delete data.",
        },
        {
          role: "user",
          content: JSON.stringify(request),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek request failed: ${response.status}`);
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content ?? "[]";
  const parsed = JSON.parse(content) as ToolCall[];
  return parsed.map(validateToolCall);
}

async function callGeminiMediaExtraction(request: AgentRequest) {
  const apiKey = requireSecret("GEMINI_API_KEY");
  if (!request.media?.length) {
    return {
      model: GEMINI_MEDIA_MODEL,
      extractedText: "",
      labels: [],
      confidence: 0,
    };
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MEDIA_MODEL}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "Extract only factual evidence for a personal tracker. Return concise JSON with text, dates, amounts, merchants, foods, quantities, confidence, and uncertainty. Never invent missing values.",
            },
            ...request.media.map((item) => ({
              inlineData: {
                mimeType: item.mimeType,
                data: item.base64,
              },
            })),
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini media extraction failed: ${response.status}`);
  }

  const json = await response.json();
  return {
    model: GEMINI_MEDIA_MODEL,
    extractedText: json.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
    labels: [],
    confidence: 0.7,
  };
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const payload = (await req.json()) as AgentRequest;
    if (payload.sourceType === "image" || payload.sourceType === "audio" || payload.sourceType === "file") {
      await callGeminiMediaExtraction(payload);
    }

    const toolCalls = await callDeepSeekAgent(payload);
    return Response.json({ ok: true, toolCalls });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
});
