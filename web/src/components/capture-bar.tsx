"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { clsx } from "clsx";
import { Camera, Mic, Send, X, Loader2, Check, AlertTriangle } from "lucide-react";
import { runCapture } from "@/lib/services";

type Status = { kind: "idle" | "working" | "done" | "error"; msg?: string };

// Minimal typing for the vendor-prefixed Web Speech API.
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onend: () => void;
  start: () => void;
  stop: () => void;
};

export function CaptureBar({ onCaptured }: { onCaptured?: () => void }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [listening, setListening] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);

  const busy = status.kind === "working";
  const canSend = (text.trim() || files.length) && !busy;

  async function submit() {
    if (!canSend) return;
    setStatus({ kind: "working", msg: "Reading + reasoning…" });
    try {
      const res = await runCapture({ text, files });
      if (res.degraded) {
        setStatus({ kind: "error", msg: res.reason || "Queued for review." });
      } else {
        setStatus({
          kind: "done",
          msg: res.toolCalls ? `${res.toolCalls} update${res.toolCalls === 1 ? "" : "s"} applied` : "Captured",
        });
        setText("");
        setFiles([]);
        onCaptured?.();
      }
    } catch (e) {
      setStatus({ kind: "error", msg: e instanceof Error ? e.message : "Capture failed." });
    }
    setTimeout(() => setStatus({ kind: "idle" }), 3200);
  }

  function toggleVoice() {
    const SR =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;
    if (!SR) {
      setStatus({ kind: "error", msg: "Voice not supported in this browser." });
      setTimeout(() => setStatus({ kind: "idle" }), 2500);
      return;
    }
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const rec = new SR();
    rec.lang = "en-IN";
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = "";
    rec.onresult = (e) => {
      finalText = Array.from({ length: e.results.length }, (_, i) => e.results[i][0].transcript).join(" ");
      setText((prev) => (prev ? prev.split(" ⟨")[0] : "") + " ⟨" + finalText + "⟩");
    };
    rec.onend = () => {
      setListening(false);
      setText((prev) => prev.replace(/\s*⟨|⟩/g, " ").trim());
    };
    recognition.current = rec;
    setListening(true);
    rec.start();
  }

  return (
    <div className="card overflow-hidden p-0">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
        rows={2}
        placeholder="Log anything — ₹250 lunch at cafe, did legs 3×10, slept 7h…"
        className="w-full resize-none bg-transparent px-4 pt-4 text-[15px] leading-relaxed outline-none placeholder:text-muted"
      />

      <AnimatePresence>
        {files.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="flex flex-wrap gap-2 px-4"
          >
            {files.map((f, i) => (
              <span key={i} className="chip">
                {f.name.slice(0, 20)}
                <button onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-1">
          <input
            ref={fileInput}
            type="file"
            accept="image/*,audio/*,.pdf,.csv"
            multiple
            hidden
            onChange={(e) => {
              setFiles((prev) => [...prev, ...Array.from(e.target.files || [])]);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => fileInput.current?.click()}
            className="grid h-10 w-10 place-items-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-text"
            aria-label="Attach photo or file"
          >
            <Camera size={19} />
          </button>
          <button
            onClick={toggleVoice}
            className={clsx(
              "grid h-10 w-10 place-items-center rounded-xl transition",
              listening ? "animate-pulse-ring bg-danger/20 text-danger" : "text-muted hover:bg-surface-2 hover:text-text",
            )}
            aria-label="Voice capture"
          >
            <Mic size={19} />
          </button>
        </div>

        <button onClick={submit} disabled={!canSend} className="btn-primary">
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          {busy ? "Working" : "Capture"}
        </button>
      </div>

      <AnimatePresence>
        {status.kind !== "idle" && status.kind !== "working" && (
          <motion.div
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ opacity: 0 }}
            className={clsx(
              "flex items-center gap-2 px-4 py-2.5 text-sm font-medium",
              status.kind === "done" ? "text-success" : "text-warn",
            )}
          >
            {status.kind === "done" ? <Check size={16} /> : <AlertTriangle size={16} />}
            {status.msg}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
