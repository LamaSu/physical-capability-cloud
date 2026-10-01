/**
 * `acceptingJobs` on the kernel heartbeat (adk #4446).
 *
 * A heartbeat that carries no capability list refreshes `validUntil` on EVERY
 * capability of the kernel ("still alive, nothing changed about my catalog").
 * A node that takes no jobs (the pcc-node daemon is heartbeat-only) therefore
 * keeps its listings visible to buyers for as long as it keeps beating.
 *
 * POST /api/operator/heartbeat and POST /api/kernels/:kernelId/heartbeat now
 * take an optional boolean `acceptingJobs`:
 *   - `false`: liveness is recorded as before (kernel status, last heartbeat and
 *     the kernel's own validUntil), but NO capability's validUntil or
 *     lastHeartbeatAt is refreshed, no announced capability list is applied, and
 *     nothing is withdrawn: the listings age out on their own TTL;
 *   - `true` or absent: unchanged;
 *   - any other type (a string, a number, null, an object): 400
 *     invalid_accepting_jobs, and nothing is written.
 *
 * Heartbeats are OWNER-ONLY, so every call is made as the kernel's registered
 * owner. No apiGate is mounted: an `x-test-operator` header stands in for the
 * identity it would attach (the kernel-ttl-integration pattern).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { kernelRoutes } from "../routes/kernels.js";
import { capabilityRoutes } from "../routes/capabilities.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { getKernelFacade } from "../facades/index.js";
import { closeStore, getRepos, initStore } from "../db.js";

const OWNER = "hb-accepting-owner@x.test";
const STRANGER = "hb-accepting-stranger@x.test";
const HOUR = 3_600_000;

let app: FastifyInstance;
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const savedTtl = process.env.KERNEL_TTL_HOURS;

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  delete process.env.KERNEL_TTL_HOURS; // the 24h default
  initStore({ seed: false });
  app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const h = req.headers["x-test-operator"];
    if (typeof h === "string" && h) (req as unknown as { operatorId?: string }).operatorId = h;
  });
  await app.register(kernelRoutes);
  await app.register(capabilityRoutes);
  await app.register(operatorRelayRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
  if (savedTtl === undefined) delete process.env.KERNEL_TTL_HOURS;
  else process.env.KERNEL_TTL_HOURS = savedTtl;
});

// ── The two heartbeat routes ────────────────────────────────────────────────

interface Route {
  name: string;
  url: (kernelId: string) => string;
  body: (kernelId: string, fields: Record<string, unknown>) => Record<string, unknown>;
}
const ROUTES: Route[] = [
  {
    name: "POST /api/kernels/:kernelId/heartbeat",
    url: (k) => `/api/kernels/${k}/heartbeat`,
    body: (_k, f) => f,
  },
  {
    name: "POST /api/operator/heartbeat",
    url: () => "/api/operator/heartbeat",
    body: (k, f) => ({ kernelId: k, ...f }),
  },
];

function beat(route: Route, kernelId: string, fields: Record<string, unknown>, as: string | null = OWNER) {
  return app.inject({
    method: "POST",
    url: route.url(kernelId),
    headers: as ? { "x-test-operator": as } : {},
    payload: route.body(kernelId, fields) as never,
  });
}

// ── Fixture: a kernel with two listings, aged so a refresh is unmistakable ───

interface Aged {
  kernelId: string;
  capIds: [string, string];
  /** When the rows were last refreshed (3h ago). */
  lastBeat: string;
  /** Their remaining life: 2h, far short of a fresh 24h TTL. */
  validUntil: string;
}

async function agedKernel(prefix: string): Promise<Aged> {
  const kernelId = uid(prefix);
  const reg = await getKernelFacade().register({ id: kernelId, name: `HB ${kernelId}` }, OWNER);
  expect(reg.success, JSON.stringify(reg)).toBe(true);
  const announce = await app.inject({
    method: "POST",
    url: `/api/kernels/${kernelId}/heartbeat`,
    headers: { "x-test-operator": OWNER },
    payload: { status: "online", capabilities: [{ type: "cap-a" }, { type: "cap-b" }] },
  });
  expect(announce.statusCode, announce.body).toBe(200);
  expect(announce.json().capabilitiesReceived).toBe(2);

  const capIds: [string, string] = [`cap-${kernelId}-cap-a`, `cap-${kernelId}-cap-b`];
  const lastBeat = new Date(Date.now() - 3 * HOUR).toISOString();
  const validUntil = new Date(Date.now() + 2 * HOUR).toISOString();
  getRepos().kernels.update(kernelId, { lastHeartbeat: lastBeat, validUntil, status: "online" } as never);
  for (const id of capIds) {
    getRepos().capabilities.update(id, { lastHeartbeatAt: lastBeat, validUntil } as never);
  }
  return { kernelId, capIds, lastBeat, validUntil };
}

