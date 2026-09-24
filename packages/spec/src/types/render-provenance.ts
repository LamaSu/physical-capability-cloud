/**
 * Render-state provenance: the authority class of every datum a PCC surface renders
 * (product pack section 2, UX reconciliation P0-UX-4).
 *
 *   A  authoritative  protocol / execution truth, from a whitelisted server read model
 *   B  accepted       an accepted deal / contract / plan, from the accepted-plan read model
 *   C  proposed       agent-generated or predicted content (manifest prose, plans, ETAs)
 *   D  preference     durable user presentation choices (layout, order, visibility)
 *   E  ephemeral      local UI state (hover, open panel), never persisted, never data
 *
 * THE RULE: the class is ASSIGNED BY THE TRUSTED SOURCE, never chosen by a manifest or
 * by generated content. The closed render IR derives it from the node's structure and the
 * server-owned bind registry (packages/gateway/src/mcp/dashboard-ir.ts `sourceClassOf`):
 * manifest prose is always `proposed`; bound data takes the class its route is registered
 * with; nothing a manifest can write selects it. Presentation (D/E) can never occupy an
 * A/B slot, so customization cannot mutate truth.
 *
 * CONTRACT FOR READ-MODEL OWNERS (readmodels, composition, vcr): return `asOf` (ISO-8601
 * UTC, the moment the SOURCE observed the state) on every read model, and register the
 * route in the IR bind registry with its class, schema id and freshness budget. `asOf`
 * powers the stale marker and the no-regression guarantee: an update carrying an OLDER
 * `asOf` never overwrites a newer one (reconnect / out-of-order safety). Without `asOf`
 * the renderer can only order by arrival time.
 *
 * Types only: no runtime, safe to import anywhere (including browser bundles).
 */

/** Authority class of a rendered datum (layers A-E above). */
export type RenderSourceClass = "authoritative" | "accepted" | "proposed" | "preference" | "ephemeral";

/** The classes a server-registered read route may carry: data is A or B, never C/D/E. */
export type BoundSourceClass = Extract<RenderSourceClass, "authoritative" | "accepted">;

/** A rendered datum with its trusted provenance envelope. */
export interface RenderDatum<T = unknown> {
  /** Assigned by the trusted side from the source registry. Never read from a manifest. */
  readonly sourceClass: RenderSourceClass;
  /** Which read-model schema the payload conforms to (e.g. "run-summary-v1"). */
  readonly schemaId: string;
  /** ISO-8601 UTC time the SOURCE observed this state (falls back to receipt time). */
  readonly asOf: string;
  /** True when the data is older than its source's freshness budget, or refresh failed. */
  readonly stale: boolean;
  readonly payload: T;
}

/** What a read model returns so the renderer can mark freshness and refuse regressions. */
export interface ProvenancedReadModel {
  /** ISO-8601 UTC; the source's own observation time. */
  readonly asOf?: string;
}
