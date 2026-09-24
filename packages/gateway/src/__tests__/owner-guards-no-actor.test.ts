/**
 * Steward rule 7 (WP-C round 4): an owner check fails CLOSED when the actor is
 * missing.
 *
 * Table-driven over EVERY ownership guard WP-C adds or touches, on a BARE app:
 * no apiGate is registered and the requests carry no credentials at all, so
 * nothing upstream can refuse on the handler's behalf. For each route:
 *   - the answer is 401 (403 for POST /api/kernels, whose facade refuses to
 *     update an existing kernel without an actor), never a pass;
 *   - nothing is written (kernel row, capabilities, policy, approvals, devices,
 *     graph nodes and compose candidates are byte-for-byte unchanged);
 *   - no kernel-owner lookup runs (KernelFacade.getById, which
 *     lookupKernelOwner uses), and no kernel row lookup is keyed on a missing
 *     or empty id.
 * A second table sends MALFORMED bodies without an actor: still 401, because
 * the actor is resolved before the body is validated. A positive control sends
 * each well-formed request with the owner's key to the same bare app and gets
 * a 2xx, so the refusals are about the missing actor, not a bad request.
 *
 * finisher-lima2
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { schema, eq } from "@pcc/store";
import { kernelRoutes } from "../routes/kernels.js";
import { capabilityRoutes } from "../routes/capabilities.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { operatorRoutes } from "../routes/operator.js";
import { composeRoutes } from "../routes/compose.js";
import { graphSearchRoutes } from "../routes/graph-search.js";
import { setupRoutes } from "../routes/setup.js";
import {
  kernelMarketplaceRoutes,
  _clearKernelRegistry,
  _setSmokeTestFetch,
} from "../routes/kernel-marketplace.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { KernelFacade } from "../facades/index.js";
import { TRUSTED_KERNEL_FIELDS } from "./fixtures/authorized-kernels.js";

const OWNER = "rule7-owner";
let ownerKey: string;
let bare: FastifyInstance;
const asOwner = () => ({ authorization: `Bearer ${ownerKey}` });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

interface Seed {
  kernelId: string;
  capId: string;
  approvalId: string;
  deviceId: string;
}

/**
 * A kernel owned by OWNER with the maximum ceiling (so any injection would
 * matter), one capability, a policy that is NOT e-stopped, one pending
 * approval and one device.
 */
function seed(): Seed {
  const kernelId = uid("rule7-k");
  const now = new Date().toISOString();
  const repos = getRepos();
  repos.kernels.insert({
    id: kernelId,
    name: `Rule7 ${kernelId}`,
    operatorAddress: OWNER,
    location: { lat: 0, lng: 0 },
    physicalAddress: "",
    maxAssuranceTier: 1,
    publicKey: `0x${"00".repeat(32)}`,
    status: "offline",
    registeredAt: now,
    lastHeartbeat: "2026-01-01T00:00:00.000Z",
    version: "0.1.0",
    ...TRUSTED_KERNEL_FIELDS,
  } as never);
  const capId = `cap-${kernelId}-rule7-scan`;
  repos.capabilities.insert({
    id: capId,
    kernelId,
    type: "rule7-scan",
    name: "rule7 scan",
    description: "",
    materials: [],
    assuranceTiers: [0, 1],
    pricing: { currency: "USDC", baseCost: "10", minimum: "10" },
    availability: {},
    location: { lat: 0, lng: 0 },
    lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    validUntil: "2026-01-01T00:00:00.000Z",
  } as never);
  const { db } = getStore();
  db.insert(schema.operatorPolicies).values({
    kernelId,
    policy: { version: 1, emergencyStop: false, approvalMode: "manual" },
    updatedAt: now,
  } as never).run();
  const approvalId = uid("rule7-approval");
  db.insert(schema.pendingApprovals).values({
    id: approvalId,
    kernelId,
    jobId: uid("rule7-job"),
    submittedBy: "someone",
    jobSummary: { capabilityType: "liquid-handler", parameters: {} },
    status: "pending",
    createdAt: now,
    decidedAt: null,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  } as never).run();
  const deviceId = uid("rule7-dev");
  repos.kernels.insertDevice({
    id: deviceId,
    kernelId,
    type: "machine",
    model: "rule7",
    firmware: "unknown",
    status: "idle",
    contributesToCapabilities: [],
    lastUpdated: now,
    adapterType: "mock",
    capabilities: [],
    healthStatus: "healthy",
  } as never);
  return { kernelId, capId, approvalId, deviceId };
}

