import React from "react";
import { GlassPanel, GlowBadge } from "@pcc/ui";
import type { CypherFederationService } from "../lib/cypher-catalog-types.js";

/**
 * A tile for a single Cypher Bio federation service. Matches the dashboard's
 * GlassPanel + GlowBadge styling (no new design-system deps introduced).
 *
 * Layout:
 *   [logo? + provider name + slug pill]
 *   [service name (lg)]
 *   [description]
 *   [pricing | turnaround | category | publishedAt]
 *   [stats: totalOrders / completedOrders / reviewCount]
 *   [<expandable> order form schema preview + terms link]
 */
export interface CypherServiceTileProps {
  service: CypherFederationService;
}

function formatTurnaround(t: CypherFederationService["estimatedTurnaround"]): string {
  if (!t) return "—";
  const unit = t.unit ?? "";
  if (t.min != null && t.max != null) return `${t.min}-${t.max} ${unit}`.trim();
  if (t.min != null) return `${t.min}+ ${unit}`.trim();
  if (t.max != null) return `up to ${t.max} ${unit}`.trim();
  return unit || "—";
}

function formatPricing(p: CypherFederationService["pricing"]): string {
  if (!p) return "—";
  if (p.priceDescription) return p.priceDescription;
  if (p.pricingModel === "quote") return "Quote on request";
  if (p.basePrice != null) {
    const cur = p.currency ?? "USD";
    return `${cur} ${p.basePrice.toLocaleString()}`;
  }
  return p.pricingModel ?? "—";
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

export function CypherServiceTile({ service }: CypherServiceTileProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);

  const provider = service.provider ?? { name: "Unknown provider" };
  const pricingLabel = formatPricing(service.pricing);
  const turnaroundLabel = formatTurnaround(service.estimatedTurnaround);
  const stats = service.stats ?? {};
  const category = service.category ?? "uncategorized";
  const orderSchemaJson = React.useMemo(() => {
    if (!service.orderFormSchema) return null;
    try {
      return JSON.stringify(service.orderFormSchema, null, 2);
    } catch {
      return null;
    }
  }, [service.orderFormSchema]);

  return (
    <GlassPanel
      padding="md"
      className="space-y-3"
      data-testid="cypher-service-tile"
    >
      {/* Provider strip */}
      <div className="flex items-center gap-3">
        {provider.logo ? (
          // S3 presigned URL — may expire, hide on error
          <img
            src={provider.logo}
            alt={`${provider.name} logo`}
            className="w-8 h-8 rounded object-cover bg-white/[0.04] border border-white/[0.08]"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <div className="w-8 h-8 rounded bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-[10px] text-white/30 uppercase">
            {provider.name?.slice(0, 2) ?? "??"}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-white/85 truncate">
            {provider.name}
          </div>
          {provider.slug && (
            <div className="text-[10px] text-white/30 font-mono truncate">
              {provider.slug}
            </div>
          )}
        </div>
        <GlowBadge color="cyan">{category}</GlowBadge>
      </div>

      {/* Service name + description */}
      <div>
        <div className="text-base font-semibold text-white/90">
          {service.name}
        </div>
        {service.description && (
          <div className="text-xs text-white/55 mt-1 leading-relaxed">
            {service.description}
          </div>
        )}
      </div>

      {/* Meta strip: pricing | turnaround | published */}
      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <div className="text-white/30 uppercase tracking-wider mb-0.5">
            Pricing
          </div>
          <div className="text-emerald-300/80 font-medium truncate">
            {pricingLabel}
          </div>
        </div>
        <div>
          <div className="text-white/30 uppercase tracking-wider mb-0.5">
            Turnaround
          </div>
          <div className="text-white/75 font-medium truncate">
            {turnaroundLabel}
          </div>
        </div>
        <div>
          <div className="text-white/30 uppercase tracking-wider mb-0.5">
            Published
          </div>
          <div className="text-white/75 font-mono truncate">
            {formatDate(service.publishedAt)}
          </div>
        </div>
      </div>

      {/* Stats row */}
      {(stats.totalOrders != null || stats.completedOrders != null || stats.reviewCount != null) && (
        <div className="flex gap-4 text-[10px] text-white/50 pt-1 border-t border-white/[0.06]">
          {stats.totalOrders != null && (
            <span>
              <span className="text-white/30">orders</span>{" "}
              <span className="text-white/80 font-mono">{stats.totalOrders}</span>
            </span>
          )}
          {stats.completedOrders != null && (
            <span>
              <span className="text-white/30">completed</span>{" "}
              <span className="text-white/80 font-mono">{stats.completedOrders}</span>
            </span>
          )}
          {stats.reviewCount != null && (
            <span>
              <span className="text-white/30">reviews</span>{" "}
              <span className="text-white/80 font-mono">{stats.reviewCount}</span>
            </span>
          )}
        </div>
      )}

      {/* Expand: order form schema + T&C link */}
      <div className="pt-2 border-t border-white/[0.06] space-y-2">
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          className="text-[10px] text-cyan-300/70 hover:text-cyan-200 transition-colors"
          data-testid="cypher-service-tile-toggle"
        >
          {expanded ? "Hide" : "View"} order form
        </button>
        {expanded && (
          <div className="space-y-2">
            {orderSchemaJson ? (
              <pre className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3 text-[10px] font-mono text-white/55 whitespace-pre-wrap leading-relaxed max-h-64 overflow-auto">
                {orderSchemaJson}
              </pre>
            ) : (
              <div className="text-[11px] text-white/30 italic">
                No order form schema available.
              </div>
            )}
            {service.termsAndConditionsUrl && (
              <a
                href={service.termsAndConditionsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-block text-[10px] text-sky-300/80 hover:text-sky-200 underline"
              >
                Terms & Conditions ↗
              </a>
            )}
          </div>
        )}
      </div>
    </GlassPanel>
  );
}

export default CypherServiceTile;
