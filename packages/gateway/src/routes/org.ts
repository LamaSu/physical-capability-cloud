/**
 * Org coordination routes — HTTP mount for `@pcc/coordination`'s three
 * integration contracts (ai/research/unified-control-plane/UI-COORDINATION.md
 * §9.1-9.2), so the control-plane's Approvals inbox + Activity feed have a
 * live backend to call.
 *
 *   GET  /org/approvals?status=&persona=   -> listApprovals()
 *   POST /org/approvals/:id/resolve        -> resolveApproval()
 *   GET  /org/watch                        -> SSE stream of org.* events
 *
 * Additive-only: this file only adds new routes under /org/*; it does not
 * modify any other route file. All business logic (the durable queue, the
 * org.* bus) lives in @pcc/coordination — this module is a thin HTTP
 * adapter, the same shape every other file in routes/*.ts already takes
 * (wrap a facade/service, translate to HTTP, no logic of its own).
 *
 * Frame factory seam (contract (b)): `watchOrgEvents`'s default
 * `stubFrameFactory` produces dependency-free, "valid-enough" AG-UI frames
 * (see @pcc/coordination's src/events/org-watch.ts docblock). The harness's
 * real AG-UI frame factories live at
 * `~/.claude/lib/genui/{agui-events.js,agui-job.js}` — an absolute path on
 * the local Claude Code install, OUTSIDE this repository and outside the
 * pnpm workspace entirely. Importing it here would make @pcc/gateway
 * unbuildable/untestable/undeployable anywhere but this one machine, which
 * is exactly the coupling @pcc/coordination's own org-watch.ts already
 * refuses to introduce. So this route also does NOT import that path;
 * it uses the stub factory and leaves the seam documented (below, at
 * `realFrameFactory`) for a deployment that has the harness factories
 * available to wire in with zero changes to @pcc/coordination itself.
 *
 * Auth: intentionally open (no operatorId gate) in this additive vertical
 * slice — documented as a known gap, same "documented, not silent" practice
 * @pcc/coordination's own README uses for its own scope decisions. Wiring
 * this to the control-plane's auth model is a follow-up once that model
 * exists on the consuming side.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  HumanQueueStore,
  OrgBus,
  listApprovals,
  resolveApproval,
  watchOrgEvents,
  type AguiFrame,
  type OrgWatchFrameFactory,
  type OrgApprovalStatus,
  type OrgPersona,
} from "@pcc/coordination";
import { canOpenSSE, trackSSEOpen, trackSSEClose } from "../middleware/security-hardening.js";

// ── Lazy singletons ──────────────────────────────────────────────────────
//
// Same pattern as workflow-store.ts / db.ts: one shared instance per
// process, created on first use, path resolved from an env var with a
// local-dev-friendly default (mirrors @pcc/coordination's own README
// usage example, which suggests COORDINATION_DB_PATH).

let _queue: HumanQueueStore | undefined;
function getQueue(): HumanQueueStore {
  if (!_queue) {
    const path = process.env.COORDINATION_DB_PATH ?? "./data/coordination-brain.sqlite";
    if (path !== ":memory:") {
      try {
        mkdirSync(dirname(path), { recursive: true });
      } catch {
        // directory may already exist — fine to ignore
      }
    }
    _queue = new HumanQueueStore({ path });
  }
  return _queue;
}

let _bus: OrgBus | undefined;
function getBus(): OrgBus {
  // `new OrgBus()` with no backend defers to @pcc/a2a's createBackendFromEnv()
  // — in-memory unless PCC_MESSAGE_BUS_BACKEND=nats, same convention the rest
  // of the coordination package already follows.
  if (!_bus) _bus = new OrgBus();
  return _bus;
}

/**
 * Seam for a real deployment: swap in the harness's actual AG-UI frame
 * factories without touching @pcc/coordination. Left unused by default
 * (returns undefined -> watchOrgEvents falls back to stubFrameFactory).
 * A consumer that has `~/.claude/lib/genui/contracts.js` on its filesystem
 * wires it in like:
 *
 *   import { factories } from "<absolute-path>/lib/genui/contracts.js";
 *   const frameFactory: OrgWatchFrameFactory = {
 *     stateSnapshot: (s) => factories.ev("STATE_SNAPSHOT", { snapshot: s }),
 *     stateDelta:    (d) => factories.ev("STATE_DELTA", { delta: d }),
 *     custom:        (name, payload) => factories.ev("CUSTOM", { name, value: payload }),
 *   };
 */
function realFrameFactory(): OrgWatchFrameFactory | undefined {
  return undefined;
}

// ── Test-support only (not part of the HTTP contract) ───────────────────
//
// Mirrors the `_resetAnthropicCache`-style export this codebase already uses
// (services/commentary-narrator.ts + its test) for reaching otherwise-
// private lazy-singleton state from a test file.