/** Everything a guarded route could write, for one seeded kernel. */
function snapshot(s: Seed): string {
  const { db } = getStore();
  const repos = getRepos();
  return JSON.stringify({
    kernel: repos.kernels.findById(s.kernelId) ?? null,
    capabilities: repos.capabilities.findByKernel(s.kernelId),
    policy:
      db.select().from(schema.operatorPolicies).where(eq(schema.operatorPolicies.kernelId, s.kernelId)).get() ??
      null,
    approvals: db.select().from(schema.pendingApprovals).where(eq(schema.pendingApprovals.kernelId, s.kernelId)).all(),
    devices: repos.kernels.findDevicesByKernel(s.kernelId),
    graphNodes: db.select().from(schema.graphSearchNodes).all(),
    composeCandidates: db.select().from(schema.compositionCandidates).all(),
  });
}

function graphNode(kernelId: string) {
  return {
    capabilityId: uid("rule7-node"),
    capabilityType: "rule7-type",
    kernelId,
    estimatedPriceUSD: 10,
    estimatedDurationMs: 1_000,
    assuranceTier: 3,
    reputation: 500,
    outputTypes: ["rule7-type"],
  };
}

function composeCandidate(kernelId: string) {
  return {
    capabilityId: uid("rule7-cand"),
    kernelId,
    operatorAddress: "someone-else",
    capabilityType: "rule7-type",
    estimatedPriceUSD: 10,
    estimatedDurationMs: 1_000,
    assuranceTier: 3,
  };
}

type Method = "GET" | "POST" | "PUT" | "PATCH";

interface Row {
  route: string;
  method: Method;
  url: (s: Seed) => string;
  body?: (s: Seed) => Record<string, unknown>;
  /** Status with NO actor. */
  refused: 401 | 403;
  /** Status of the same request sent with the owner's key (positive control). */
  ok: number;
}

const ROWS: Row[] = [
  {
    route: "POST /api/kernels (update of an existing kernel)",
    method: "POST",
    url: () => "/api/kernels",
    body: (s) => ({ id: s.kernelId, name: "rule7-renamed", maxAssuranceTier: 3 }),
    refused: 403,
    ok: 200,
  },
  {
    route: "POST /api/kernels/:kernelId/heartbeat",
    method: "POST",
    url: (s) => `/api/kernels/${s.kernelId}/heartbeat`,
    body: () => ({ status: "online", capabilities: [{ type: "rule7-injected", assuranceTiers: [3] }] }),
    refused: 401,
    ok: 200,
  },
  {
    route: "POST /api/kernels/:kernelId/capabilities (announce)",
    method: "POST",
    url: (s) => `/api/kernels/${s.kernelId}/capabilities`,
    body: () => ({ maxAssuranceTier: 3, capabilities: [{ type: "rule7-announced", assuranceTiers: [3] }] }),
    refused: 401,
    ok: 200,
  },
  {
    route: "POST /api/capabilities/:capId/heartbeat",
    method: "POST",
    url: (s) => `/api/capabilities/${s.capId}/heartbeat`,
    body: () => ({}),
    refused: 401,
    ok: 200,
  },
  {
    route: "POST /api/operator/heartbeat",
    method: "POST",
    url: () => "/api/operator/heartbeat",
    body: (s) => ({
      kernelId: s.kernelId,
      status: "online",
      capabilities: [{ type: "rule7-injected", assuranceTiers: [3] }],
    }),
    refused: 401,
    ok: 200,
  },
  {
    route: "POST /api/capabilities",
    method: "POST",
    url: () => "/api/capabilities",
    body: (s) => ({ kernelId: s.kernelId, type: "rule7-listing", assuranceTiers: [3] }),
    refused: 401,
    ok: 201,
  },
  {
    route: "PUT /api/operator/policy/:kernelId",
    method: "PUT",
    url: (s) => `/api/operator/policy/${s.kernelId}`,
    body: () => ({ version: 1, emergencyStop: true, approvalMode: "auto" }),
    refused: 401,
    ok: 200,
  },
  {
    route: "PATCH /api/operator/policy/:kernelId",
    method: "PATCH",
    url: (s) => `/api/operator/policy/${s.kernelId}`,
    body: () => ({ approvalMode: "auto" }),
    refused: 401,
    ok: 200,
  },
  {
    route: "POST /api/operator/emergency-stop",
    method: "POST",
    url: () => "/api/operator/emergency-stop",
    body: (s) => ({ kernelId: s.kernelId, reason: "rule7" }),
    refused: 401,
    ok: 200,
  },
  {
    route: "POST /api/operator/emergency-resume",
    method: "POST",
    url: () => "/api/operator/emergency-resume",
    body: (s) => ({ kernelId: s.kernelId }),
    refused: 401,
    ok: 200,
  },
  {
    route: "POST /api/operator/approvals",
    method: "POST",
    url: () => "/api/operator/approvals",
    body: (s) => ({ kernelId: s.kernelId, capabilityType: "liquid-handler", parameters: { task: "rule7" } }),
    refused: 401,
    ok: 200,
  },
  {
    route: "GET /api/operator/approvals?kernelId=",
    method: "GET",
    url: (s) => `/api/operator/approvals?kernelId=${s.kernelId}`,
    refused: 401,
    ok: 200,
  },
  {
    route: "POST /api/operator/approvals/:id/approve",
    method: "POST",
    url: (s) => `/api/operator/approvals/${s.approvalId}/approve`,
    refused: 401,
    ok: 200,
  },
  {
    route: "POST /api/operator/approvals/:id/reject",
    method: "POST",
    url: (s) => `/api/operator/approvals/${s.approvalId}/reject`,
    body: () => ({ reason: "rule7" }),
    refused: 401,
    ok: 200,
  },
  {
    route: "POST /api/capabilities/graph/_dev/register-node",
    method: "POST",
    url: () => "/api/capabilities/graph/_dev/register-node",
    body: (s) => graphNode(s.kernelId),
    refused: 401,
    ok: 201,
  },
  {
    route: "POST /api/compose/_dev/register-candidate",
    method: "POST",
    url: () => "/api/compose/_dev/register-candidate",
    body: (s) => composeCandidate(s.kernelId),
    refused: 401,
    ok: 201,
  },
  {
    route: "POST /api/setup/register-device",
    method: "POST",
    url: () => "/api/setup/register-device",
    body: (s) => ({
      kernelId: s.kernelId,
      deviceId: `${s.deviceId}-new`,
      type: "machine",
      model: "rule7",
      adapterType: "mock",
      capabilities: ["rule7-device-cap"],
    }),
    refused: 401,
    ok: 201,
  },
];

