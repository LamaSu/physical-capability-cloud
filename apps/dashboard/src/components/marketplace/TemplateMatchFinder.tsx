import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { GlassPanel, GlowBadge } from "@pcc/ui";

const API_ROOT = (import.meta.env.VITE_PCC_URL ?? "");

interface TemplateMatch {
  slug: string;
  display_name: string;
  description: string;
  produces_kind: string;
  capability_class: "physical" | "digital";
  score: number;
  reason: string;
}

/**
 * T2.1 — buyer-side marketplace section that consumes the real
 * POST /api/capabilities/templates/match endpoint (public, no auth).
 *
 * Replaces a chunk of the prior mock-only MarketplacePage with a working
 * "what do you need?" input that ranks template paths against the buyer's
 * description. Score-ordered, tinted by capability_class.
 */
export function TemplateMatchFinder() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<TemplateMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    setBusy(true);
    setError(null);
    setMatches(null);
    try {
      const res = await fetch(`${API_ROOT}/api/capabilities/templates/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: query }),
      });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { matches: TemplateMatch[] };
      setMatches(data.matches ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <GlassPanel padding="md" className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/30">Find what fits</span>
        <span className="text-[10px] text-white/20">live match · no mocks</span>
      </div>

      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && query.trim() && !busy && search()}
          placeholder="What do you need? (e.g. 'I run a 3D printing shop' or 'I have a Postgres warehouse')"
          className="flex-1 px-3 py-1.5 rounded text-xs bg-white/[0.04] border border-white/[0.06] text-white/70 placeholder:text-white/20 outline-none focus:border-white/[0.12]"
          disabled={busy}
        />
        <button
          type="button"
          onClick={search}
          disabled={busy || !query.trim()}
          className="px-3 py-1.5 rounded text-xs bg-green-500/10 border border-green-500/20 text-green-400/80 hover:bg-green-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          {busy ? "Matching…" : "Match"}
        </button>
      </div>

      {error && <div className="text-xs text-red-400/70">{error}</div>}

      {matches && matches.length === 0 && (
        <div className="text-xs text-white/40">No matches — try describing what you do or what you have in different words.</div>
      )}

      {matches && matches.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-white/[0.06]">
          {matches.map((m) => (
            <button
              key={m.slug}
              type="button"
              onClick={() => navigate(`/orchestrator/${m.slug}/chat`)}
              className="w-full text-left p-3 rounded bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.06] transition-all space-y-1"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-white/80">{m.display_name}</span>
                  <GlowBadge color={m.capability_class === "physical" ? "green" : "gold"}>
                    {m.capability_class}
                  </GlowBadge>
                </div>
                <span className="text-xs font-mono text-white/40">
                  match {(m.score * 100).toFixed(0)}%
                </span>
              </div>
              <p className="text-xs text-white/40 leading-snug">{m.description}</p>
              <p className="text-[10px] text-white/30 italic">{m.reason}</p>
            </button>
          ))}
        </div>
      )}
    </GlassPanel>
  );
}