/** Same HumanQueueStore instance the routes above read/write through, so a
 *  test can enqueue()/inspect it directly. */
export function _getQueueForTesting(): HumanQueueStore {
  return getQueue();
}

/** Same OrgBus instance /org/watch subscribes through. A bus built with a
 *  bare `new OrgBus()` in a test would NOT see this one's events —
 *  @pcc/a2a's createBackendFromEnv() returns a brand-new InMemoryBackend on
 *  every call — so publishing a real org.* event for a watch test has to go
 *  through this exact instance. */
export function _getBusForTesting(): OrgBus {
  return getBus();
}

/** Closes and clears both lazy singletons so the next getQueue()/getBus()
 *  call re-reads env vars (e.g. a fresh COORDINATION_DB_PATH per test file)
 *  and starts clean. Call from beforeEach/afterAll. */
export async function _resetOrgSingletonsForTesting(): Promise<void> {
  _queue?.close();
  _queue = undefined;
  if (_bus) {
    await _bus.close();
    _bus = undefined;
  }
}

const VALID_STATUSES = new Set<OrgApprovalStatus>(["pending", "approved", "rejected", "resolved", "expired"]);
const VALID_PERSONAS = new Set<OrgPersona>(["user", "operator", "orchestrator"]);

export async function orgRoutes(app: FastifyInstance) {
  // ── GET /org/approvals?status=&persona= ─────────────────────────────────

  app.get<{ Querystring: { status?: string; persona?: string } }>(
    "/org/approvals",
    async (req, reply) => {
      const { status, persona } = req.query ?? {};
      if (status && !VALID_STATUSES.has(status as OrgApprovalStatus)) {
        return reply.status(400).send({
          error: "invalid_status",
          message: `status must be one of: ${[...VALID_STATUSES].join(", ")}`,
        });
      }
      if (persona && !VALID_PERSONAS.has(persona as OrgPersona)) {
        return reply.status(400).send({
          error: "invalid_persona",
          message: `persona must be one of: ${[...VALID_PERSONAS].join(", ")}`,
        });
      }

      const items = listApprovals(getQueue(), {
        ...(status ? { status: status as OrgApprovalStatus } : {}),
        ...(persona ? { persona: persona as OrgPersona } : {}),
      });
      return { approvals: items, count: items.length };
    },
  );

  // ── POST /org/approvals/:id/resolve ─────────────────────────────────────

  app.post<{
    Params: { id: string };
    Body: { approved?: boolean; editedArgs?: Record<string, unknown>; resolvedBy?: string };
  }>("/org/approvals/:id/resolve", async (req, reply) => {
    const { id } = req.params;
    const body = req.body ?? {};

    if (typeof body.approved !== "boolean") {
      return reply.status(400).send({ error: "approved_required", message: "body.approved must be a boolean" });
    }
    if (!body.resolvedBy || typeof body.resolvedBy !== "string") {
      return reply.status(400).send({ error: "resolvedBy_required", message: "body.resolvedBy must be a non-empty string" });
    }

    try {
      const resolved = resolveApproval(getQueue(), id, {
        approved: body.approved,
        resolvedBy: body.resolvedBy,
        ...(body.editedArgs !== undefined ? { editedArgs: body.editedArgs } : {}),
      });
      return { approval: resolved };
    } catch (err) {
      // HumanQueueStore throws a plain Error("...item <id> not found") for an
      // unknown id (see mustUpdate in queue/human-queue.ts) — the only
      // failure mode resolveApproval's underlying calls raise.
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(404).send({ error: "approval_not_found", message });
    }
  });

  // ── GET /org/watch  (SSE) ────────────────────────────────────────────────

  app.get("/org/watch", async (req, reply) => {
    if (!canOpenSSE(req.ip)) {
      return reply.status(429).send({ error: "too_many_connections", message: "SSE connection limit exceeded" });
    }
    trackSSEOpen(req.ip);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering
    });

    reply.raw.write(`: org watch stream\n\n`);
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ type: "connected", ts: new Date().toISOString() })}\n\n`);

    const writeFrame = (frame: AguiFrame): void => {
      try {
        reply.raw.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
      } catch {
        // connection already gone; req.raw's "close" handler below does cleanup
      }
    };

    const frameFactoryOpts = realFrameFactory();
    const unsubscribe = await watchOrgEvents(getBus(), writeFrame, {
      ...(frameFactoryOpts ? { frameFactory: frameFactoryOpts } : {}),
    });

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": ka\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      trackSSEClose(req.ip);
      void unsubscribe();
    });

    // Hold the connection open — Fastify's reply stream stays alive as long
    // as we don't return/resolve.
    await new Promise<void>(() => {});
  });
}
