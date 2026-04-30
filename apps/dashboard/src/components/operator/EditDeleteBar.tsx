import React, { useState } from "react";
import { GlassPanel } from "@pcc/ui";
import { getAuthHeaders } from "../../stores/auth-store.js";

const API_ROOT = (import.meta.env.VITE_PCC_URL ?? "");

/**
 * T2.2 — owner-only edit + delete UI for an operator registration.
 *
 * Backend enforces owner-must-be-caller (PATCH/DELETE /api/onboard/registrations/:id).
 * UI doesn't pre-filter visibility because the dashboard doesn't yet know who
 * the viewer is — buttons present, 403 from the backend gates real action.
 */

interface EditDeleteBarProps {
  operatorId: string;
  initialDescription?: string;
  initialComplianceRegulations?: string[];
  onMutated?: () => void;
}

export function EditDeleteBar({
  operatorId,
  initialDescription,
  initialComplianceRegulations,
  onMutated,
}: EditDeleteBarProps) {
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const [description, setDescription] = useState(initialDescription ?? "");
  const [regs, setRegs] = useState((initialComplianceRegulations ?? []).join(", "));

  const patch = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const body: Record<string, unknown> = {};
      body.description = description;
      const splitRegs = regs.split(",").map((s) => s.trim()).filter(Boolean);
      body.complianceRegulations = splitRegs;
      const res = await fetch(`${API_ROOT}/api/onboard/registrations/${encodeURIComponent(operatorId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setStatus({ kind: "ok", msg: "Saved." });
        setEditOpen(false);
        onMutated?.();
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        const msg =
          res.status === 403
            ? "Only the registration owner can edit this."
            : res.status === 401
            ? "Sign in to edit this registration."
            : j.message ?? j.error ?? `HTTP ${res.status}`;
        setStatus({ kind: "err", msg });
      }
    } catch (e) {
      setStatus({ kind: "err", msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`${API_ROOT}/api/onboard/registrations/${encodeURIComponent(operatorId)}`, {
        method: "DELETE",
        headers: { ...getAuthHeaders() },
      });
      if (res.ok) {
        setStatus({ kind: "ok", msg: "Registration deleted (soft)." });
        setConfirmDelete(false);
        onMutated?.();
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        const msg =
          res.status === 403
            ? "Only the registration owner can delete this."
            : res.status === 401
            ? "Sign in to delete this registration."
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
    <GlassPanel padding="md" className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/30">Manage registration</span>
        <span className="text-[10px] text-white/20">owner-only</span>
      </div>

      {!editOpen && !confirmDelete && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => { setStatus(null); setEditOpen(true); }}
            className="px-3 py-1.5 rounded text-xs bg-white/[0.04] border border-white/[0.06] text-white/70 hover:bg-white/[0.08] transition-all"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => { setStatus(null); setConfirmDelete(true); }}
            className="px-3 py-1.5 rounded text-xs bg-red-500/10 border border-red-500/20 text-red-400/80 hover:bg-red-500/20 transition-all"
          >
            Delete
          </button>
        </div>
      )}

      {editOpen && (
        <div className="space-y-2">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description"
            rows={2}
            className="w-full px-3 py-1.5 rounded text-xs bg-white/[0.04] border border-white/[0.06] text-white/70 placeholder:text-white/20 outline-none focus:border-white/[0.12] resize-none"
            disabled={busy}
          />
          <input
            value={regs}
            onChange={(e) => setRegs(e.target.value)}
            placeholder="Compliance regs (comma-separated, e.g. ISO-9001:2015, AS9100:2016)"
            className="w-full px-3 py-1.5 rounded text-xs bg-white/[0.04] border border-white/[0.06] text-white/70 placeholder:text-white/20 outline-none focus:border-white/[0.12]"
            disabled={busy}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={patch}
              disabled={busy}
              className="px-3 py-1.5 rounded text-xs bg-green-500/10 border border-green-500/20 text-green-400/80 hover:bg-green-500/20 disabled:opacity-40 transition-all"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setEditOpen(false)}
              disabled={busy}
              className="px-3 py-1.5 rounded text-xs text-white/40 hover:text-white/60 disabled:opacity-40 transition-all"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="space-y-2">
          <p className="text-xs text-white/60 leading-snug">
            Soft-delete this registration? The row stays for audit but the
            operator becomes invisible to discovery and matching.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={del}
              disabled={busy}
              className="px-3 py-1.5 rounded text-xs bg-red-500/15 border border-red-500/25 text-red-400 hover:bg-red-500/25 disabled:opacity-40 transition-all"
            >
              {busy ? "Deleting…" : "Yes, delete"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              disabled={busy}
              className="px-3 py-1.5 rounded text-xs text-white/40 hover:text-white/60 disabled:opacity-40 transition-all"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {status && (
        <div className={`text-xs ${status.kind === "ok" ? "text-green-400/70" : "text-red-400/70"}`}>
          {status.msg}
        </div>
      )}
    </GlassPanel>
  );
}
