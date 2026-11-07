/** N85: job/kernel authority; N31c 2026-10-04 01:25 keeps evidence at decide. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { schema, eq, sql } from "@pcc/store";
import { provisionApiKey, resolveApiKey } from "../auth/api-key-auth.js";
import { AUTHENTICATION_REQUIRED } from "../auth/kernel-authority.js";
import { apiGate } from "../middleware/api-gate.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { kernelRoutes } from "../routes/kernels.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";

const PREV_DB = process.env.PCC_DB_PATH;
const PREV_ADMIN = process.env.PCC_ADMIN_KEY;
const ADMIN = "n85-relay-admin";
const OPERATORS = {
  A: "0xA000000000000000000000000000000000000085",
  B: "0xB000000000000000000000000000000000000085",
};
const KERNELS = { A: "kernel-n85-a", B: "kernel-n85-b" };
const JOBS = { A: "job-n85-a", B: "job-n85-b" };
type Operator = keyof typeof OPERATORS;
type Route = "jobs" | "evidence" | "heartbeat" | "job-status";
const ROUTES: Route[] = ["jobs", "evidence", "heartbeat", "job-status"];
const keys = { A: "", B: "" };
const bearer = (operator: Operator) => ({ authorization: `Bearer ${keys[operator]}` });
const asAdmin = () => ({ ...bearer("A"), "x-admin-key": ADMIN });
// Simulate WP-A's proven identity independently of the key's claimed identity.
const asProven = (operator: Operator) => ({ ...bearer(operator === "A" ? "B" : "A"), "x-test-proven-wallet": OPERATORS[operator] });
let app: FastifyInstance;
let ungated: FastifyInstance;

function evidence(operator: Operator) {
  return { events: [{
    type: "execution_completed",
    timestamp: "2026-10-10T12:00:00.000Z",
    source: { deviceId: "n85-printer", deviceType: "fdm", kernelId: KERNELS[operator] },
    payload: { jobId: JOBS[operator], ok: true },
  }] };
}

function request(route: Route, operator: Operator, headers: Record<string, string>, server = app) {
  if (route === "jobs") return server.inject({
    method: "GET", url: `/api/operator/jobs?kernelId=${KERNELS[operator]}`, headers,
  });
  const payload = route === "heartbeat"
    ? { kernelId: KERNELS[operator], status: "online", capabilities: [{ type: "n85-announced", name: "n85 announcement" }], timestamp: 123 }
    : route === "evidence"
      ? { jobId: JOBS[operator], evidence: evidence(operator) }
      : { jobId: JOBS[operator], status: "running", metadata: { progress: 1 } };
  return server.inject({ method: "POST", url: `/api/operator/${route}`, headers, payload });
}

/** Persisted state, including events/capabilities: refusing must leave all of it unchanged. */
function snapshot() {
  const { db } = getStore();
  return {
    jobs: db.select().from(schema.jobs).all(),
    bundles: db.select().from(schema.evidenceBundles).all(),
    events: db.select().from(schema.evidenceEvents).all(),
    kernels: db.select().from(schema.shopKernels).all(),
    capabilities: db.select().from(schema.capabilities).all(),
  };
}

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN;
  closeStore();
  initStore({ seed: true });
  // Current migrations require kernel_id; a legacy fixture must exercise the
  // guarded status UPDATE's real `kernel_id IS NULL` bind, without mocking SQL.
  const { db } = getStore();
  for (const table of ["jobs"]) {
    const ddl = db.get<{ sql: string }>(sql`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}`)!.sql;
    const legacy = `n85_legacy_${table}`;
    db.run(sql.raw(ddl.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${legacy}`).replace(/kernel_id TEXT NOT NULL/i, "kernel_id TEXT")));
    db.run(sql.raw(`INSERT INTO ${legacy} SELECT * FROM ${table}`));
    db.run(sql.raw(`DROP TABLE ${table}`));
    db.run(sql.raw(`ALTER TABLE ${legacy} RENAME TO ${table}`));
  }
  app = Fastify({ logger: false });
  const setProvenWallet = async (req: import("fastify").FastifyRequest) => {
    const proven = req.headers["x-test-proven-wallet"];
    if (typeof proven === "string") {
      (req as unknown as { provenWallet: string }).provenWallet = proven;
      req.provenWalletCarrier = "key";
    }
  };
  app.addHook("onRequest", setProvenWallet);
  await app.register(apiGate);
  await app.register(kernelRoutes);
  await app.register(operatorRelayRoutes);
  await app.ready();
  // Resolve real keys, but omit apiGate: the routes must refuse anonymous callers themselves.
  ungated = Fastify({ logger: false });
  ungated.addHook("onRequest", setProvenWallet);
  ungated.addHook("onRequest", async (req) => {
    const key = resolveApiKey(req);
    if (key) req.operatorId = key.operatorId;
    if (req.headers["x-test-failed-kernel-read"]) {
      const { db } = getStore();
      const select = db.select.bind(db);
      vi.spyOn(db, "select").mockImplementation((fields) => {
        if (fields && "operatorAddress" in fields) throw new Error("n85 read failed");
        return select(fields);
      });
    }
  });
  await ungated.register(operatorRelayRoutes);
  await ungated.ready();
  const repos = getRepos();
  const capabilityTemplate = repos.capabilities.findAll()[0]!;
  const jobTemplate = repos.jobs.findAll()[0]!;
  for (const operator of ["A", "B"] as const) {
    keys[operator] = provisionApiKey({ operatorId: OPERATORS[operator], scopes: ["*"] }).rawKey;
    const reg = await app.inject({
      method: "POST", url: "/api/kernels", headers: bearer(operator),
      payload: { id: KERNELS[operator], name: `N85 ${operator}`, location: { lat: 1, lng: 1 }, physicalAddress: "N85" },
    });
    expect(reg.statusCode).toBe(201);
    expect(repos.kernels.findById(KERNELS[operator])?.operatorAddress).toBe(OPERATORS[operator]);
    repos.capabilities.insert({ ...capabilityTemplate, id: `cap-n85-${operator}`, kernelId: KERNELS[operator] });
    repos.jobs.insert({
      ...jobTemplate, id: JOBS[operator], kernelId: KERNELS[operator], capabilityId: `cap-n85-${operator}`,
      cwmId: `cwm-n85-${operator}`, status: "queued", completedAt: null, evidenceBundleId: null,
    });
  }
});

beforeEach(() => {
  vi.restoreAllMocks();
  const { db } = getStore();
  for (const operator of ["A", "B"] as const) {
    getRepos().jobs.update(JOBS[operator], { kernelId: KERNELS[operator], status: "queued", completedAt: null });
    getRepos().kernels.update(KERNELS[operator], { status: "offline", lastHeartbeat: "2020-01-01T00:00:00.000Z" });
    db.delete(schema.capabilities).where(eq(schema.capabilities.id, `cap-${KERNELS[operator]}-n85-announced`)).run();
  }
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app.close();
  await ungated.close();
  closeStore();
  if (PREV_DB === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = PREV_DB;
  if (PREV_ADMIN === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = PREV_ADMIN;
});

for (const route of ROUTES) describe(`N85 ${route} ${route === "evidence" ? "decide" : "operate"} authority`, () => {
  it("refuses the other operator's wildcard key with 403 and no DB changes or jobs listed", async () => {
    for (const operator of ["A", "B"] as const) {
      const before = snapshot();
      const res = await request(route, operator, bearer(operator === "A" ? "B" : "A"));
      expect.soft(res.statusCode).toBe(403);
      expect.soft(res.json()).toMatchObject({ error: "forbidden", reason: route === "evidence" ? "operator_proof_required" : "not_kernel_operator" });
      expect.soft(res.json().jobs).toBeUndefined();
      expect(snapshot()).toEqual(before);
    }
  });

  it("refuses anonymous without apiGate with 401 AUTHENTICATION_REQUIRED and no DB changes", async () => {
    const before = snapshot();
    const res = await request(route, "B", {}, ungated);
    expect.soft(res.statusCode).toBe(401);
    expect.soft(res.json()).toEqual(AUTHENTICATION_REQUIRED);
    expect(snapshot()).toEqual(before);
  });

  it("also refuses anonymous behind apiGate with 401", async () => {
    const before = snapshot();
    expect((await request(route, "B", {})).statusCode).toBe(401);
    expect(snapshot()).toEqual(before);
  });

  for (const principal of ["operator", "admin"] as const) it(`${principal === "operator" && route === "evidence" ? "proven operator" : principal} retains today's success behavior`, async () => {
    for (const operator of ["A", "B"] as const) {
      const before = snapshot();
      const res = await request(route, operator, principal === "admin" ? asAdmin() : route === "evidence" ? asProven(operator) : bearer(operator));
      expect(res.statusCode).toBe(200);
      if (route === "jobs") {
        expect(res.json().jobs.map((j: { id: string }) => j.id)).toEqual([JOBS[operator]]);
        expect(snapshot()).toEqual(before);
      } else if (route === "evidence") {
        expect(res.json()).toMatchObject({ stored: true, jobId: JOBS[operator], eventsStored: 1, deviceSigned: false, signatureVerified: false });
        const bundle = getRepos().evidence.findById(res.json().bundleId)!;
        expect(bundle.kernelId).toBe(KERNELS[operator]);
        expect(bundle.assuranceTier).toBe(0);
        const events = getStore().db.select().from(schema.evidenceEvents).where(eq(schema.evidenceEvents.bundleId, bundle.id)).all();
        expect(events).toHaveLength(1);
        expect(events[0].source.kernelId).toBe(KERNELS[operator]);
        expect(getRepos().jobs.findById(JOBS[operator])?.status).toBe("queued");
      } else if (route === "job-status") {
        expect(res.json()).toMatchObject({ updated: true, jobId: JOBS[operator], status: "in_progress", metadata: { progress: 1 } });
        expect(getRepos().jobs.findById(JOBS[operator])?.status).toBe("in_progress");
      } else {
        expect(res.json()).toMatchObject({ acknowledged: true, kernelId: KERNELS[operator], capabilitiesReceived: 1 });
        expect(getRepos().kernels.findById(KERNELS[operator])?.status).toBe("online");
        expect(getRepos().capabilities.findById(`cap-${KERNELS[operator]}-n85-announced`)?.kernelId).toBe(KERNELS[operator]);
      }
    }
  });

  it("passes a failed kernel read through as 503 and writes nothing", async () => {
    const before = snapshot();
    // Authenticate first; fail only the authority's direct kernel read, not key resolution.
    const res = await request(route, "B", { ...bearer("B"), "x-test-failed-kernel-read": "true" }, ungated);
    vi.restoreAllMocks();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "read_failed" });
    expect(snapshot()).toEqual(before);
  });
});

