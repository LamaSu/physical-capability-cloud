/**
 * N133 follow-up (fund-s2-review LOW-2, the acceptanceFor half): a kernel's block list that is
 * present but is not an array of strings never reads as "nobody blocked".
 *
 * PUT /api/operator/policy/:kernelId checks only `version === 1` and PATCH merges any body, so the
 * kernel's own operator (a decision, N31) can store `blockedAgents: "0x5555…"`. At 36f16726
 * acceptanceFor read the list only as an array, so that string blocked nobody: under an auto
 * policy, or a policy trusting the buyer, the buyer's scope was minted live, while the kernel's
 * policy engine (`.includes`, a substring match on a string) reads the same field as blocked.
 * Now such a list answers awaiting_operator: the scope waits for the operator's own decision. It
 * is never accepted, nor refused (that would claim the buyer is on it), except that an array with
 * an element naming the buyer is refused first, as before. An absent list blocks nobody.
 *
 * Written by Opus 5.5 (implementer-echo, readmodels lane).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { deviceRelayRoutes } from "../routes/device-relay.js";
import { operatorRoutes } from "../routes/operator.js";
import { a2aTasksRoutes, __resetA2ATasksForTest } from "../routes/a2a-tasks.js";
import { initStore, closeStore, getStore, getRepos } from "../db.js";
import { schema, eq } from "@pcc/store";
import { actAsJobParty } from "./helpers/job-read-party.js";
import { acceptanceFor } from "../services/scope-acceptance.js";

const KERNEL = "kernel-nyc"; // operator 0x1111…, seeded with the default (manual) policy
const LAB = "kernel-nanoclaw"; // operator 0x8888…, seeded in "policy" mode
const LAB_OPERATOR = "0x8888888888888888888888888888888888888888";
const BUYER = "0x5555555555555555555555555555555555555555";
const OTHER = "0x6666666666666666666666666666666666666666";
const ADMIN = "n133-blocklist-admin";

const asKey = (id: string) => ({ "x-test-key": id });

/** An array with a hole at 0, then OTHER. JSON can't make one, but `.some` and `.every` skip holes. */
function withHole(): unknown[] {
  const list: unknown[] = [];
  list[1] = OTHER;
  return list;
}

/** Block lists that are present (not undefined) and not an array whose every element is a string. */
const MALFORMED: ReadonlyArray<readonly [label: string, value: unknown]> = [
  ["a string that is the buyer (the kernel's .includes reads it as blocked)", BUYER],
  ["a string holding the buyer among others", `${OTHER},${BUYER}`],
  ["a string that doesn't hold the buyer", OTHER],
  ["an empty string", ""],
  ["null", null],
  ["a number", 7],
  ["zero", 0],
  ["false", false],
  ["an object keyed by the buyer", { [BUYER]: true }],
  ["an array holding a non-string", [OTHER, 7]],
  ["an array holding null", [null]],
  ["an array holding the buyer one level down", [[BUYER]]],
  ["an array with a hole", withHole()],
];

/** Policies that accept the buyer when their block list is well formed and doesn't name it. */
const ACCEPTING: ReadonlyArray<readonly [label: string, policy: Record<string, unknown>]> = [
  ["auto", { approvalMode: "auto" }],
  ["policy, the buyer trusted", { approvalMode: "policy", trustedAgents: [BUYER] }],
];