const capRow = (id: string) => getRepos().capabilities.findById(id) as unknown as {
  validUntil: string | null;
  lastHeartbeatAt: string | null;
  kernelId: string;
};
const kernelRow = (id: string) => getRepos().kernels.findById(id) as unknown as {
  validUntil: string | null;
  lastHeartbeat: string | null;
  status: string;
};
const ms = (iso: string | null | undefined) => Date.parse(iso ?? "");

/** Capability ids a buyer sees for the kernel (the default listing filters expired rows). */
async function listedFor(kernelId: string): Promise<string[]> {
  const res = await app.inject({ method: "GET", url: `/api/capabilities/by-kernel/${kernelId}` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().capabilities as Array<{ id: string }>).map((c) => c.id).sort();
}

/** Nothing about the kernel or its listings changed since `aged` was set up. */
function expectUntouched(aged: Aged): void {
  expect(kernelRow(aged.kernelId).lastHeartbeat).toBe(aged.lastBeat);
  expect(kernelRow(aged.kernelId).validUntil).toBe(aged.validUntil);
  for (const id of aged.capIds) {
    expect(capRow(id).validUntil).toBe(aged.validUntil);
    expect(capRow(id).lastHeartbeatAt).toBe(aged.lastBeat);
  }
}

// ═════════════════════════════════════════════════════════════════════════════

describe.each(ROUTES)("$name", (route) => {
  describe("a heartbeat with no capability list (today's behavior, unchanged)", () => {
    it.each([
      ["acceptingJobs absent", {}],
      ["acceptingJobs: true", { acceptingJobs: true }],
    ])("control: %s refreshes every capability and the kernel", async (_label, fields) => {
      const aged = await agedKernel("hb-default");
      const res = await beat(route, aged.kernelId, { status: "online", ...fields });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().acknowledged).toBe(true);
      expect(res.json().acceptingJobs).toBeUndefined();
      const floor = Date.now() + 20 * HOUR;
      for (const id of aged.capIds) {
        expect(ms(capRow(id).validUntil), `${id} validUntil moves forward`).toBeGreaterThan(floor);
        expect(ms(capRow(id).lastHeartbeatAt)).toBeGreaterThan(ms(aged.lastBeat));
      }
      expect(ms(kernelRow(aged.kernelId).validUntil)).toBeGreaterThan(floor);
      expect(await listedFor(aged.kernelId)).toEqual([...aged.capIds].sort());
    });
  });

  describe("acceptingJobs: false (a node that takes no jobs)", () => {
    it("[repro] records liveness, but no capability's validUntil or lastHeartbeatAt moves", async () => {
      const aged = await agedKernel("hb-false");
      const before = Date.now();
      const res = await beat(route, aged.kernelId, { status: "online", acceptingJobs: false });
      expect(res.statusCode, res.body).toBe(200);

      // Listings: nothing refreshed.
      for (const id of aged.capIds) {
        expect(capRow(id).validUntil, `${id} validUntil`).toBe(aged.validUntil);
        expect(capRow(id).lastHeartbeatAt, `${id} lastHeartbeatAt`).toBe(aged.lastBeat);
      }

      // Liveness: the kernel is online, was seen just now, and its own TTL is renewed.
      const kernel = kernelRow(aged.kernelId);
      expect(kernel.status).toBe("online");
      expect(ms(kernel.lastHeartbeat)).toBeGreaterThanOrEqual(before);
      expect(ms(kernel.validUntil)).toBeGreaterThan(Date.now() + 20 * HOUR);

      // The answer says what was done.
      const body = res.json();
      expect(body.acknowledged).toBe(true);
      expect(body.kernelId).toBe(aged.kernelId);
      expect(body.status).toBe("online");
      expect(body.capabilitiesReceived).toBe(0);
      expect(body.acceptingJobs).toBe(false);
    });

    it("[repro] withdraws nothing: the listings stay until they age out, and a later beat does not bring them back", async () => {
      const aged = await agedKernel("hb-ageout");
      const res = await beat(route, aged.kernelId, { acceptingJobs: false });
      expect(res.statusCode, res.body).toBe(200);
      // Still listed (their own TTL has not run out) and the rows still exist.
      expect(await listedFor(aged.kernelId)).toEqual([...aged.capIds].sort());
      for (const id of aged.capIds) expect(capRow(id)).toBeTruthy();

      // Their TTL runs out: they drop out of the buyer's listing.
      const past = new Date(Date.now() - HOUR).toISOString();
      for (const id of aged.capIds) getRepos().capabilities.update(id, { validUntil: past } as never);
      expect(await listedFor(aged.kernelId)).toEqual([]);

      // Another false beat keeps the kernel alive and leaves them expired.
      const again = await beat(route, aged.kernelId, { acceptingJobs: false });
      expect(again.statusCode, again.body).toBe(200);
      expect(kernelRow(aged.kernelId).status).toBe("online");
      expect(await listedFor(aged.kernelId)).toEqual([]);
      for (const id of aged.capIds) expect(capRow(id).validUntil).toBe(past);

      // Contrast: an ordinary beat (flag absent) brings them back, as it always did.
      const ordinary = await beat(route, aged.kernelId, { status: "online" });
      expect(ordinary.statusCode, ordinary.body).toBe(200);
      expect(await listedFor(aged.kernelId)).toEqual([...aged.capIds].sort());
    });

    it("[repro] applies no announced capability list: nothing is inserted and nothing is refreshed", async () => {
      const aged = await agedKernel("hb-announce");
      const res = await beat(route, aged.kernelId, {
        acceptingJobs: false,
        capabilities: [{ type: "cap-a" }, { type: "brand-new" }],
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().capabilitiesReceived).toBe(0);
      expect(getRepos().capabilities.findById(`cap-${aged.kernelId}-brand-new`)).toBeFalsy();
      for (const id of aged.capIds) expect(capRow(id).validUntil).toBe(aged.validUntil);
      expect(await listedFor(aged.kernelId)).toEqual([...aged.capIds].sort());
    });

    it("[repro] status is honored as before: an offline beat stays offline, and its listings are still not refreshed", async () => {
      const aged = await agedKernel("hb-offline");
      const res = await beat(route, aged.kernelId, { status: "offline", acceptingJobs: false });
      expect(res.statusCode, res.body).toBe(200);
      expect(kernelRow(aged.kernelId).status).toBe("offline");
      for (const id of aged.capIds) expect(capRow(id).validUntil).toBe(aged.validUntil);
    });
  });

  describe("a non-boolean acceptingJobs is a 400, and nothing is written", () => {
    it.each([
      ["the string 'false'", "false"],
      ["the string 'true'", "true"],
      ["the number 0", 0],
      ["the number 1", 1],
      ["null", null],
      ["an object", {}],
      ["an array", []],
    ])("[repro] %s", async (_label, value) => {
      const aged = await agedKernel("hb-bad");
      const res = await beat(route, aged.kernelId, { status: "online", acceptingJobs: value });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toBe("invalid_accepting_jobs");
      expectUntouched(aged);
    });
  });

  describe("authority is unchanged by the flag", () => {
    it("a NON-owner's acceptingJobs:false is refused 403 not_kernel_owner and writes nothing", async () => {
      const aged = await agedKernel("hb-stranger");
      const res = await beat(route, aged.kernelId, { acceptingJobs: false }, STRANGER);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error).toBe("not_kernel_owner");
      expectUntouched(aged);
    });

    it("no identity is 401 and writes nothing", async () => {
      const aged = await agedKernel("hb-anon");
      const res = await beat(route, aged.kernelId, { acceptingJobs: false }, null);
      expect(res.statusCode, res.body).toBe(401);
      expectUntouched(aged);
    });

    it("an unknown kernel is still 404", async () => {
      const res = await beat(route, "kernel-hb-does-not-exist", { acceptingJobs: false });
      expect(res.statusCode, res.body).toBe(404);
    });
  });
});

