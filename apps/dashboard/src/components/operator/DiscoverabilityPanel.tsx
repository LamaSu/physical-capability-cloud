import React, { useEffect, useState } from "react";
import { GlassPanel, GlowBadge } from "@pcc/ui";
import { getAuthHeaders } from "../../stores/auth-store.js";

const API_ROOT = (import.meta.env.VITE_PCC_URL ?? "");

interface Diagnostics {
  operatorId: string;
  indexed_at: string | null;
  last_match_query_at: string | null;
  top_keyword_misses: string[];
  suggestions: string[];
  data_quality: "live" | "placeholder";
}

/**
 * T2.4 — discoverability diagnostics panel.
 * Renders the operator's index status, recent buyer-query miss terms, and
 * actionable suggestions. Pulls from GET /api/operators/:id/discoverability
 * (auth-gated by apiGate). Falls back to a quiet empty state if the endpoint
 * returns 404 or the network is offline.
 */
export function DiscoverabilityPanel({ operatorId }: { operatorId: string }) {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_ROOT}/api/operators/${encodeURIComponent(operatorId)}/discoverability`, {
          headers: { ...getAuthHeaders() },
        });
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as Diagnostics;
        if (!cancelled) setDiag(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [operatorId]);

  if (error || !diag) {
    return null; // silent — diagnostics are advisory, never gate the page
  }

  const lastMatchLabel = diag.last_match_query_at
    ? new Date(diag.last_match_query_at).toLocaleString()
    : "no buyer queries yet";

  return (
    <GlassPanel padding="md" className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/30">Discoverability</span>
        <GlowBadge color={diag.data_quality === "live" ? "green" : "gray"}>
          {diag.data_quality}
        </GlowBadge>
      </div>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-[10px] text-white/20">Indexed at</div>
          <div className="text-white/60 mt-0.5">
            {diag.indexed_at ? new Date(diag.indexed_at).toLocaleDateString() : "—"}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-white/20">Last buyer query</div>
          <div className="text-white/60 mt-0.5">{lastMatchLabel}</div>
        </div>
      </div>
      {diag.top_keyword_misses.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] text-white/20">Top keyword misses</div>
          <div className="flex gap-1 flex-wrap">
            {diag.top_keyword_misses.map((kw) => (
              <span
                key={kw}
                className="px-2 py-0.5 rounded text-[10px] bg-white/[0.04] text-white/40 font-mono"
              >
                {kw}
              </span>
            ))}
          </div>
        </div>
      )}
      {diag.suggestions.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] text-white/20">Suggestions</div>
          <ul className="space-y-1 text-xs text-white/60">
            {diag.suggestions.map((s, i) => (
              <li key={i} className="leading-snug">• {s}</li>
            ))}
          </ul>
        </div>
      )}
    </GlassPanel>
  );
}
