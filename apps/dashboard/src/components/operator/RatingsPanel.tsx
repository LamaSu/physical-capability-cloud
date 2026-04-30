import React, { useEffect, useState } from "react";
import { GlassPanel } from "@pcc/ui";

const API_ROOT = (import.meta.env.VITE_PCC_URL ?? "");

interface RatingRow {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: string;
}

interface RatingsResponse {
  operatorId: string;
  avg: number;
  count: number;
  distribution: { 1: number; 2: number; 3: number; 4: number; 5: number };
  recent: RatingRow[];
}

/**
 * T2.7 — ratings display widget.
 * Public read of GET /api/operators/:id/ratings (apiGate opts out via the
 * PUBLIC_OPERATOR_RATINGS_RE regex). No auth required — reputation is
 * a buyer-facing signal.
 */
export function RatingsPanel({ operatorId }: { operatorId: string }) {
  const [data, setData] = useState<RatingsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_ROOT}/api/operators/${encodeURIComponent(operatorId)}/ratings`);
        if (!res.ok) return;
        const json = (await res.json()) as RatingsResponse;
        if (!cancelled) setData(json);
      } catch {
        // silent
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [operatorId]);

  if (!data) return null;

  const maxBar = Math.max(1, ...Object.values(data.distribution));

  return (
    <GlassPanel padding="md" className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/30">Buyer Ratings</span>
        <span className="text-xs text-white/40 font-mono">{data.count} total</span>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold text-green-400/80">
          {data.avg > 0 ? data.avg.toFixed(2) : "—"}
        </span>
        <span className="text-[10px] text-white/30">/ 5.0</span>
      </div>

      {data.count > 0 && (
        <div className="space-y-1">
          {([5, 4, 3, 2, 1] as const).map((bucket) => {
            const n = data.distribution[bucket];
            return (
              <div key={bucket} className="flex items-center gap-2 text-[11px]">
                <span className="text-white/40 w-3 font-mono">{bucket}</span>
                <div className="flex-1 h-1.5 bg-white/[0.04] rounded overflow-hidden">
                  <div
                    className="h-full bg-green-400/40"
                    style={{ width: `${(n / maxBar) * 100}%` }}
                  />
                </div>
                <span className="text-white/30 w-6 text-right font-mono">{n}</span>
              </div>
            );
          })}
        </div>
      )}

      {data.recent.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-white/[0.06]">
          <span className="text-[10px] text-white/20">Recent</span>
          {data.recent.slice(0, 4).map((r) => (
            <div key={r.id} className="text-xs">
              <div className="flex items-center justify-between">
                <span className="font-mono text-white/50">
                  {"★".repeat(r.rating)}
                  <span className="text-white/15">{"★".repeat(5 - r.rating)}</span>
                </span>
                <span className="text-[10px] text-white/20">
                  {new Date(r.createdAt).toLocaleDateString()}
                </span>
              </div>
              {r.comment && (
                <p className="text-white/50 mt-0.5 leading-snug">{r.comment}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </GlassPanel>
  );
}
