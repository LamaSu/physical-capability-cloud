/**
 * Agent introspection — the two calls that make PCC navigable to a stranger's agent.
 *
 *   GET /api/agent/capabilities   what can THIS key reach, and which scope is missing
 *   GET /api/agent/me             one call: where does this operator stand
 *
 * WHY THESE EXIST
 *
 * PCC publishes 706 paths. An agent arriving with a key today discovers its own
 * permissions by collecting 403s, and discovers its own state by walking a dozen
 * routes. Both are read-only reflections of state the gateway already holds, so
 * neither is new capability — they are the platform describing its own shape.
 *
 * The pattern is borrowed openly from Immersive Commons, whose `ic_capabilities`
 * marks every tool `reachable` or `needs_scope:<name>`, and whose `ic_hack_me`
 * is documented as "the one call that answers where do I stand". Those two calls
 * are the reason an agent can operate on that platform without a human
 * explaining anything. This is the same idea pointed at physical capability.
 *
 * DESIGN NOTE, and it is the load-bearing one: an agent-native platform does not
 * just expose actions, it exposes its own REFUSALS. Telling an agent "no" by
 * failing a request is not an interface. `needs_scope:operator.write` is.
 *
 * These endpoints are also the honest precondition for narrowing API-key scopes.
 * Today `provisionApiKey` hands out `scopes: ["*"]` (routes/provision.ts) and
 * nothing enforces it, so a narrow key would simply break callers with no way to
 * discover why. Once a key can ask what it may do, it can safely be given less.
 *
 * Read-only. No settlement path. No writes.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

import { resolveApiKey } from "../auth/api-key-auth.js";
import { getRepos } from "../db.js";

// ── Scope registry ──────────────────────────────────────────────────
//
// The declarative map of operation -> required scope. This is deliberately a
// plain table rather than decoration scattered across route files: an agent
// asking "what may I do" needs ONE authority to read, and a reviewer asking
// "what does this key imply" needs one place to look.
//
// Adding a route here does not enforce anything on its own — enforcement is a
// separate change, on purpose. This ships the honest map first so that
// narrowing scopes later is a policy decision rather than a guessing game.

export interface AgentOperation {
  /** Stable id an agent can plan against; not the URL, which may version. */
  id: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  /** null = open to any authenticated key. */
  scope: string | null;
  /** Money, irreversible, or outward-facing. Surfaced so an agent can ask first. */
  consequential?: boolean;
}

export const AGENT_OPERATIONS: AgentOperation[] = [
  // Discovery — the open tier. An agent should be able to look before it commits.
  { id: "capabilities.search", method: "GET", path: "/api/capabilities/search", summary: "Search the live capability registry", scope: null },
  { id: "capabilities.types", method: "GET", path: "/api/capabilities/types", summary: "List capability types", scope: null },
  { id: "capabilities.get", method: "GET", path: "/api/capabilities/{capId}", summary: "Read one capability", scope: null },
  { id: "capabilities.templates", method: "GET", path: "/api/capabilities/templates", summary: "Onboarding templates for a new operator", scope: null },

  // Requests — describe a job, get a costed DAG back.
  { id: "requests.create", method: "POST", path: "/api/requests", summary: "Decompose a natural-language job into a costed capability DAG", scope: "requests.write" },
  { id: "requests.get", method: "GET", path: "/api/requests/{id}", summary: "Read a request and its DAG", scope: "requests.read" },

  // Jobs — the thing an operator actually runs.
  { id: "jobs.list", method: "GET", path: "/api/jobs", summary: "List jobs visible to this key", scope: "jobs.read" },
  { id: "jobs.status", method: "GET", path: "/api/jobs/{jobId}/status", summary: "Job status", scope: "jobs.read" },
  { id: "jobs.accept", method: "POST", path: "/api/jobs/{jobId}/accept", summary: "Accept an offered job", scope: "jobs.write", consequential: true },

  // Operator — machines and standing.
  { id: "operator.machines", method: "GET", path: "/api/operator/machines", summary: "Machines this operator has onboarded", scope: "operator.read" },
  { id: "operator.earnings", method: "GET", path: "/api/operator/earnings", summary: "Earnings and what is owed", scope: "operator.read" },
  { id: "operator.certifications", method: "GET", path: "/api/operator/certifications", summary: "Certifications held", scope: "operator.read" },
  { id: "operator.maintenance", method: "GET", path: "/api/operator/maintenance", summary: "Maintenance windows", scope: "operator.read" },
  { id: "operator.emergencyStop", method: "POST", path: "/api/operator/emergency-stop", summary: "Halt this operator's machines", scope: "operator.write", consequential: true },

  // Settlement — money. Always consequential, always separately scoped.
  { id: "settlement.escrow.read", method: "GET", path: "/api/escrow/{unitId}", summary: "Read an escrow unit", scope: "settlement.read" },
  { id: "settlement.quote", method: "POST", path: "/api/quotes", summary: "Price a capability contract", scope: "settlement.read" },

  // Evidence.
  { id: "evidence.verify", method: "POST", path: "/a2a/tasks/send", summary: "Verify execution evidence (A2A skill verify_evidence)", scope: "evidence.read" },

  // Introspection — never gated. A key must always be able to ask what it is.
  { id: "agent.capabilities", method: "GET", path: "/api/agent/capabilities", summary: "What this key can reach", scope: null },
  { id: "agent.me", method: "GET", path: "/api/agent/me", summary: "Where this operator stands", scope: null },
];

