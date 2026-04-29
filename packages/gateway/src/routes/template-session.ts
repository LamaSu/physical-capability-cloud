// repair-tier0-routes: generic per-template session driver.
//
// The dashboard's orchestrator chat console (apps/dashboard/src/routes/
// orchestrator/[slug]/chat/index.tsx) drives onboarding via SIX routes that
// the chat panel calls in this exact order:
//
//   POST <prefix>/start                     body: {name, url?}              -> {session_id, state}
//   POST <prefix>/:id/scrape                body: {url}                     -> {ok, scraped: {...}}
//   POST <prefix>/:id/ingest-docs           body: {doc_urls: string[]}      -> {ok, ingested: number}
//   POST <prefix>/:id/build-agent           body: {}                        -> {ok, capabilities: [], publication?}
//   GET  <prefix>/:id/status                                                -> {session_id, state, progress, last_event}
//   GET  <prefix>/:id/live-data                                             -> {session_id, events: [...], updated_at}
//
// Every template (physical-operator, data-product, future ones) speaks the
// same six-route shape. We capture that contract once here and mount it
// twice in server.ts — once with prefix `/api/onboard` for physical-operator,
// once with prefix `/api/orchestrator/data-product` for the data-product
// stub. Future templates plug in by adding a third mount.
//
// Session storage: in-memory `Map<string, TemplateSession>`. Each session
// carries its own event log so /live-data can return the running activity
// trail without an external bus. Wave 4 swaps this for Postgres + the
// pipelineTelemetry topic stream so multi-replica gateways don't lose state
// on restart. Today the gateway runs single-replica on Railway so memory is
// fine.
//
// Design choice — why not reuse @pcc/orchestrator-sdk's startSession / advance
// directly? The SDK's state machine is keyed off discovery-specific states
// (started → data_connected → docs_ingested → interview → capabilities_drafted
// → built) which assume the physical-operator flow. The data-product template
// uses identify → describe → schema → price → publish. They share zero state
// names, so a generic driver needs its own minimal state model. We delegate
// the heavy lifting (extract, publish, mirror, wallet) to the SDK tools when
// the agent factory wires them in.
//
// T1.5 protection: every route in this plugin runs THROUGH apiGate (the
// plugin is registered after apiGate in server.ts, and apiGate uses the
// skip-override symbol so its onRequest hook fires here). All six routes
// require Bearer auth by default.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { auditService } from "../services/audit-service.js";

/**
 * Generic activity event written to a session's log. The chat console reads
 * these via /live-data and renders them in the right-side activity sidebar.
 *
 * Shape mirrors the dashboard's `OnboardEvent` from
 * apps/dashboard/src/components/onboard/activity-feed-logic.ts so the same
 * UI component can render events from either source.
 */
export interface TemplateSessionEvent {
  /** Monotonic UNIX millis. The chat console uses this for ordering + polling
   *  cursor (`?since=<t>`). */
  t: number;
  /** Short event tag, e.g. "session_started", "scrape_kicked_off",
   *  "docs_ingested", "build_complete". */
  type: string;
  /** Human-readable text for the activity feed. */
  message: string;
  /** Optional structured payload (per-event). */
  data?: Record<string, unknown>;
}

/**
 * Generic session record. Each template can store template-specific bits in
 * `extras` (e.g. data-product can park `pricing` and `schema` there) without
 * the driver caring about the shape.
 */
export interface TemplateSession {
  id: string;
  /** Template slug for diagnostics + audit log. */
  template: string;
  /** Display name from the user's first /start call. */
  name: string;
  /** Optional URL the user mentioned when starting (e.g. their company site). */
  url?: string;
  /** Coarse state — same five steps every template moves through. */
  state: "started" | "scraping" | "ingesting" | "building" | "built";
  /** Number of URLs scraped so far. */
  scraped_count: number;
  /** Number of docs ingested so far. */
  ingested_count: number;
  /** Result of the build step, if it ran. */
  publication?: {
    /** Backend handle for the produced operator/data-product. */
    operator_id?: string;
    /** Public discovery URL once registered. */
    discovery_url?: string;
    /** Capability slugs the build produced. */
    capabilities?: string[];
  };
  /** Event log for /live-data. Capped at 200 entries to bound memory. */
  events: TemplateSessionEvent[];
  /** Tenant identity captured when the session was created (for cross-tenant
   *  read prevention in Wave 4). T1.9 plumbing. */
  tenant_id: string | null;
  created_at: number;
  updated_at: number;
}

