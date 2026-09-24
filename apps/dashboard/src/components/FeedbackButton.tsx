import React, { useState } from "react";
import { cn } from "@pcc/ui";
import { getAuthHeaders } from "../stores/auth-store.js";

/**
 * "Report a bug / leave feedback", posted to POST /api/feedback.
 *
 * Moved here from the retired AgentChatPage, whose feedback form was the one
 * part of that page backed by a real endpoint.
 */
function FeedbackModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [type, setType] = useState<"bug" | "comment" | "difficulty" | "suggestion">("bug");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  if (!open) return null;

  const handleSubmit = async () => {
    if (!message.trim()) return;
    setStatus("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ type, message, page: window.location.pathname }),
      });
      if (res.ok) {
        setStatus("sent");
        setMessage("");
        setTimeout(() => { setStatus("idle"); onClose(); }, 1500);
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Report a bug or leave feedback"
        className="w-full max-w-lg mx-4 rounded-2xl border border-white/[0.08] bg-gray-900/95 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 space-y-4">
          <h2 className="text-lg font-semibold text-white">Report a Bug or Leave Feedback</h2>
          <p className="text-xs text-white/40">Found something weird? Having trouble? Let us know.</p>
          <div className="flex gap-2 flex-wrap">
            {(["bug", "difficulty", "suggestion", "comment"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={cn(
                  "px-3 py-1.5 text-xs rounded-xl border capitalize transition-all",
                  type === t
                    ? "bg-teal-500/20 border-teal-500/40 text-teal-300"
                    : "border-white/[0.08] text-white/40 hover:text-white/60",
                )}
              >
                {t === "bug" ? "Bug Report" : t === "difficulty" ? "Having Trouble" : t === "suggestion" ? "Suggestion" : "Comment"}
              </button>
            ))}
          </div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Describe the issue or share your thoughts..."
            rows={5}
            maxLength={5000}
            aria-label="Feedback message"
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white/80 placeholder-white/25 outline-none focus:border-teal-500/40 transition-colors resize-none"
          />
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-white/20">{message.length}/5000</span>
            <div className="flex gap-3">
              <button type="button" onClick={onClose} className="px-4 py-2 text-xs text-white/40 hover:text-white/60 transition-colors">Cancel</button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!message.trim() || status === "sending"}
                className={cn(
                  "px-6 py-2 rounded-xl text-sm font-medium transition-all",
                  status === "sent"
                    ? "bg-green-500/20 text-green-400 border border-green-500/30"
                    : status === "error"
                    ? "bg-red-500/20 text-red-400 border border-red-500/30"
                    : "bg-teal-500 hover:bg-teal-400 text-white disabled:opacity-40 disabled:cursor-not-allowed",
                )}
              >
                {status === "sending" ? "Sending..." : status === "sent" ? "Submitted!" : status === "error" ? "Failed -- retry?" : "Submit"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Small top-bar button that opens the feedback form. */
export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 rounded-lg text-xs border border-white/[0.08] text-white/40 hover:text-teal-300 hover:border-teal-500/30 transition-all"
      >
        Feedback
      </button>
      <FeedbackModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
