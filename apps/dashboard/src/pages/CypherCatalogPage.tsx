import React from "react";
import { GlassPanel, EmptyState, LoadingShell } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { CypherServiceTile } from "../components/CypherServiceTile.js";
import type { CypherFederationService } from "../lib/cypher-catalog-types.js";

/**
 * CypherCatalogPage — mirrors the Cypher Bio federation services catalog.
 *
 * Endpoint: GET https://cypherbio.ai/backend/api/federation/services/public
 * (no auth required — see ai/.cache/cypherbio/CYPHER-API-NOTES.md "Public endpoints").
 *
 * CORS NOTE
 * ---------
 * Calling cypherbio.ai directly from a browser hosted on capability.network or
 * localhost:5173 is likely to fail CORS preflight (cypherbio.ai's CDN does not
 * advertise our origins). Two paths:
 *
 *   1. PRODUCTION: route through the PCC gateway proxy at
 *      /api/proxy/cypher/federation-catalog. That proxy is NOT yet implemented
 *      (Track A / @pcc/cypher-federation will deliver it). When live, this
 *      page should switch to that URL.
 *
 *   2. LOCAL DEV: add the upstream to apps/dashboard/vite.config.ts proxy:
 *
 *        "/api/proxy/cypher": {
 *          target: "https://cypherbio.ai/backend",
 *          changeOrigin: true,
 *          rewrite: (p) => p.replace(/^\/api\/proxy\/cypher/, ""),
 *        }
 *
 * Until either path lands, this page tries the direct URL and falls back to
 * an error state. That keeps the integration honest about its real wiring.
 */
const CYPHER_FEDERATION_PUBLIC_URL =
  "https://cypherbio.ai/backend/api/federation/services/public";

interface FederationListResponse {
  services?: CypherFederationService[];
  data?: CypherFederationService[];
}

/**
 * Pull the services array out of whatever shape the federation endpoint
 * returns. Cypher's bundle suggests three plausible shapes (bare array,
 * `{services}`, or `{data}`) — accept any.
 *
 * Exported so tests can exercise it without a DOM.
 */
export function extractServices(payload: unknown): CypherFederationService[] {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload)) return payload as CypherFederationService[];
  const obj = payload as FederationListResponse;
  if (Array.isArray(obj.services)) return obj.services;
  if (Array.isArray(obj.data)) return obj.data;
  return [];
}

export function CypherCatalogPage(): React.ReactElement {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [services, setServices] = React.useState<CypherFederationService[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setPageMeta(
      "Cypher Bio Catalog",
      "Federated lab services available through the Cypher Bio network",
    );
  }, [setPageMeta]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setServices(null);

    fetch(CYPHER_FEDERATION_PUBLIC_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((payload) => {
        if (cancelled) return;
        setServices(extractServices(payload));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to load catalog";
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        <CatalogHeader />
        <LoadingShell rows={3} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <CatalogHeader />
        <GlassPanel padding="md" data-testid="cypher-catalog-error">
          <div className="space-y-2">
            <div className="text-sm text-red-300/85 font-medium">
              Could not load Cypher Bio catalog
            </div>
            <div className="text-xs text-white/50 font-mono break-all">{error}</div>
            <div className="text-[11px] text-white/40 leading-relaxed">
              This is likely a CORS preflight failure. The Cypher Bio public
              federation endpoint at{" "}
              <code className="text-white/60">{CYPHER_FEDERATION_PUBLIC_URL}</code>{" "}
              does not advertise capability.network or localhost as allowed
              origins. The production fix is the gateway proxy at{" "}
              <code className="text-white/60">/api/proxy/cypher/federation-catalog</code>{" "}
              (delivered by Track A / @pcc/cypher-federation). For local dev,
              add a vite proxy entry — see comments in CypherCatalogPage.tsx.
            </div>
          </div>
        </GlassPanel>
      </div>
    );
  }

  if (!services || services.length === 0) {
    return (
      <div className="space-y-4">
        <CatalogHeader />
        <GlassPanel padding="lg" data-testid="cypher-catalog-empty">
          <EmptyState
            title="No services published"
            description="No providers have published services to the Cypher Bio federation catalog yet. Check back later."
          />
        </GlassPanel>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="cypher-catalog-page">
      <CatalogHeader count={services.length} />
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {services.map((s) => (
          <CypherServiceTile key={s._id} service={s} />
        ))}
      </div>
    </div>
  );
}

function CatalogHeader({ count }: { count?: number }): React.ReactElement {
  return (
    <GlassPanel padding="md">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-white/85">
            Cypher Bio federation catalog
          </div>
          <div className="text-[11px] text-white/40">
            Published lab services from the Cypher Bio network · public catalog
            (no auth)
          </div>
        </div>
        {count != null && (
          <div className="text-[10px] text-white/50">
            <span className="text-white/85 font-mono">{count}</span> services
          </div>
        )}
      </div>
    </GlassPanel>
  );
}

export default CypherCatalogPage;