/** Maximum event log length per session. After this, we drop the oldest. */
const MAX_EVENTS_PER_SESSION = 200;

/**
 * Hook surface every template implements. The driver calls these on the
 * matching route; all four are async to leave room for real network work.
 *
 * `start` runs implicitly inside POST /start (we always create the session
 * record); template hooks here just decorate it with template-specific
 * pre-computation. Returning `false` from `start` means "session creation
 * failed" — the route will respond 422.
 */
export interface TemplateAgentHooks {
  /** Called inside POST /start AFTER the session record is created. May
   *  enrich the session in place (mutate session.extras) or kick off async
   *  work and return immediately. */
  onStart?: (session: TemplateSession) => Promise<void>;
  /** Called inside POST /:id/scrape. Implementations should fetch the URL,
   *  extract structured data, and return a small JSON-serialisable summary
   *  for the chat console. */
  onScrape?: (session: TemplateSession, url: string) => Promise<Record<string, unknown>>;
  /** Called inside POST /:id/ingest-docs. Implementations may queue the
   *  doc URLs for embedding/extraction. The route returns the count
   *  immediately; long-running work goes in the background. */
  onIngestDocs?: (session: TemplateSession, docUrls: string[]) => Promise<void>;
  /** Called inside POST /:id/build-agent. This is the heavy step — typically
   *  publishes the operator, mints a wallet, registers capabilities. Returns
   *  the publication summary that gets stored on the session. */
  onBuild?: (session: TemplateSession) => Promise<{
    capabilities: string[];
    operator_id?: string;
    discovery_url?: string;
  }>;
}

/**
 * Factory that returns the agent hooks for a template. We pass a factory
 * (not a singleton) so each session can hold its own per-session state if
 * the template needs to (e.g. an LLM agent with conversation history).
 *
 * The factory is invoked once on first session creation OR on every call —
 * we go with on-every-call to keep the driver stateless. Implementations
 * that want per-session memory should park it on `session.extras` or in a
 * Map<sessionId, ...> they own.
 */
export type TemplateAgentFactory = () => TemplateAgentHooks;

/** Parameters every mount of the driver needs. */
export interface TemplateSessionRoutesOptions {
  /** Route prefix, e.g. "/api/onboard" or "/api/orchestrator/data-product". */
  prefix: string;
  /** Slug for audit + event tagging, e.g. "physical-operator", "data-product". */
  template: string;
  /** Hook factory — returns the agent that handles the four side-effecting
   *  routes (start/scrape/ingest-docs/build-agent). */
  agentFactory: TemplateAgentFactory;
}

/**
 * In-memory session store. Module-scoped so two mounts of the driver
 * (physical-operator + data-product) share lookup but the keys are random
 * UUIDs so collisions are vanishingly unlikely. Wave 4 replaces this with
 * Postgres.
 *
 * Exposed for tests via the `_resetSessionsForTests` helper.
 */
const sessionStore = new Map<string, TemplateSession>();

/** Test-only — clear the in-memory session store between tests. */
export function _resetSessionsForTests(): void {
  sessionStore.clear();
}

/**
 * Append an event to a session's log and update `updated_at`. Caps the log
 * at MAX_EVENTS_PER_SESSION by dropping the oldest entry.
 */