describe("N85 target selection and compatibility", () => {
  it("evidence: an operate-only principal cannot store evidence for its own job", async () => {
    for (const operator of ["A", "B"] as const) {
      const before = snapshot();
      const res = await request("evidence", operator, bearer(operator));
      expect.soft(res.statusCode).toBe(403);
      expect.soft(res.json()).toMatchObject({ error: "forbidden", reason: "operator_proof_required" });
      expect(snapshot()).toEqual(before);
    }
  });

  for (const route of ["jobs", "heartbeat"] as const) it(`${route}: an unregistered kernel is 404 for a non-admin`, async () => {
    const before = snapshot();
    const res = await app.inject(route === "jobs"
      ? { method: "GET", url: "/api/operator/jobs?kernelId=kernel-n85-missing", headers: bearer("A") }
      : { method: "POST", url: "/api/operator/heartbeat", headers: bearer("A"), payload: { kernelId: "kernel-n85-missing", capabilities: [{ type: "n85-announced" }] } });
    expect.soft(res.statusCode).toBe(404);
    expect.soft(res.json()).toMatchObject({ error: "kernel_not_found" });
    expect(snapshot()).toEqual(before);
  });

  it.each(["queued", "in_progress", "completed"])("poll refuses another kernel's jobs for status %s", async (status) => {
    getRepos().jobs.update(JOBS.B, { status });
    const before = snapshot();
    const res = await app.inject({ method: "GET", url: `/api/operator/jobs?kernelId=${KERNELS.B}&status=${status}`, headers: bearer("A") });
    expect.soft(res.statusCode).toBe(403);
    expect.soft(res.json().jobs).toBeUndefined();
    expect(snapshot()).toEqual(before);
  });

  for (const route of ["evidence", "job-status"] as const) {
    it(`${route}: admin passes authority on a legacy job without a kernel`, async () => {
      getStore().db.run(sql`UPDATE jobs SET kernel_id = NULL WHERE id = ${JOBS.B}`);
      const before = snapshot();
      const res = await request(route, "B", asAdmin());
      if (route === "evidence") {
        // N80 requires a real kernel to bind evidence. Admin passes authority,
        // then the unchanged commitment check refuses; no invented kernel or row.
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ stored: false, error: "kernel_mismatch" });
        expect(snapshot()).toEqual(before);
      } else {
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ updated: true, status: "in_progress" });
        expect(getRepos().jobs.findById(JOBS.B)).toMatchObject({ kernelId: null, status: "in_progress" });
        const after = snapshot();
        expect({ ...after, jobs: before.jobs }).toEqual(before);
        expect(after.jobs.filter((job) => job.id !== JOBS.B)).toEqual(before.jobs.filter((job) => job.id !== JOBS.B));
      }
    });

    it.each([JOBS.B, "job-n85-missing"])(`${route}: anonymous gets 401 before reading job %s without apiGate`, async (jobId) => {
      const before = snapshot();
      const read = vi.spyOn(getRepos().jobs, "findById");
      const res = await ungated.inject({ method: "POST", url: `/api/operator/${route}`, payload: {
        jobId, evidence: evidence("B"), status: "running",
      } });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(AUTHENTICATION_REQUIRED);
      expect(read).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
    });

    it(`${route}: a legacy job with no kernel is 403, even when the body names the caller's kernel`, async () => {
      getStore().db.run(sql`UPDATE jobs SET kernel_id = NULL WHERE id = ${JOBS.B}`);
      const before = snapshot();
      const res = await app.inject({ method: "POST", url: `/api/operator/${route}`, headers: bearer("A"), payload: {
        jobId: JOBS.B, kernelId: KERNELS.A, evidence: evidence("A"), status: "running",
      } });
      expect.soft(res.statusCode).toBe(403);
      expect.soft(res.json()).toMatchObject({ error: "forbidden", reason: "job_has_no_kernel" });
      expect(snapshot()).toEqual(before);
    });

    it(`${route}: unknown job keeps 200 job_not_found with no writes`, async () => {
      const before = snapshot();
      const res = await app.inject({ method: "POST", url: `/api/operator/${route}`, headers: bearer("A"), payload: {
        jobId: "job-n85-missing", kernelId: KERNELS.A, evidence: evidence("A"), status: "running",
      } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ warning: "job_not_found", [route === "evidence" ? "stored" : "updated"]: false });
      expect(snapshot()).toEqual(before);
    });

    it(`${route}: a caller's own kernelId in the body never authorizes B's job`, async () => {
      const before = snapshot();
      const res = await app.inject({ method: "POST", url: `/api/operator/${route}`, headers: route === "evidence" ? asProven("A") : bearer("A"), payload: {
        jobId: JOBS.B, kernelId: KERNELS.A, evidence: evidence("A"), status: "running",
      } });
      expect.soft(res.statusCode).toBe(403);
      expect.soft(res.json()).toMatchObject({ error: "forbidden", reason: route === "evidence" ? "operator_proof_required" : "not_kernel_operator" });
      expect(snapshot()).toEqual(before);
    });
  }

  it("evidence: the proven operator still gets 409 for a mismatched body kernel", async () => {
    const before = snapshot();
    const res = await app.inject({ method: "POST", url: "/api/operator/evidence", headers: asProven("B"), payload: {
      jobId: JOBS.B, kernelId: KERNELS.A, evidence: evidence("B"),
    } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "kernel_mismatch" });
    expect(snapshot()).toEqual(before);
  });

  it("job-status: reassignment after authority was checked cannot update the new kernel's job", async () => {
    const repos = getRepos();
    const findById = repos.jobs.findById.bind(repos.jobs);
    const { db } = getStore();
    const update = db.update.bind(db);
    let reassigned = false;
    vi.spyOn(db, "update").mockImplementation((table) => {
      if (table === schema.jobs && !reassigned) {
        reassigned = true;
        // The route and guarded writer read A; reassign immediately before their actual UPDATE.
        update(schema.jobs).set({ kernelId: KERNELS.B }).where(eq(schema.jobs.id, JOBS.A)).run();
      }
      return update(table);
    });
    const res = await request("job-status", "A", bearer("A"));
    expect.soft(res.statusCode).toBe(409);
    expect.soft(res.json()).toMatchObject({ error: "job_kernel_changed" });
    expect(findById(JOBS.A)).toMatchObject({ kernelId: KERNELS.B, status: "queued" });
  });
});

