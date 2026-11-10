/** The jobs poll carries the kernel's stop state and fails closed before dispatch. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { schema, sql } from "@pcc/store";
import { executionPhaseOf } from "@pcc/spec";
import { AUTHENTICATION_REQUIRED } from "../auth/kernel-authority.js";
import { provisionApiKey, resolveApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { getJobFacade } from "../facades/index.js";
import { emergencyStopState } from "../routes/device-relay.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { operatorRoutes } from "../routes/operator.js";
import { POLICY_CASES } from "./helpers/emergency-stop-policy-cases.js";

const ADMIN = "operator-poll-estop-admin";
const KERNELS = { A: "kernel-poll-estop-a", B: "kernel-poll-estop-b" };
const OPERATORS = { A: "operator-poll-estop-a", B: "operator-poll-estop-b" };
const QUEUED = { A: "job-poll-estop-queued-a", B: "job-poll-estop-queued-b" };
const RUNNING = "job-poll-estop-running-a";
const keys = { A: "", B: "" };
type Operator = keyof typeof KERNELS;
const bearer = (operator: Operator) => ({ authorization: `Bearer ${keys[operator]}` });
let app: FastifyInstance;

function poll(operator: Operator = "A", status?: string | readonly string[]) {
  const query = new URLSearchParams({ kernelId: KERNELS[operator] });
  if (status !== undefined) {
    for (const value of typeof status === "string" ? [status] : status) query.append("status", value);
  }
  return app.inject({
    method: "GET", headers: bearer(operator),
    url: `/api/operator/jobs?${query}`,
  });
}

function storePolicyJSON(policyJSON: string, operator: Operator = "A") {
  // Write JSON text directly: Drizzle otherwise binds JS null as SQL NULL, which is forbidden.
  getStore().db.run(sql`INSERT INTO operator_policies (kernel_id, policy, updated_at, updated_by)
    VALUES (${KERNELS[operator]}, ${policyJSON}, '2026-10-10T12:00:00.000Z', 'poll-estop-test')`);
}

function storePolicy(policy: unknown, operator: Operator = "A") {
  storePolicyJSON(JSON.stringify(policy), operator);
}

async function stop(operator: Operator = "A") {
  const res = await app.inject({
    method: "POST", url: "/api/operator/emergency-stop", headers: bearer(operator),
    payload: { kernelId: KERNELS[operator], reason: "poll contract test" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ stopped: true, kernelId: KERNELS[operator] });
}

/** Observe/fail only policy reads; key resolution, kernel authority and job reads remain real. */
function watchPolicyReads(options: { throwPolicy?: boolean; throwAuthority?: boolean } = {}) {
  const { db } = getStore();
  const select = db.select.bind(db);
  const reads = vi.fn();
  vi.spyOn(db, "select").mockImplementation((fields) => {
    if (options.throwAuthority && fields && "operatorAddress" in fields) throw new Error("kernel authority read failed");
    const query = select(fields);
    const from = query.from.bind(query);
    vi.spyOn(query, "from").mockImplementation((table) => {
      if (table === schema.operatorPolicies) {
        reads();
        if (options.throwPolicy) throw new Error("operator policy read failed");
      }
      return from(table);
    });
    return query;
  });
  return reads;
}

const CLOSED_STATES = ["stopped", "unavailable"] as const;
const STATUS_QUERIES = [
  { label: "absent", status: undefined },
  { label: "queued", status: "queued" },
  { label: "uppercase", status: "QUEUED" },
  { label: "repeated queued", status: ["queued", "queued"] },
  { label: "whitespace", status: " queued " },
  { label: "mixed case", status: "QueUeD" },
  { label: "empty", status: "" },
  { label: "scheduled phase alias", status: "scheduled" },
  { label: "active phase alias", status: "ACTIVE" },
  { label: "other filter", status: "running" },
];

function storeClosedState(state: typeof CLOSED_STATES[number]) {
  storePolicy(state === "stopped" ? { emergencyStop: true } : null);
}