describe("acceptanceFor: a block list it can't read", () => {
  it("present and not an array of strings: awaiting_operator under auto and under a policy trusting the buyer, never accepted or refused", () => {
    for (const [mode, base] of ACCEPTING) {
      // Control: the same policy accepts the buyer with no block list, and with [].
      expect(acceptanceFor(base, BUYER), mode).toBe("accepted");
      expect(acceptanceFor({ ...base, blockedAgents: [] }, BUYER), mode).toBe("accepted");
      for (const [label, blockedAgents] of MALFORMED) {
        expect(acceptanceFor({ ...base, blockedAgents }, BUYER), `${mode}; ${label}`).toBe("awaiting_operator");
      }
    }
  });

  it("controls: an array of strings naming the buyer is refused under every mode; [], a list naming someone else, and an absent list block nobody", () => {
    for (const approvalMode of ["auto", "policy", "manual"]) {
      expect(acceptanceFor({ approvalMode, trustedAgents: [BUYER], blockedAgents: [OTHER, BUYER] }, BUYER), approvalMode).toBe("refused");
    }
    expect(acceptanceFor({ approvalMode: "auto", blockedAgents: [] }, BUYER)).toBe("accepted");
    expect(acceptanceFor({ approvalMode: "auto", blockedAgents: [OTHER] }, BUYER)).toBe("accepted");
    // Absent keeps today's reading, so existing policies don't change. Undefined is absent too
    // (JSON can't store it: a stored policy has the key or it doesn't).
    expect(acceptanceFor({ approvalMode: "auto" }, BUYER)).toBe("accepted");
    expect(acceptanceFor({ approvalMode: "auto", blockedAgents: undefined }, BUYER)).toBe("accepted");
  });

  it("a malformed array that still has an element naming the buyer is refused first, as at 36f16726: a malformed list may refuse, never accept", () => {
    const modes = [...ACCEPTING, ["manual", { approvalMode: "manual" }] as const];
    for (const [mode, base] of modes) {
      for (const blockedAgents of [[7, BUYER], [BUYER, null], [{ id: OTHER }, BUYER]]) {
        expect(acceptanceFor({ ...base, blockedAgents }, BUYER), `${mode}; ${JSON.stringify(blockedAgents)}`).toBe("refused");
      }
    }
  });

  it("a trust list trusts the buyer only as an array with an element naming it; a string, null, a number, an object or a nested buyer trusts nobody (unchanged)", () => {
    expect(acceptanceFor({ approvalMode: "policy", trustedAgents: [BUYER] }, BUYER)).toBe("accepted"); // control
    const untrusting: ReadonlyArray<readonly [string, unknown]> = [
      ["a string that is the buyer", BUYER],
      ["a string holding the buyer among others", `${OTHER},${BUYER}`],
      ["null", null],
      ["a number", 7],
      ["an object keyed by the buyer", { [BUYER]: true }],
      ["an array holding the buyer one level down", [[BUYER]]],
      ["an array holding a non-string and not the buyer", [OTHER, 7]],
    ];
    for (const [label, trustedAgents] of untrusting) {
      expect(acceptanceFor({ approvalMode: "policy", trustedAgents }, BUYER), label).toBe("awaiting_operator");
      expect(acceptanceFor({ approvalMode: "policy", trustedAgents, blockedAgents: [] }, BUYER), label).toBe("awaiting_operator");
    }
  });
});

// ── The mint, through each route that mints a paid write scope ─────────────────

const ENV = ["MOCK_SETTLEMENT", "PCC_GATEWAY_PRIVATE_KEY", "PCC_A2A_AUTH_DISABLED", "PCC_DB_PATH", "PCC_ADMIN_KEY"] as const;
const saved: Record<string, string | undefined> = {};
let app: FastifyInstance;

/** N98 (#498): a discovery quote is the kernel's registered price, so each kernel here registers one. */
function ensurePricedLiquidHandler(kernelId: string): void {
  const capabilities = getRepos().capabilities;
  if (capabilities.findByKernel(kernelId).some((c: { type: string }) => c.type === "liquid-handler")) return;
  capabilities.insert({
    id: `cap-liquid-handler-${kernelId}`,
    kernelId,
    type: "liquid-handler",
    name: "liquid-handler test capability",
    description: "test",
    materials: [],
    tolerances: {},
    envelope: { x: 1, y: 1, z: 1, unit: "mm" as const },
    assuranceTiers: [0, 1, 2, 3],
    pricing: { currency: "USDC", baseCost: "10.00", minimum: "0.01" } as never,
    availability: {},
    location: { lat: 40.7, lng: -74 },
  } as never);
}

const db = () => getStore().db;
const scopeRow = (id: string) => db().select().from(schema.executionScopes).where(eq(schema.executionScopes.id, id)).get()!;
const queued = () => db().select().from(schema.toolCallRelay).all();
/** The kernel's stored policy, as the json column reads it back. */
const storedPolicy = (kernelId: string) =>
  (db().select().from(schema.operatorPolicies).where(eq(schema.operatorPolicies.kernelId, kernelId)).get()?.policy ?? null) as Record<string, unknown> | null;