function appendEvent(session: TemplateSession, event: Omit<TemplateSessionEvent, "t">): void {
  const ev: TemplateSessionEvent = { t: Date.now(), ...event };
  session.events.push(ev);
  if (session.events.length > MAX_EVENTS_PER_SESSION) {
    session.events.shift();
  }
  session.updated_at = ev.t;
}

/** Compute a coarse 0-100 progress percentage for the chat console UI. */
function progressFromState(state: TemplateSession["state"]): number {
  switch (state) {
    case "started":
      return 10;
    case "scraping":
      return 30;
    case "ingesting":
      return 50;
    case "building":
      return 80;
    case "built":
      return 100;
    default:
      return 0;
  }
}

/**
 * Generic Fastify plugin. Mount with a prefix + agent factory; the plugin
 * registers six routes under the prefix.
 *
 * Usage in server.ts:
 *   await app.register(templateSessionRoutes, {
 *     prefix: "/api/onboard",
 *     template: "physical-operator",
 *     agentFactory: physicalOperatorAgent,
 *   });
 *   await app.register(templateSessionRoutes, {
 *     prefix: "/api/orchestrator/data-product",
 *     template: "data-product",
 *     agentFactory: dataProductStubAgent,
 *   });
 *
 * All routes inherit auth from apiGate (which is registered earlier in the
 * plugin chain in server.ts).
 */
