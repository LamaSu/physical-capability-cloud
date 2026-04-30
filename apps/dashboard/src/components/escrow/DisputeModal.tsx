import React, { useEffect, useState } from "react";
import { GlassPanel } from "@pcc/ui";
import { getAuthHeaders } from "../../stores/auth-store.js";

const API_ROOT = (import.meta.env.VITE_PCC_URL ?? "");

/**
 * T2.8 — dispute UI surface.
 * Inline modal that POSTs to /api/escrow/:id/dispute with the buyer's
 * reason and (optional) milestone reference. The backend already exists per
 * CLAUDE.md §3 Escrow & Settlement; this component is the missing UI surface.
 */
export function DisputeModal({
  escrowId,
  milestoneStepId,
  onClose,
  onFiled,
}: {
  escrowId: string;
  milestoneStepId?: string;
  onClose: () => void;
  onFiled?: () => void;
}) {
  const [reason, setReason] = useState("");
  const [evidenceHash, setEvidenceHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  // Close on Escape for keyboard parity with the rest of the dashboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fileDispute = async () => {
    if (!reason.trim()) {
      setStatus({ kind: "err", msg: "Reason is required." });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const body: Record<string, unknown> = { reason: reason.trim() };
      if (milestoneStepId) body.milestoneStepId = milestoneStepId;
      if (evidenceHash.trim()) body.challengerEvidenceHash = evidenceHash.trim();

      const res = await fetch(`${API_ROOT}/api/escrow/${encodeURIComponent(escrowId)}/dispute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        setStatus({ kind: "ok", msg: "Dispute filed. Arbiters notified." });
        onFiled?.();
        // Auto-close after a moment so the user sees the confirmation
        setTimeout(onClose, 1200);
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        const msg =
          res.status === 401
            ? "Sign in to file a dispute."
            : res.status === 403
            ? "Only the escrow's payer or arbiter can file a dispute."
            : j.message ?? j.error ?? `HTTP ${res.status}`;
        setStatus({ kind: "err", msg });
      }
    } catch (e) {
      setStatus({ kind: "err", msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <GlassPanel padding="lg" className="space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-base font-semibold text-white/90">File a dispute</h3>
              <p className="text-xs text-white/40 mt-0.5">
                Escrow <span className="font-mono text-white/60">{escrowId}</span>
                {milestoneStepId && (
                  <> · milestone <span className="font-mono text-white/60">{milestoneStepId}</span></>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-white/30 hover:text-white/60 text-lg leading-none"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] text-white/30 uppercase tracking-wide">
              What went wrong?
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Describe the issue. Be specific — arbiters review this."
              rows={4}
              maxLength={2000}
              className="w-full px-3 py-2 rounded text-xs bg-white/[0.04] border border-white/[0.06] text-white/70 placeholder:text-white/20 outline-none focus:border-white/[0.12] resize-none"
              disabled={busy}
            />
            <span className="text-[10px] text-white/20">{reason.length} / 2000</span>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] text-white/30 uppercase tracking-wide">
              Evidence hash (optional)
            </label>
            <input
              value={evidenceHash}
              onChange={(e) => setEvidenceHash(e.target.value)}
              placeholder="sha256:... or IPFS CID — links the dispute to off-chain evidence"
              className="w-full px-3 py-1.5 rounded text-xs font-mono bg-white/[0.04] border border-white/[0.06] text-white/70 placeholder:text-white/20 outline-none focus:border-white/[0.12]"
              disabled={busy}
            />
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-white/[0.06]">
            <p className="text-[10px] text-white/30 leading-snug max-w-xs">
              Filing a dispute pauses the milestone release until arbitration concludes. Bond may be required.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="px-3 py-1.5 rounded text-xs text-white/40 hover:text-white/60 disabled:opacity-40 transition-all"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={fileDispute}
                disabled={busy || !reason.trim()}
                className="px-3 py-1.5 rounded text-xs bg-red-500/15 border border-red-500/25 text-red-400 hover:bg-red-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                {busy ? "Filing…" : "File dispute"}
              </button>
            </div>
          </div>

          {status && (
            <div className={`text-xs ${status.kind === "ok" ? "text-green-400/70" : "text-red-400/70"}`}>
              {status.msg}
            </div>
          )}
        </GlassPanel>
      </div>
    </div>
  );
}