/** The operator's own policy writes. A request with no x-test-key reads as kernel-nyc's proven operator. */
const policyWrite = (method: "PUT" | "PATCH", kernelId: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.inject({ method, url: `/api/operator/policy/${kernelId}`, headers, payload });
const submit = (kernelId: string) =>
  app.inject({
    method: "POST",
    url: "/api/jobs/submit-from-discovery",
    headers: asKey(BUYER),
    payload: { kernelId, capabilityType: "liquid-handler", userAgentId: BUYER },
  });
const writeAs = (scopeId: string, kernelId: string) =>
  app.inject({
    method: "POST",
    url: `/api/relay/${kernelId}/tool-call`,
    headers: asKey(BUYER),
    payload: { scopeId, toolName: "ot2_run_protocol", args: { protocol: "x" } },
  });
/** The operator's decision on a scope (a request with no x-test-key reads as kernel-nyc's operator). */
const accept = (scopeId: string) => app.inject({ method: "POST", url: `/api/operator/scopes/${scopeId}/accept` });

/** A SIWE session for `wallet` (A2A's own gate wants a key or a session). */
function siweSession(wallet: string): Record<string, string> {
  const token = randomUUID();
  const now = new Date();
  getRepos().sessions.insert({
    id: randomUUID(), walletAddress: wallet, token, createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(), lastActiveAt: now.toISOString(),
  });
  return { authorization: `Bearer ${token}` };
}

/** A negotiation session the buyer opens on the lab with its own proven wallet. */
async function openSession(): Promise<string> {
  const created = await app.inject({
    method: "POST", url: "/api/negotiate/session", headers: asKey(BUYER),
    payload: { userAgentId: BUYER, kernelId: LAB, capabilityType: "liquid-handler" },
  });
  expect(created.statusCode).toBe(200);
  return created.json().session.id as string;
}

type Minted = { scopeId: string; scopeStatus: string };

/** Every route that mints a paid write scope (createJobFromSession, then mintedScopeStatus), on the lab. */
const MINTS: ReadonlyArray<readonly [route: string, mint: () => Promise<Minted>]> = [
  ["POST /api/jobs/submit-from-discovery", async () => {
    const res = await submit(LAB);
    expect(res.statusCode).toBe(201);
    return res.json() as Minted;
  }],
  ["POST /api/negotiate/session/:id/commit", async () => {
    const id = await openSession();
    for (const step of ["quote", "review"]) {
      expect((await app.inject({ method: "POST", url: `/api/negotiate/session/${id}/${step}`, headers: asKey(BUYER) })).statusCode).toBe(200);
    }
    const res = await app.inject({ method: "POST", url: `/api/negotiate/session/${id}/commit`, headers: asKey(BUYER) });
    expect(res.statusCode).toBe(200);
    return res.json() as Minted;
  }],
  ["POST /api/negotiate/session/:id/retry-settlement", async () => {
    const id = await openSession();
    db().update(schema.negotiationSessions).set({ status: "settlement_failed" }).where(eq(schema.negotiationSessions.id, id)).run();
    const res = await app.inject({ method: "POST", url: `/api/negotiate/session/${id}/retry-settlement`, headers: asKey(BUYER) });
    expect(res.statusCode).toBe(200);
    expect(res.json().retried).toBe(true);
    return res.json() as Minted;
  }],
  ["A2A tasks/send pcc-submit", async () => {
    const res = await app.inject({
      method: "POST", url: "/a2a/tasks/send", headers: siweSession(BUYER),
      payload: {
        jsonrpc: "2.0", id: 1, method: "tasks/send",
        params: { skill: "pcc-submit", params: { userAgentId: BUYER, kernelId: LAB, capabilityType: "liquid-handler" } },
      },
    });
    expect(res.json().error).toBeUndefined();
    const commit = (res.json().result.artifacts as Array<{ type: string; data: Minted }>).find((a) => a.type === "pcc.commit");
    expect(commit).toBeDefined();
    return commit!.data;
  }],
];

describe("the mint: a block list the gateway can't read makes the buyer's scope wait for the operator", () => {
  beforeEach(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.MOCK_SETTLEMENT = "true"; // explicit (N133 rule 4): a test's mock escrow funds the controls' live scopes
    delete process.env.PCC_GATEWAY_PRIVATE_KEY;
    delete process.env.PCC_A2A_AUTH_DISABLED;
    process.env.PCC_ADMIN_KEY = ADMIN;
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    ensurePricedLiquidHandler(KERNEL);
    ensurePricedLiquidHandler(LAB);
    __resetA2ATasksForTest();

    app = Fastify({ logger: false });
    app.decorateRequest("operatorId", null);
    app.decorateRequest("userId", null);
    app.decorateRequest("apiKeyId", null);
    app.addHook("onRequest", async (req) => {
      const key = req.headers["x-test-key"];
      if (typeof key === "string") {
        (req as unknown as { operatorId: string }).operatorId = key;
        (req as unknown as { userId: string }).userId = key;
      }
    });
    actAsJobParty(app);
    await app.register(paidJobFlowRoutes);
    await app.register(negotiationRoutes);
    await app.register(deviceRelayRoutes);
    await app.register(operatorRoutes);
    await app.register(a2aTasksRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("the repro: the operator PATCHes its block list to the buyer's address as a string; the scope waits, its write is refused, and the operator's accept decides", async () => {
    const patched = await policyWrite("PATCH", KERNEL, { approvalMode: "auto", blockedAgents: BUYER });
    expect(patched.statusCode).toBe(200);
    expect(storedPolicy(KERNEL)).toMatchObject({ approvalMode: "auto", blockedAgents: BUYER }); // stored as sent: nothing checks the field
    const res = await submit(KERNEL);
    expect(res.statusCode).toBe(201);
    const { scopeId, scopeStatus } = res.json() as Minted;
    expect(scopeStatus).toBe("awaiting_acceptance"); // not "active" (accepted), not "rejected" (refused)
    expect(scopeRow(scopeId).status).toBe("awaiting_acceptance");
    expect((await writeAs(scopeId, KERNEL)).statusCode).toBe(403);
    expect(queued()).toHaveLength(0);

    // Not dead: it waits for the operator, whose own accept is the decision.
    const accepted = await accept(scopeId);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ accepted: true, status: "active" });
    expect((await writeAs(scopeId, KERNEL)).statusCode).toBe(201);
  });

  it("PUT: a whole policy whose block list is null, a number, an object or an array holding a non-string mints a scope awaiting acceptance; with [] it is live", async () => {
    const seeded = storedPolicy(KERNEL) ?? {};
    const malformed: ReadonlyArray<readonly [string, unknown]> = [
      ["null", null],
      ["a number", 7],
      ["an object keyed by the buyer", { [BUYER]: true }],
      ["an array holding a non-string", [OTHER, 7]],
    ];
    for (const [label, blockedAgents] of malformed) {
      const put = await policyWrite("PUT", KERNEL, { ...seeded, version: 1, approvalMode: "auto", blockedAgents });
      expect(put.statusCode, label).toBe(200);
      expect(storedPolicy(KERNEL)?.blockedAgents, label).toEqual(blockedAgents);
      const res = await submit(KERNEL);
      expect(res.statusCode, label).toBe(201);
      expect(res.json().scopeStatus, label).toBe("awaiting_acceptance");
      expect(scopeRow(res.json().scopeId).status, label).toBe("awaiting_acceptance");
    }
    // Control: the same policy with a well-formed, empty list.
    expect((await policyWrite("PUT", KERNEL, { ...seeded, version: 1, approvalMode: "auto", blockedAgents: [] })).statusCode).toBe(200);
    const live = await submit(KERNEL);
    expect(live.json().scopeStatus).toBe("active");
    expect((await writeAs(live.json().scopeId, KERNEL)).statusCode).toBe(201);
  });

  it("a malformed array that still names the buyer mints a dead scope, as at 36f16726", async () => {
    expect((await policyWrite("PATCH", KERNEL, { approvalMode: "auto", blockedAgents: [7, BUYER] })).statusCode).toBe(200);
    const res = await submit(KERNEL);
    expect(res.json().scopeStatus).toBe("rejected");
    expect((await writeAs(res.json().scopeId, KERNEL)).statusCode).toBe(403);
  });

  for (const [route, mint] of MINTS) {
    it(`${route}: a block list the operator stored as the buyer's address mints a scope awaiting acceptance; with [] it is live`, async () => {
      const patched = await policyWrite("PATCH", LAB, { approvalMode: "auto", blockedAgents: BUYER }, asKey(LAB_OPERATOR));
      expect(patched.statusCode).toBe(200);
      const waiting = await mint();
      expect(waiting.scopeStatus).toBe("awaiting_acceptance");
      expect(scopeRow(waiting.scopeId).status).toBe("awaiting_acceptance");
      expect((await writeAs(waiting.scopeId, LAB)).statusCode).toBe(403);

      // Control: the same auto policy with a well-formed, empty list mints a live scope.
      expect((await policyWrite("PATCH", LAB, { blockedAgents: [] }, asKey(LAB_OPERATOR))).statusCode).toBe(200);
      const live = await mint();
      expect(live.scopeStatus).toBe("active");
      expect((await writeAs(live.scopeId, LAB)).statusCode).toBe(201);
    });
  }
});
