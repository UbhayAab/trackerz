// The app answering out loud.
//
// Until now the AI could only ever WRITE. Ask it something and the prompt routed
// the capture to `request_user_review` with reason "query" - a queue nothing has
// ever rendered, in any surface, since the app was built (four rows, all still
// 'proposed'). So a real question typed into the capture box produced silence
// and zero rows:
//
//   2026-07-24 14:14  "Wtf happenend"                                  -> nothing
//   2026-07-24 14:15  "Look at the cal numbers that you have pushed."  -> nothing
//
// The model now answers with `answer_question`, and this renders the reply
// straight above the capture box. It writes nothing to any tracker.

const HOST = "#captureAnswer";

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/** Pull the first answer_question call out of a capture result, or null. */
export function answerFrom(result) {
  const calls = result?.toolCalls || [];
  const hit = calls.find((c) => c?.name === "answer_question" || c?.tool_name === "answer_question");
  if (!hit) return null;
  const a = hit.arguments || {};
  const answer = String(a.answer || "").trim();
  if (!answer) return null;
  return { answer, question: String(a.question || "").trim(), basis: String(a.basis || "").trim() };
}

export function clearAnswer() {
  const host = document.querySelector(HOST);
  if (!host) return;
  host.hidden = true;
  host.innerHTML = "";
}

export function renderAnswer(payload) {
  const host = document.querySelector(HOST);
  if (!host) return;
  if (!payload?.answer) return clearAnswer();

  host.hidden = false;
  host.innerHTML = `
    <div class="answer-card">
      <div class="answer-head">
        <p class="eyebrow">Answer</p>
        <button type="button" class="answer-dismiss" data-answer="dismiss" aria-label="Dismiss answer">✕</button>
      </div>
      ${payload.question ? `<p class="answer-q">${esc(payload.question)}</p>` : ""}
      <p class="answer-body">${esc(payload.answer)}</p>
      ${payload.basis ? `<p class="answer-basis">From: ${esc(payload.basis)}</p>` : ""}
    </div>
  `;
}

export function bindAnswerCard() {
  const host = document.querySelector(HOST);
  if (!host || host.dataset.answerBound) return;
  host.dataset.answerBound = "1";
  host.addEventListener("click", (event) => {
    if (event.target.closest('[data-answer="dismiss"]')) clearAnswer();
  });
}