describe("POST /api/operator/heartbeat: the body is validated before the kernel is looked up", () => {
  const operator = ROUTES[1];

  it("[repro] a non-boolean acceptingJobs is a 400 for any authenticated caller, as a missing kernelId is", async () => {
    const aged = await agedKernel("hb-order");
    const res = await beat(operator, aged.kernelId, { acceptingJobs: "no" }, STRANGER);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe("invalid_accepting_jobs");
    expectUntouched(aged);
  });

  it("no identity is still a 401, before the body is looked at", async () => {
    const aged = await agedKernel("hb-order-anon");
    const res = await beat(operator, aged.kernelId, { acceptingJobs: "no" }, null);
    expect(res.statusCode, res.body).toBe(401);
  });
});

describe("KernelFacade.heartbeat validates acceptingJobs itself (a caller other than the two routes)", () => {
  it("[repro] a non-boolean is a 400 BadRequest result, and nothing is written", async () => {
    const aged = await agedKernel("hb-facade");
    const result = await getKernelFacade().heartbeat(
      aged.kernelId,
      { status: "online", acceptingJobs: "false" as unknown as boolean },
      OWNER,
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.httpStatus).toBe(400);
    expect(result.error.code).toBe("invalid_accepting_jobs");
    expectUntouched(aged);
  });

  it("[repro] false leaves the capabilities alone; the result says so", async () => {
    const aged = await agedKernel("hb-facade-false");
    const result = await getKernelFacade().heartbeat(aged.kernelId, { acceptingJobs: false }, OWNER);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.acceptingJobs).toBe(false);
    expect(result.data.capabilitiesReceived).toBe(0);
    for (const id of aged.capIds) expect(capRow(id).validUntil).toBe(aged.validUntil);
  });
});