describe("N85 malformed target IDs fail before lookup", () => {
  const malformed = [[KERNELS.A], {}, true, false, 123, 0, ""];

  function watchLookups() {
    const job = vi.spyOn(getRepos().jobs, "findById");
    const kernel = vi.spyOn(getRepos().kernels, "findById");
    const select = vi.spyOn(getStore().db, "select");
    return {
      job,
      expectNoKernelRead() {
        expect(kernel).not.toHaveBeenCalled();
        expect(select.mock.calls.filter(([fields]) => fields && "operatorAddress" in fields)).toHaveLength(0);
      },
    };
  }

  it("jobs: repeated query kernelId is 400 before any target lookup or listing", async () => {
    const before = snapshot();
    const reads = watchLookups();
    const res = await app.inject({ method: "GET", url: `/api/operator/jobs?kernelId=${KERNELS.A}&kernelId=${KERNELS.A}`, headers: bearer("A") });
    expect(res.statusCode).toBe(400);
    expect(res.json().jobs).toBeUndefined();
    reads.expectNoKernelRead();
    expect(snapshot()).toEqual(before);
  });

  for (const route of ["heartbeat", "evidence", "job-status"] as const) {
    it.each([...malformed, null].map((id) => [id]))(`${route}: body kernelId %j is 400 before lookup`, async (kernelId) => {
      const before = snapshot();
      const reads = watchLookups();
      const res = await app.inject({ method: "POST", url: `/api/operator/${route}`, headers: asAdmin(), payload: {
        kernelId, jobId: JOBS.A, evidence: evidence("A"), status: "running",
      } });
      expect(res.statusCode).toBe(400);
      expect(reads.job).not.toHaveBeenCalled();
      reads.expectNoKernelRead();
      expect(snapshot()).toEqual(before);
    });
  }

  for (const route of ["evidence", "job-status"] as const) {
    it.each([...malformed, null].map((id) => [id]))(`${route}: jobId %j is 400 before lookup`, async (jobId) => {
      const before = snapshot();
      const reads = watchLookups();
      const res = await app.inject({ method: "POST", url: `/api/operator/${route}`, headers: asAdmin(), payload: {
        jobId, evidence: evidence("A"), status: "running",
      } });
      expect(res.statusCode).toBe(400);
      expect(reads.job).not.toHaveBeenCalled();
      reads.expectNoKernelRead();
      expect(snapshot()).toEqual(before);
    });

    it.each(malformed.map((id) => [id]))(`${route}: job row kernelId %j is 400 before a kernel lookup even for admin`, async (kernelId) => {
      const before = snapshot();
      const job = getRepos().jobs.findById(JOBS.A)!;
      const reads = watchLookups();
      reads.job.mockReturnValueOnce({ ...job, kernelId } as unknown as typeof job);
      const res = await request(route, "A", asAdmin());
      expect(res.statusCode).toBe(400);
      expect(reads.job).toHaveBeenCalledTimes(1);
      reads.expectNoKernelRead();
      expect(snapshot()).toEqual(before);
    });
  }
});
