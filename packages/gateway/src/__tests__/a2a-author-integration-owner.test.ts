/**
 * WP-C R6 (review round 2, LOW): the A2A `pcc-author-integration` skill
 * registers a kernel OWNED BY THE AUTHENTICATED CALLER, never by a body field.
 *
 * Before: the skill called KernelFacade.register with
 * `operatorAddress: p.operatorAddress ?? "a2a-operator"` and no actor. Any
 * caller could nominate someone else as the owner of a kernel (and of the
 * capability published on it), and a kernel onboarded without that field was
 * owned by "a2a-operator", a principal no key can hold, so under WP-C's
 * owner-only heartbeat it could never heartbeat and expired after the TTL.
 *
 * The file imports only modules that exist on the pre-R6 code, so it runs
 * unchanged against the pre-R6 routes/a2a-tasks.ts to prove polarity: every
 * [neg] case fails there.
 *
 * finisher-lima2
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { a2aTasksRoutes, __resetA2ATasksForTest } from "../routes/a2a-tasks.js";
import { kernelRoutes } from "../routes/kernels.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";

let app: FastifyInstance;
let callerKey: string;
let victimKey: string;
const CALLER = "r6-a2a-caller";
const VICTIM = "r6-a2a-victim@example.com";
const savedAuthFlag = process.env.PCC_A2A_AUTH_DISABLED;

const asCaller = () => ({ authorization: `Bearer ${callerKey}` });
const asVictim = () => ({ authorization: `Bearer ${victimKey}` });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

async function authorIntegration(
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: "/a2a/tasks/send",
    headers: { "content-type": "application/json", ...headers },
    payload: JSON.stringify({
      jsonrpc: "2.0",
      id: uid("rpc"),
      method: "tasks/send",
      params: { skill: "pcc-author-integration", params },
    }),
  });
}

function kernelsNamed(name: string) {
  return getRepos().kernels.findAll().filter((k) => k.name === name);
}

async function heartbeat(kernelId: string, headers: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: `/api/kernels/${kernelId}/heartbeat`,
    headers,
    payload: { status: "online" },
  });
}

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  callerKey = provisionApiKey({ operatorId: CALLER, scopes: ["operator"] }).rawKey;
  victimKey = provisionApiKey({ operatorId: VICTIM, scopes: ["operator"] }).rawKey;
  // No apiGate: /a2a/* is outside /api/ and resolves its own auth, and the
  // owner-only kernel routes resolve the Bearer key themselves.
  app = Fastify({ logger: false });
  await app.register(a2aTasksRoutes);
  await app.register(kernelRoutes);
  await app.ready();
});

afterEach(() => {
  __resetA2ATasksForTest();
  if (savedAuthFlag === undefined) delete process.env.PCC_A2A_AUTH_DISABLED;
  else process.env.PCC_A2A_AUTH_DISABLED = savedAuthFlag;
});

afterAll(async () => {
  await app.close();
  closeStore();
});

describe("WP-C R6: pcc-author-integration binds the kernel to the authenticated caller", () => {
  it("[neg] a caller that names SOMEONE ELSE in operatorAddress still owns the kernel it registers; the named party cannot heartbeat it", async () => {
    delete process.env.PCC_A2A_AUTH_DISABLED; // the production gate is on
    const name = uid("R6 Diner");
    const res = await authorIntegration(
      { lane: "machine", name, type: uid("r6-type"), operatorAddress: VICTIM },
      asCaller(),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().result?.state).toBe("COMPLETED");
    const kernelId = res.json().result.artifacts[0].data.kernelId as string;

    expect(getRepos().kernels.findById(kernelId)?.operatorAddress).toBe(CALLER);
    // The body-named "owner" gets nothing; the real caller can heartbeat
    // (A2A-onboarded kernels are no longer orphaned under owner-only heartbeat).
    expect((await heartbeat(kernelId, asVictim())).statusCode).toBe(403);
    expect((await heartbeat(kernelId, asCaller())).statusCode).toBe(200);
  });

  it("[neg] with PCC_A2A_AUTH_DISABLED and NO credentials the skill is refused and nothing is registered", async () => {
    process.env.PCC_A2A_AUTH_DISABLED = "true";
    const name = uid("R6 Anonymous");
    const type = uid("r6-anon-type");
    const res = await authorIntegration({ lane: "machine", name, type, operatorAddress: VICTIM });
    expect(res.statusCode).toBe(200); // JSON-RPC carries errors in the body
    expect(res.json().result).toBeUndefined();
    expect(res.json().error?.code).toBe(-32600);
    expect(res.json().error?.message).toMatch(/authentication required/i);
    expect(kernelsNamed(name)).toEqual([]);
    expect(getRepos().capabilities.findByType(type)).toEqual([]);
  });

  it("[neg] with PCC_A2A_AUTH_DISABLED the skill still takes the owner from the caller's key, never from the body", async () => {
    process.env.PCC_A2A_AUTH_DISABLED = "true";
    const name = uid("R6 Keyed");
    const res = await authorIntegration(
      { lane: "human", name, type: uid("r6-keyed-type"), operatorAddress: VICTIM },
      asCaller(),
    );
    expect(res.json().result?.state).toBe("COMPLETED");
    const rows = kernelsNamed(name);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operatorAddress).toBe(CALLER);
  });

  it("the published capability sits on the caller's own new kernel, at ceiling 0 (positive control)", async () => {
    delete process.env.PCC_A2A_AUTH_DISABLED;
    const type = uid("r6-cap-type");
    const res = await authorIntegration(
      { lane: "machine", name: uid("R6 Printer"), type },
      asCaller(),
    );
    const data = res.json().result.artifacts[0].data;
    expect(data.capability.id).toBe(`cap-${data.kernelId}-${type}`);
    expect(data.capability.kernelId).toBe(data.kernelId);
    // A fresh kernel with no proven signing key is served at tier 0.
    expect(data.capability.assuranceTiers).toEqual([0]);
  });
});