/** Malformed bodies with no actor: the actor is resolved first, so still 401. */
const MALFORMED: Array<{ route: string; method: Method; url: (s: Seed) => string; body?: unknown }> = [
  { route: "POST /api/operator/heartbeat {}", method: "POST", url: () => "/api/operator/heartbeat", body: {} },
  { route: "POST /api/capabilities {}", method: "POST", url: () => "/api/capabilities", body: {} },
  {
    route: "PUT /api/operator/policy/:kernelId (no version)",
    method: "PUT",
    url: (s) => `/api/operator/policy/${s.kernelId}`,
    body: { emergencyStop: true },
  },
  { route: "POST /api/operator/emergency-stop {}", method: "POST", url: () => "/api/operator/emergency-stop", body: {} },
  {
    route: "POST /api/operator/emergency-resume {}",
    method: "POST",
    url: () => "/api/operator/emergency-resume",
    body: {},
  },
  { route: "POST /api/operator/approvals {}", method: "POST", url: () => "/api/operator/approvals", body: {} },
  {
    route: "POST /api/capabilities/graph/_dev/register-node {}",
    method: "POST",
    url: () => "/api/capabilities/graph/_dev/register-node",
    body: {},
  },
  {
    route: "POST /api/compose/_dev/register-candidate {}",
    method: "POST",
    url: () => "/api/compose/_dev/register-candidate",
    body: {},
  },
  { route: "POST /api/setup/register-device {}", method: "POST", url: () => "/api/setup/register-device", body: {} },
  {
    route: "POST /api/capabilities/:capId/heartbeat (unknown capability)",
    method: "POST",
    url: () => `/api/capabilities/${uid("no-such-cap")}/heartbeat`,
    body: {},
  },
];

/**
 * Send one request and observe the kernel lookups it makes. Returns the
 * response plus every kernel-owner lookup (KernelFacade.getById) and every
 * kernel row lookup (repos.kernels.findById) argument.
 */