export async function templateSessionRoutes(
  app: FastifyInstance,
  opts: TemplateSessionRoutesOptions
): Promise<void> {
  const { prefix, template } = opts;
  // Resolve the agent once per mount. The factory pattern lets templates
  // create per-mount lazy state if needed (e.g. an LLM client) without
  // tying us to a singleton.
  const agent = opts.agentFactory();

  // ── POST <prefix>/start ───────────────────────────────────────────────────
  // Body: { name: string, url?: string }
  // Returns: { session_id: string, state: "started" }
  //
  // Creates a new session and runs the template's onStart hook. The chat
  // console calls this on the very first user turn (the user types their
  // company name + an optional URL). We return immediately; any heavy work
  // belongs in scrape/build, not here.
  app.post<{ Body: { name?: unknown; url?: unknown } }>(
    `${prefix}/start`,
    async (req, reply) => {
      const body = req.body ?? {};
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const url = typeof body.url === "string" ? body.url.trim() : undefined;
      if (!name) {
        return reply.status(400).send({
          error: "name_required",
          message: "POST a JSON body with at least { name: '<your company / data-product name>' }.",
        });
      }

      const sessionId = randomUUID();
      const now = Date.now();
      const session: TemplateSession = {
        id: sessionId,
        template,
        name,
        ...(url ? { url } : {}),
        state: "started",
        scraped_count: 0,
        ingested_count: 0,
        events: [],
        tenant_id: req.tenantId ?? null,
        created_at: now,
        updated_at: now,
      };
      appendEvent(session, {
        type: "session_started",
        message: `Session started for "${name}".${url ? ` Initial URL: ${url}` : ""}`,
        data: { name, ...(url ? { url } : {}) },
      });
      sessionStore.set(sessionId, session);

      // Hook may decorate the session further; failures are non-fatal.
      try {
        await agent.onStart?.(session);
      } catch (err) {
        appendEvent(session, {
          type: "start_hook_error",
          message: `onStart hook reported: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      auditService.log({
        eventType: `${template}.session_started`,
        actor: req.operatorId ?? req.apiKeyId ?? null,
        resourceType: "template_session",
        resourceId: sessionId,
        action: "create",
        metadata: { template, name, url },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });

      return { session_id: sessionId, state: session.state };
    }
  );

  // ── POST <prefix>/:id/scrape ─────────────────────────────────────────────
  // Body: { url: string }
  // Returns: { ok: true, scraped: {...} } where the body of `scraped` is the
  //          template's onScrape hook return value.
  app.post<{ Params: { id: string }; Body: { url?: unknown } }>(
    `${prefix}/:id/scrape`,
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return reply.status(404).send({ error: "session_not_found" });
      const body = req.body ?? {};
      const url = typeof body.url === "string" ? body.url.trim() : "";
      if (!url) {
        return reply.status(400).send({
          error: "url_required",
          message: "POST a JSON body with { url: '<https://...>' }.",
        });
      }

      session.state = "scraping";
      appendEvent(session, {
        type: "scrape_kicked_off",
        message: `Scraping ${url}…`,
        data: { url },
      });

      let scraped: Record<string, unknown> = { ok: true, url };
      try {
        if (agent.onScrape) {
          scraped = (await agent.onScrape(session, url)) ?? scraped;
        }
        session.scraped_count += 1;
        appendEvent(session, {
          type: "scrape_complete",
          message: `Scrape of ${url} complete.`,
          data: { url, summary: summariseForFeed(scraped) },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendEvent(session, {
          type: "scrape_error",
          message: `Scrape of ${url} failed: ${msg}`,
          data: { url, error: msg },
        });
        // The route still returns 200 here — the chat console treats scrape
        // errors as feed entries, not as a request-level failure. This matches
        // the v1 onboarder's behavior where transient scrape failures don't
        // block the rest of the flow.
        scraped = { ok: false, url, error: msg };
      }

      auditService.log({
        eventType: `${template}.scrape`,
        actor: req.operatorId ?? req.apiKeyId ?? null,
        resourceType: "template_session",
        resourceId: session.id,
        action: "scrape",
        metadata: { template, url },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });

      return { ok: true, scraped };
    }
  );

  // ── POST <prefix>/:id/ingest-docs ────────────────────────────────────────
  // Body: { doc_urls: string[] }
  // Returns: { ok: true, ingested: number }
  app.post<{ Params: { id: string }; Body: { doc_urls?: unknown } }>(
    `${prefix}/:id/ingest-docs`,
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return reply.status(404).send({ error: "session_not_found" });
      const body = req.body ?? {};
      const docUrls = Array.isArray(body.doc_urls)
        ? body.doc_urls.filter((u): u is string => typeof u === "string" && u.trim().length > 0)
        : [];
      if (docUrls.length === 0) {
        return reply.status(400).send({
          error: "doc_urls_required",
          message: "POST a JSON body with { doc_urls: ['<url-or-local://name>', ...] }.",
        });
      }

      session.state = "ingesting";
      appendEvent(session, {
        type: "docs_ingest_kicked_off",
        message: `Ingesting ${docUrls.length} doc(s)…`,
        data: { doc_count: docUrls.length },
      });

      try {
        await agent.onIngestDocs?.(session, docUrls);
        session.ingested_count += docUrls.length;
        appendEvent(session, {
          type: "docs_ingested",
          message: `Ingested ${docUrls.length} doc(s).`,
          data: { doc_count: docUrls.length, total_ingested: session.ingested_count },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendEvent(session, {
          type: "docs_ingest_error",
          message: `Doc ingestion failed: ${msg}`,
          data: { doc_count: docUrls.length, error: msg },
        });
      }

      auditService.log({
        eventType: `${template}.ingest_docs`,
        actor: req.operatorId ?? req.apiKeyId ?? null,
        resourceType: "template_session",
        resourceId: session.id,
        action: "ingest_docs",
        metadata: { template, doc_count: docUrls.length },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });

      return { ok: true, ingested: session.ingested_count };
    }
  );

  // ── POST <prefix>/:id/build-agent ────────────────────────────────────────
  // Body: {} (any/empty)
  // Returns: { ok: true, capabilities: string[], publication?: {...} }
  app.post<{ Params: { id: string } }>(
    `${prefix}/:id/build-agent`,
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return reply.status(404).send({ error: "session_not_found" });

      session.state = "building";
      appendEvent(session, {
        type: "build_kicked_off",
        message: "Build started — registering capabilities and publishing.",
      });

      try {
        const result = (await agent.onBuild?.(session)) ?? { capabilities: [] };
        session.publication = {
          ...(result.operator_id ? { operator_id: result.operator_id } : {}),
          ...(result.discovery_url ? { discovery_url: result.discovery_url } : {}),
          capabilities: result.capabilities,
        };
        session.state = "built";
        appendEvent(session, {
          type: "build_complete",
          message: `Built ${result.capabilities.length} capabilit${result.capabilities.length === 1 ? "y" : "ies"}.${result.discovery_url ? ` Live at ${result.discovery_url}.` : ""}`,
          data: {
            capabilities: result.capabilities,
            ...(result.operator_id ? { operator_id: result.operator_id } : {}),
            ...(result.discovery_url ? { discovery_url: result.discovery_url } : {}),
          },
        });

        auditService.log({
          eventType: `${template}.build_complete`,
          actor: req.operatorId ?? req.apiKeyId ?? null,
          resourceType: "template_session",
          resourceId: session.id,
          action: "build",
          metadata: { template, capability_count: result.capabilities.length, discovery_url: result.discovery_url },
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        });

        return {
          ok: true,
          capabilities: result.capabilities,
          publication: session.publication,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Roll back the state so the user can retry. Build is the only step
        // where a failure should NOT advance the state machine — the others
        // are roughly idempotent (you can re-scrape, re-ingest) but a partial
        // build leaves a session in an undefined position.
        session.state = "ingesting";
        appendEvent(session, {
          type: "build_error",
          message: `Build failed: ${msg}`,
          data: { error: msg },
        });
        return reply.status(500).send({
          ok: false,
          error: "build_failed",
          message: msg,
        });
      }
    }
  );

  // ── GET <prefix>/:id/status ──────────────────────────────────────────────
  // Returns: { session_id, state, progress, last_event }
  // Coarse status for the chat header / progress bar. Cheap, polled often.
  app.get<{ Params: { id: string } }>(
    `${prefix}/:id/status`,
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return reply.status(404).send({ error: "session_not_found" });
      const lastEvent = session.events[session.events.length - 1];
      return {
        session_id: session.id,
        template: session.template,
        state: session.state,
        progress: progressFromState(session.state),
        scraped_count: session.scraped_count,
        ingested_count: session.ingested_count,
        last_event: lastEvent ?? null,
        publication: session.publication ?? null,
        updated_at: session.updated_at,
      };
    }
  );

  // ── GET <prefix>/:id/live-data ───────────────────────────────────────────
  // Returns: { session_id, events: [...], updated_at }
  // Fuller event log for the activity-feed sidebar. Supports `?since=<ms>`
  // so the chat console can poll incrementally — same shape as
  // /api/events?since= which the v1 onboarder uses.
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    `${prefix}/:id/live-data`,
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) return reply.status(404).send({ error: "session_not_found" });
      const sinceRaw = req.query?.since;
      const since = sinceRaw ? Number.parseInt(sinceRaw, 10) : 0;
      const events = Number.isFinite(since) && since > 0
        ? session.events.filter((e) => e.t > since)
        : session.events;
      return {
        session_id: session.id,
        template: session.template,
        events,
        updated_at: session.updated_at,
        // Echo the cursor the client should use for the next poll. Avoids
        // chasing rounding errors on the client.
        cursor: session.events.length > 0 ? session.events[session.events.length - 1].t : 0,
      };
    }
  );
}

/**
 * Truncate / shape a hook return value for the activity feed entry. Keeps
 * the feed UI tidy without losing the full payload (which is still in the
 * route response and the audit log).
 */
function summariseForFeed(payload: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string") {
      summary[key] = value.length > 240 ? `${value.slice(0, 237)}…` : value;
    } else if (Array.isArray(value)) {
      summary[key] = `array(${value.length})`;
    } else if (value && typeof value === "object") {
      summary[key] = `object(${Object.keys(value as object).length} keys)`;
    } else {
      summary[key] = value;
    }
  }
  return summary;
}

// Re-export of FastifyRequest type used by the agent factory consumers,
// kept here so factory implementations don't need to import Fastify directly.
export type { FastifyRequest };
