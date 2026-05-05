import React, { useState } from "react";
import { GlassPanel } from "@pcc/ui";
import { getAuthHeaders } from "../../stores/auth-store.js";

const API_ROOT = (import.meta.env.VITE_PCC_URL ?? "");

/**
 * T2.7 — buyer-side rate-submit form.
 * Posts to /api/operators/:id/rate with auth header. The backend keys the
 * row by (jobId, buyerId) and returns 409 on duplicate so this form is
 * naturally idempotent for the same buyer + job pair.
 */
export function RateSubmitForm({
  operatorId,
  onSubmitted,
}: {
  operatorId: string;
  onSubmitted?: () => void;
}) {
  const [rating, setRating] = useState<number>(5);
  const [jobId, setJobId] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const submit = async () => {
    setStatus(null);
    if (!jobId.trim()) {
      setStatus({ kind: "err", msg: "Job ID is required." });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${API_ROOT}/api/operators/${encodeURIComponent(operatorId)}/rate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          rating,
          jobId: jobId.trim(),
          ...(comment.trim() ? { comment: comment.trim() } : {}),
        }),
      });
      if (res.status === 201) {
        setStatus({ kind: "ok", msg: "Rating submitted." });
        setJobId("");
        setComment("");
        onSubmitted?.();
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        const msg =
          res.status === 409
            ? "You've already rated this job."
            : res.status === 401
            ? "Sign in to rate this operator."
            : body.message ?? body.error ?? `HTTP ${res.status}`;
        setStatus({ kind: "err", msg });
      }
    } catch (e) {
      setStatus({ kind: "err", msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <GlassPanel padding="md" className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/30">Rate this operator</span>
      </div>

      <div className="flex items-center gap-1">
        {([1, 2, 3, 4, 5] as const).map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setRating(n)}
            className={`text-lg transition-colors ${n <= rating ? "text-green-400/80" : "text-white/15 hover:text-white/40"}`}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
          >
            ★
          </button>
        ))}
        <span className="ml-2 text-xs text-white/40 font-mono">{rating} / 5</span>
      </div>

      <div className="space-y-2">
        <input
          value={jobId}
          onChange={(e) => setJobId(e.target.value)}
          placeholder="Job ID (the job you completed)"
          className="w-full px-3 py-1.5 rounded text-xs bg-white/[0.04] border border-white/[0.06] text-white/70 placeholder:text-white/20 outline-none focus:border-white/[0.12]"
          disabled={busy}
        />
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Optional comment (max 1000 chars)"
          rows={2}
          maxLength={1000}
          className="w-full px-3 py-1.5 rounded text-xs bg-white/[0.04] border border-white/[0.06] text-white/70 placeholder:text-white/20 outline-none focus:border-white/[0.12] resize-none"
          disabled={busy}
        />
      </div>

      <button
        type="button"
        onClick={submit}
        disabled={busy || !jobId.trim()}
        className="px-3 py-1.5 rounded text-xs bg-green-500/10 border border-green-500/20 text-green-400/80 hover:bg-green-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
      >
        {busy ? "Submitting…" : "Submit rating"}
      </button>

      {status && (
        <div className={`text-xs ${status.kind === "ok" ? "text-green-400/70" : "text-red-400/70"}`}>
          {status.msg}
        </div>
      )}
    </GlassPanel>
  );
}