/**
 * Does `held` satisfy `required`?
 *
 * `*` is the wildcard every key currently carries. It is honoured here so this
 * endpoint reports the truth about today's keys rather than an aspiration —
 * but `wildcard: true` is reported alongside, because a key that can do
 * everything is a finding, not a feature.
 */
export function scopeSatisfied(held: string[], required: string | null): boolean {
  if (required === null) return true;
  if (held.includes("*")) return true;
  if (held.includes(required)) return true;
  // `operator.*` satisfies `operator.read`.
  const family = required.split(".")[0];
  return held.includes(`${family}.*`);
}

function heldScopes(record: { scopes?: string | null }): string[] {
  try {
    const parsed = JSON.parse(record.scopes ?? "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function unauthenticated(reply: import("fastify").FastifyReply) {
  // Deliberately explicit: an agent that cannot read this response cannot
  // recover. Name the header, the prefix, and where a key comes from.
  return reply.status(401).send({
    ok: false,
    error_kind: "no_token",
    message:
      "Send Authorization: Bearer pcc_live_<key> (or pcc_test_). " +
      "Provision one at POST /api/auth/provision.",
  });
}

/**
 * Minimal structural row shapes for the repo reads below.
 *
 * The repository methods return loosely-typed rows here, so the callbacks would
 * otherwise be implicit `any` and fail `noImplicitAny`. Declaring exactly the
 * fields these handlers read is better than widening to `any`: it documents the
 * contract, and it breaks loudly if a column is renamed underneath us.
 */
interface KernelRow {
  id: string;
  name?: string;
  status?: string;
  operatorAddress?: string;
  lastHeartbeat?: string | null;
}
interface JobRow {
  id: string;
  kernelId?: string;
  status?: unknown;
  progress?: number | null;
}
interface KeyRow {
  scopes?: string | null;
}

export async function agentIntrospectionRoutes(app: FastifyInstance) {
  // ── GET /api/agent/capabilities ────────────────────────────────────
  app.get("/api/agent/capabilities", async (req: FastifyRequest, reply) => {
    const key = resolveApiKey(req);
    if (!key) return unauthenticated(reply);

    const held = heldScopes(key);
    const wildcard = held.includes("*");

    const tools = AGENT_OPERATIONS.map((op) => ({
      id: op.id,
      method: op.method,
      path: op.path,
      summary: op.summary,
      required_scope: op.scope,
      consequential: op.consequential === true,
      // The whole point of the endpoint: never just "no".
      reachability: scopeSatisfied(held, op.scope)
        ? "reachable"
        : `needs_scope:${op.scope}`,
    }));

    return reply.send({
      ok: true,
      count: tools.length,
      caller: {
        key_id: key.id,
        operator: key.operatorId,
        scopes: held,
        // Say the quiet part in the response rather than in a changelog.
        wildcard,
        wildcard_note: wildcard
          ? "This key holds ['*'] and can reach every operation. Scopes are recorded but not yet enforced; narrow keys become meaningful once they are."
          : undefined,
      },
      tools,
    });
  });

  // ── GET /api/agent/me ──────────────────────────────────────────────
  app.get("/api/agent/me", async (req: FastifyRequest, reply) => {
    const key = resolveApiKey(req);
    if (!key) return unauthenticated(reply);

    const repos = getRepos();
    const operatorId = key.operatorId;

    // Each block degrades to null with a stated reason rather than 500-ing the
    // whole answer. An agent asking "where do I stand" during a partial outage
    // still gets the knowable parts, and is told which parts are not.
    const section = <T>(fn: () => T): { value: T | null; error?: string } => {
      try {
        return { value: fn() };
      } catch (e) {
        return { value: null, error: (e as Error).message.slice(0, 120) };
      }
    };

    // Kernels are PCC's physical sites, and a kernel's operatorAddress is the
    // operator. There is no findByOperator on IKernelRepository, so this filters
    // findAll — correct, and worth replacing with an indexed lookup if the
    // kernel table ever grows past a few thousand rows.
    const kernels = section(() =>
      repos.kernels
        .findAll()
        .filter((k: KernelRow) => k.operatorAddress === operatorId),
    );

    const kernelIds = (kernels.value ?? []).map((k: KernelRow) => k.id);

    const jobs = section(() =>
      kernelIds.flatMap((id: string) => repos.jobs.findByKernel(id)),
    );

    const keys = section(() => repos.apiKeys.findByOperator(operatorId));

    const LIVE = ["pending", "queued", "in_progress", "paused"];
    const inFlight = (jobs.value ?? []).filter((j: JobRow) =>
      LIVE.includes(String(j.status)),
    );

    const devices = section(() =>
      kernelIds.flatMap((id: string) => repos.kernels.findDevicesByKernel(id)),
    );

    return reply.send({
      ok: true,
      as_of: new Date().toISOString(),
      identity: {
        operator: operatorId,
        key_id: key.id,
        key_name: key.name ?? null,
        scopes: heldScopes(key),
      },
      kernels: {
        count: kernels.value?.length ?? null,
        items: (kernels.value ?? []).map((k: KernelRow) => ({
          id: k.id,
          name: k.name,
          status: k.status,
          last_heartbeat: k.lastHeartbeat ?? null,
        })),
        unavailable: kernels.error,
      },
      devices: {
        count: devices.value?.length ?? null,
        unavailable: devices.error,
      },
      work: {
        in_flight: inFlight.length,
        items: inFlight.map((j: JobRow) => ({
          id: j.id,
          kernel_id: j.kernelId,
          status: j.status,
          progress: j.progress ?? null,
        })),
        unavailable: jobs.error,
      },
      keys: {
        // A stale or over-scoped key is something an operator should be able to
        // notice without opening a dashboard.
        active: keys.value?.length ?? null,
        wildcard_keys: (keys.value ?? []).filter((k: KeyRow) =>
          heldScopes(k).includes("*"),
        ).length,
        unavailable: keys.error,
      },
      // The point of a "where do I stand" call is that it tells you what to do
      // next, not just what is true.
      next: [
        (kernels.value?.length ?? 0) === 0
          ? "No kernels registered. POST /api/kernels to register a site, then /api/setup/register-device."
          : null,
        (devices.value?.length ?? 0) === 0 && (kernels.value?.length ?? 0) > 0
          ? "Kernel registered but no devices. POST /api/setup/register-device."
          : null,
        inFlight.length > 0
          ? `${inFlight.length} job(s) in flight — GET /api/jobs/{jobId} for detail.`
          : null,
      ].filter(Boolean),
    });
  });
}