beforeAll(async () => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_ADMIN_KEY", ADMIN);
  closeStore();
  initStore({ seed: true });
  const repos = getRepos();
  const kernel = repos.kernels.findAll()[0]!;
  const capability = repos.capabilities.findAll()[0]!;
  const job = repos.jobs.findAll()[0]!;
  for (const operator of ["A", "B"] as const) {
    keys[operator] = provisionApiKey({ operatorId: OPERATORS[operator], scopes: ["*"] }).rawKey;
    repos.kernels.insert({ ...kernel, id: KERNELS[operator], operatorAddress: OPERATORS[operator] });
    repos.capabilities.insert({ ...capability, id: `cap-poll-estop-${operator}`, kernelId: KERNELS[operator] });
    repos.jobs.insert({
      ...job, id: QUEUED[operator], kernelId: KERNELS[operator], capabilityId: `cap-poll-estop-${operator}`,
      cwmId: `cwm-poll-estop-${operator}`, status: "queued", completedAt: null, evidenceBundleId: null,
    });
  }
  repos.jobs.insert({
    ...repos.jobs.findById(QUEUED.A)!, id: RUNNING, status: "running",
  });
  app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const key = resolveApiKey(req);
    if (key) req.operatorId = key.operatorId;
  });
  await app.register(operatorRelayRoutes);
  await app.register(operatorRoutes);
  await app.ready();
});

beforeEach(() => {
  getStore().db.delete(schema.operatorPolicies).run();
  for (const operator of ["A", "B"] as const) getRepos().jobs.update(QUEUED[operator], { status: "queued" });
  getRepos().jobs.update(RUNNING, { status: "running" });
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await app.close();
  closeStore();
  vi.unstubAllEnvs();
});