async function observe(
  method: Method,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const ownerLookups = vi.spyOn(KernelFacade.prototype, "getById");
  const rowLookups = vi.spyOn(getRepos().kernels, "findById");
  try {
    const res = await bare.inject({ method, url, headers, ...(body !== undefined ? { payload: body as object } : {}) });
    return {
      res,
      ownerLookupArgs: ownerLookups.mock.calls.map((c) => c[0]),
      rowLookupArgs: rowLookups.mock.calls.map((c) => c[0]),
    };
  } finally {
    ownerLookups.mockRestore();
    rowLookups.mockRestore();
  }
}

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  ownerKey = provisionApiKey({ operatorId: OWNER, scopes: ["operator"] }).rawKey;
  bare = Fastify({ logger: false }); // deliberately NO apiGate
  await bare.register(kernelRoutes);
  await bare.register(capabilityRoutes);
  await bare.register(operatorRelayRoutes);
  await bare.register(operatorRoutes);
  await bare.register(composeRoutes);
  await bare.register(graphSearchRoutes);
  await bare.register(setupRoutes);
  await bare.register(kernelMarketplaceRoutes);
  await bare.ready();
});

afterAll(async () => {
  await bare.close();
  closeStore();
});

describe("steward rule 7: every WP-C owner guard fails closed without an actor (bare app, no apiGate)", () => {
  it.each(ROWS)("[neg] no actor: $route -> refused, nothing written, no owner lookup", async (row) => {
    const s = seed();
    const before = snapshot(s);
    const { res, ownerLookupArgs, rowLookupArgs } = await observe(row.method, row.url(s), row.body?.(s));

    expect(res.statusCode).toBe(row.refused);
    expect(snapshot(s)).toBe(before);
    // No kernel-OWNER lookup at all: the actor is checked before any lookup.
    expect(ownerLookupArgs).toEqual([]);
    // And no kernel row lookup keyed on a missing/empty id.
    for (const arg of rowLookupArgs) {
      expect(typeof arg === "string" && arg.length > 0).toBe(true);
    }
  });

  it.each(MALFORMED)("[neg] no actor + malformed body: $route -> 401 (actor before body validation)", async (row) => {
    const s = seed();
    const before = snapshot(s);
    const { res, ownerLookupArgs } = await observe(row.method, row.url(s), row.body);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("api_key_required");
    expect(snapshot(s)).toBe(before);
    expect(ownerLookupArgs).toEqual([]);
  });

  it.each(ROWS)("control: the same request with the OWNER's key -> $ok ($route)", async (row) => {
    const s = seed();
    const { res } = await observe(row.method, row.url(s), row.body?.(s), asOwner());
    expect(res.statusCode).toBe(row.ok);
  });
});

describe("steward rule 7: the marketplace ceiling check fails closed without a registrant", () => {
  it("[neg] a manifest registered with NO actor never borrows the kernel row's ceiling (served 0); the owner's registration does (control)", async () => {
    _setSmokeTestFetch(async () => new Response("{}", { status: 200 }));
    try {
      for (const [headers, expected] of [
        [{}, 0],
        [asOwner(), 3],
      ] as const) {
        _clearKernelRegistry();
        const s = seed();
        getRepos().kernels.update(s.kernelId, { maxAssuranceTier: 3 } as never);
        const manifest = {
          manifestVersion: "1.0.0",
          kernelId: s.kernelId,
          name: "rule7 digital kernel",
          description: "rule7",
          builder: { agentId: "eip155:84532:0x1234567890abcdef1234567890abcdef12345678" },
          capabilityType: "rule7-digital",
          workflowSteps: [{ stepId: "s", stepType: "transform", description: "d", dependsOn: [] }],
          pricing: { currency: "USDC", baseUSD: 1 },
          maxAssuranceTier: 3,
          endpointURL: "https://kernel.rule7.example/run",
          sessionKeyPolicy: { maxTTLSeconds: 60, allowedActions: ["evidence_submit"] },
        };
        const reg = await bare.inject({
          method: "POST",
          url: "/api/kernels/register",
          headers,
          payload: { manifest },
        });
        expect(reg.statusCode).toBe(201);
        // NODE_ENV is "test" and no PCC_ADMIN_KEY is set: the admin gate is open.
        expect((await bare.inject({ method: "POST", url: `/api/kernels/${s.kernelId}/verify` })).statusCode).toBe(200);
        const served = (await bare.inject({ method: "GET", url: `/api/kernels/marketplace/${s.kernelId}` })).json();
        expect(served.kernel.maxAssuranceTier).toBe(expected);
      }
    } finally {
      _setSmokeTestFetch(null);
      _clearKernelRegistry();
    }
  });
});