describe("GET /api/operator/jobs emergency-stop contract", () => {
  it.each([undefined, "queued"])("real stop blocks queued jobs and real resume restores them (status=%s)", async (status) => {
    expect(getRepos().jobs.findByKernelAndStatus(KERNELS.A, "queued").map((job) => job.id)).toEqual([QUEUED.A]);
    await stop();
    const stopped = await poll("A", status);
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toEqual({ emergencyStop: "stopped", jobs: [] });
    // The stop withholds the queue; it does not delete or transition the jobs.
    expect(getRepos().jobs.findById(QUEUED.A)?.status).toBe("queued");
    const resumed = await app.inject({
      method: "POST", url: "/api/operator/emergency-resume", headers: { ...bearer("A"), "x-admin-key": ADMIN },
      payload: { kernelId: KERNELS.A },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ resumed: true, kernelId: KERNELS.A });
    const clear = await poll("A", status);
    expect(clear.statusCode).toBe(200);
    expect(clear.json().emergencyStop).toBe("clear");
    expect(clear.json().jobs.map((job: { id: string }) => job.id)).toEqual([QUEUED.A]);
  });

  it.each(POLICY_CASES)("poll and device relay agree for $label", async ({ state, policy, malformedJSON, throwingRead }) => {
    if (policy !== undefined) storePolicy(policy);
    if (malformedJSON) storePolicyJSON("{");
    const reads = throwingRead ? watchPolicyReads({ throwPolicy: true }) : undefined;
    const canonicalState = emergencyStopState(KERNELS.A);
    expect(canonicalState).toBe(state);
    const res = await poll();
    expect(res.statusCode).toBe(200);
    expect(res.json().emergencyStop).toBe(canonicalState);
    expect(res.json().jobs.map((job: { id: string }) => job.id)).toEqual(state === "clear" ? [QUEUED.A] : []);
    if (reads) expect(reads).toHaveBeenCalledTimes(2);
  });

  describe.each(CLOSED_STATES)("%s queued suppression", (state) => {
    it.each(STATUS_QUERIES)("filters queued phases from a mixed list for $label query", async ({ status }) => {
      const facade = getJobFacade();
      const list = await facade.list({ kernelId: KERNELS.A });
      if (!list.success) throw new Error("fixture job list failed");
      const queued = list.data.items.find((job) => job.id === QUEUED.A)!;
      const running = list.data.items.find((job) => job.id === RUNNING)!;
      const items = [
        queued,
        ...["QUEUED", " QueUeD ", "scheduled", " ACTIVE "].map((status, index) => ({
          ...queued, id: `job-poll-estop-legacy-${index}`, status: status as typeof queued.status,
        })),
        running,
      ];
      vi.spyOn(facade, "list").mockResolvedValue({ success: true, data: { ...list.data, items } });
      // Supply a real mixed facade result for every query, including repeated and
      // empty parameters, so an empty repository match cannot hide a gate bypass.
      const before = await poll("A", status);
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({ emergencyStop: "clear", jobs: items });
      storeClosedState(state);
      const res = await poll("A", status);
      expect(res.statusCode).toBe(200);
      expect(res.json().emergencyStop).toBe(state);
      expect(res.json().jobs.some((job: { status: unknown }) => executionPhaseOf(job.status) === "queued")).toBe(false);
      // The default queue-only poll may return early. Other filters preserve
      // non-queued jobs even if their result also contains queued work.
      if (status === undefined || status === "queued") {
        expect(res.json().jobs.every((job: { id: string }) => job.id === RUNNING)).toBe(true);
      } else {
        expect(res.json().jobs).toEqual([running]);
      }
    });

    it.each(["queued", "QUEUED", " QueUeD ", "scheduled", " ACTIVE ", ""])("withholds real queued-phase rows selected by status=%j", async (status) => {
      getRepos().jobs.update(QUEUED.A, { status: status || "queued" });
      const before = await poll("A", status);
      expect(before.statusCode).toBe(200);
      expect(before.json().emergencyStop).toBe("clear");
      expect(before.json().jobs.some((job: { id: string }) => job.id === QUEUED.A)).toBe(true);
      storeClosedState(state);
      const res = await poll("A", status);
      expect(res.statusCode).toBe(200);
      expect(res.json().emergencyStop).toBe(state);
      expect(res.json().jobs.some((job: { status: unknown }) => executionPhaseOf(job.status) === "queued")).toBe(false);
      if (status === "") expect(res.json().jobs.map((job: { id: string }) => job.id)).toEqual([RUNNING]);
      else expect(res.json().jobs).toEqual([]);
    });

    it.each(["running", "in_progress", "completed"])("preserves the %s list with its state", async (status) => {
      getRepos().jobs.update(RUNNING, { status });
      const before = await poll("A", status);
      expect(before.statusCode).toBe(200);
      expect(before.json().emergencyStop).toBe("clear");
      expect(before.json().jobs.map((job: { id: string }) => job.id)).toEqual([RUNNING]);
      storeClosedState(state);
      const res = await poll("A", status);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ emergencyStop: state, jobs: before.json().jobs });
    });
  });

  it("reads the stop per kernel, leaving another kernel's queue clear", async () => {
    await stop("A");
    expect((await poll("A")).json()).toEqual({ emergencyStop: "stopped", jobs: [] });
    const other = await poll("B");
    expect(other.statusCode).toBe(200);
    expect(other.json().emergencyStop).toBe("clear");
    expect(other.json().jobs.map((job: { id: string }) => job.id)).toEqual([QUEUED.B]);
  });

  it.each(["clear", ...CLOSED_STATES])("includes %s on the existing 200 job-list failure fallback", async (state) => {
    if (state !== "clear") storeClosedState(state);
    vi.spyOn(getRepos().jobs, "findByKernelAndStatus").mockImplementation(() => { throw new Error("job list failed"); });
    // A non-queued read reaches the facade even when the stop is not clear.
    const res = await poll("A", "running");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ emergencyStop: state, jobs: [] });
  });

  it.each([401, 403, 404, 503])("preserves the %s refusal without reading or exposing policy state", async (status) => {
    storePolicy({ emergencyStop: true });
    const reads = watchPolicyReads({ throwPolicy: true, throwAuthority: status === 503 });
    const expected = status === 401 ? AUTHENTICATION_REQUIRED
      : status === 403 ? { error: "forbidden", reason: "not_kernel_operator", message: "Only this kernel's operator or the gateway admin may do this." }
      : status === 404 ? { error: "kernel_not_found", message: "No kernel with this id is registered." }
      : { error: "read_failed", message: "The kernel could not be read to check who operates it. Try again shortly." };
    const res = await app.inject({
      method: "GET", url: `/api/operator/jobs?kernelId=${status === 404 ? "kernel-poll-estop-missing" : KERNELS.A}`,
      headers: status === 401 ? {} : bearer(status === 403 ? "B" : "A"),
    });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual(expected);
    expect(res.json()).not.toHaveProperty("emergencyStop");
    expect(reads).not.toHaveBeenCalled();
  });
});
