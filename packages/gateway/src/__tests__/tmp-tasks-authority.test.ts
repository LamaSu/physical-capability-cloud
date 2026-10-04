/**
 * E11e (cross-family review of #560): the TMP task state that decides a proof's verdict (its tier, its
 * pipeline) must be authoritative and owner-bound. Nothing may come from the worker's submission or from
 * another caller's task creation (N118, restated by the steward in bus #6161). Until the gateway can
 * resolve a milestone's poster, only an admin creates a task (the steward's ruling on #6182).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyRequest } from "fastify";
import { tmpTaskRoutes, type TmpTaskRouteOptions } from "../routes/tmp-tasks.js";
import { FsTmpTaskStore, MemoryTmpTaskStore, type TmpTaskStore } from "../services/tmp-task-store.js";

const OWNER = "op-owner";
const OTHER = "op-other";
const ADMIN = "op-admin";
/** The tests' stand-in for the gateway's hasAdminScope: a header the test sets. */
const adminHeader = (req: FastifyRequest) => req.headers["x-test-admin"] === "yes";

const benchmark = (assuranceTier: unknown, proofType = "sensor_evidence") => ({
  mode: "benchmark",
  modeConfig: { mode: "benchmark", metricTarget: "dimensional_accuracy >= 0.95", proofType },
  assuranceTier,
});

/**
 * An app whose requests carry the principal named in x-test-principal (what api-gate sets from a key). It
 * gets a fresh in-memory task store unless the test passes one (or `store: undefined`).
 */
async function appWith(opts: TmpTaskRouteOptions) {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    const principal = req.headers["x-test-principal"];
    if (typeof principal === "string") (req as unknown as { operatorId: string }).operatorId = principal;
  });
  await app.register(tmpTaskRoutes, { store: new MemoryTmpTaskStore(), ...opts });
  return app;
}

const create = (app: Awaited<ReturnType<typeof appWith>>, milestone: string, principal: string | undefined, body: object) =>
  app.inject({
    method: "POST",
    url: `/api/milestones/${milestone}/tmp-task`,
    payload: body,
    headers: principal === undefined ? {} : { "x-test-principal": principal },
  });

const asAdmin = (app: Awaited<ReturnType<typeof appWith>>, milestone: string, body: object) =>
  app.inject({
    method: "POST",
    url: `/api/milestones/${milestone}/tmp-task`,
    payload: body,
    headers: { "x-test-principal": ADMIN, "x-test-admin": "yes" },
  });

/** A sensor_evidence submission whose bundle claims tier 0. */
const sensorSubmission = {
  proofType: "sensor_evidence",
  proof: { evidenceBundle: { events: [], bundleHash: `sha256:${"ab".repeat(32)}`, assuranceTier: 0 } },
  worker: "0x0000000000000000000000000000000000000002",
};

describe("E11e HIGH 2: the accepted tier is owner-bound, authoritative task state", () => {
  it("without an owner resolver only an admin creates a task, once; everyone else is refused (#6182)", async () => {
    const app = await appWith({ isAdmin: adminHeader });
    const refused = await create(app, "m-1", OWNER, benchmark(3));
    expect(refused.statusCode, "a non-admin, even the poster").toBe(403);
    expect(refused.json().error).toBe("admin_only");
    expect((await asAdmin(app, "m-1", benchmark(3))).statusCode, "an admin").toBe(201);
    expect((await asAdmin(app, "m-1", benchmark(0))).statusCode, "an admin again: write-once binds admins too").toBe(409);
    expect((await create(app, "m-1", OTHER, benchmark(0))).statusCode, "a non-admin after").toBe(403);
    const read = await app.inject({ method: "GET", url: "/api/milestones/m-1/tmp-task" });
    expect(read.json().task.acceptedTier).toBe(3);
    // The admin's request still needs a tier.
    expect((await asAdmin(app, "m-2", benchmark(undefined))).statusCode).toBe(400);
    await app.close();
  });

  it("the admin check fails closed: no isAdmin, a throwing one, or any answer but true is no admin", async () => {
    const answers: Array<TmpTaskRouteOptions["isAdmin"]> = [
      undefined,
      () => { throw new Error("key store unavailable"); },
      async () => { throw new Error("key store unavailable"); },
      () => "yes" as unknown as boolean,
      async () => 1 as unknown as boolean,
      () => false,
    ];
    for (const isAdmin of answers) {
      const app = await appWith(isAdmin === undefined ? {} : { isAdmin });
      const res = await asAdmin(app, "m-1", benchmark(3));
      expect(res.statusCode, String(isAdmin)).toBe(403);
      expect(res.json().error).toBe("admin_only");
      await app.close();
    }
  });

  it("with an owner resolver wired, the admin exception no longer applies: only the owner creates", async () => {
    const app = await appWith({ milestoneOwner: () => OWNER, isAdmin: () => true });
    expect((await asAdmin(app, "m-1", benchmark(3))).statusCode).toBe(403);
    expect((await create(app, "m-1", OWNER, benchmark(3))).statusCode).toBe(201);
    await app.close();
  });

  it("the gateway registers the route with the admin exception, the durable store, and no owner resolver", () => {
    // A source pin of the production wiring (server.ts), which no test boots: hasAdminScope decides, the
    // durable store holds the tasks (E11f), and no milestoneOwner is wired until the caller's principal
    // is proven (WP-A).
    const server = readFileSync(new URL("../server.ts", import.meta.url), "utf-8");
    expect(server).toContain("await app.register(tmpTaskRoutes, { isAdmin: hasAdminScope, store: new FsTmpTaskStore() });");
    expect(server).not.toMatch(/tmpTaskRoutes,\s*\{[^}]*milestoneOwner/);
    expect(server).not.toMatch(/MemoryTmpTaskStore/);
  });

  it("an unauthenticated caller cannot create a task", async () => {
    const app = await appWith({ milestoneOwner: () => OWNER });
    expect((await create(app, "m-1", undefined, benchmark(3))).statusCode).toBe(401);
    const adminOnly = await appWith({ isAdmin: () => true });
    expect((await create(adminOnly, "m-1", undefined, benchmark(3))).statusCode).toBe(401);
    await adminOnly.close();
    await app.close();
  });

  it("only the milestone's owner creates its task, once; another caller cannot replace or downgrade it", async () => {
    const app = await appWith({ milestoneOwner: (m) => (m === "m-1" ? OWNER : null) });
    expect((await create(app, "m-1", OTHER, benchmark(0))).statusCode, "a non-owner first").toBe(403);
    expect((await create(app, "m-1", OWNER, benchmark(3))).statusCode, "the owner").toBe(201);
    expect((await create(app, "m-1", OTHER, benchmark(0))).statusCode, "a non-owner after").toBe(403);
    expect((await create(app, "m-1", OWNER, benchmark(0))).statusCode, "the owner again").toBe(409);
    const read = await app.inject({ method: "GET", url: "/api/milestones/m-1/tmp-task" });
    expect(read.json().task.acceptedTier).toBe(3);
    // A milestone the resolver does not know has no owner, so nobody can create its task.
    expect((await create(app, "m-unknown", OWNER, benchmark(3))).statusCode).toBe(403);
    // A resolver that throws is no owner either.
    const throwing = await appWith({ milestoneOwner: () => { throw new Error("chain unavailable"); } });
    expect((await create(throwing, "m-1", OWNER, benchmark(3))).statusCode).toBe(403);
    await throwing.close();
    await app.close();
  });

  it("a task needs a tier: a missing or non-tier assuranceTier is refused", async () => {
    const app = await appWith({ milestoneOwner: () => OWNER });
    for (const tier of [undefined, null, "3", 4, -1, 1.5]) {
      expect((await create(app, `m-tier-${String(tier)}`, OWNER, benchmark(tier))).statusCode, String(tier)).toBe(400);
    }
    await app.close();
  });
});

describe("E11e HIGH 1: the worker never chooses the proof pipeline", () => {
  it("a Merkle submission (even root === leaf, empty path) against a sensor_evidence task is refused", async () => {
    const app = await appWith({ milestoneOwner: () => OWNER });
    expect((await create(app, "m-2", OWNER, benchmark(3, "sensor_evidence"))).statusCode).toBe(201);
    const leaf = `sha256:${"cd".repeat(32)}`;
    const res = await app.inject({
      method: "POST",
      url: "/api/milestones/m-2/tmp-validate",
      payload: { proofType: "merkle_commitment", proof: { merkleRoot: leaf, leaf, path: [], indices: [] }, worker: "0x0000000000000000000000000000000000000002" },
    });
    const json = res.json();
    expect(json.result?.valid ?? json.validationResult?.valid ?? false).toBe(false);
    expect(JSON.stringify(json)).toMatch(/task_pipeline/);
    await app.close();
  });

  it("a submission on the task's own pipeline reaches the verifier, judged at the task's tier", async () => {
    const app = await appWith({ milestoneOwner: () => OWNER });
    expect((await create(app, "m-3", OWNER, benchmark(2, "sensor_evidence"))).statusCode).toBe(201);
    const res = await app.inject({
      method: "POST",
      url: "/api/milestones/m-3/tmp-validate",
      payload: { proofType: "sensor_evidence", proof: { evidenceBundle: { events: [], bundleHash: `sha256:${"ab".repeat(32)}`, assuranceTier: 0 } }, worker: "0x0000000000000000000000000000000000000002" },
    });
    const findings: Array<{ check: string; passed: boolean }> = res.json().result.findings;
    expect(findings.some((f) => f.check === "task_pipeline")).toBe(false);
    // The task's tier 2 chooses the evidence (its camera requirement), not the bundle's claimed tier 0.
    expect(findings.some((f) => f.check === "tier_requirement_cv_inspection_result_or_camera_snapshot")).toBe(true);
    await app.close();
  });
});

describe("E11f HIGH 1: a task is durable and write-once, across restarts and app instances", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tmp-tasks-route-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("the reproduction: a second app, or a restart, on the gateway's volume can't create the milestone again", async () => {
    const before = await appWith({ isAdmin: adminHeader, store: new FsTmpTaskStore(dir) });
    expect((await asAdmin(before, "m-1", benchmark(3))).statusCode).toBe(201);
    await before.close();
    // A restart: a new process's store over the same volume directory.
    const after = await appWith({ isAdmin: adminHeader, store: new FsTmpTaskStore(dir) });
    const again = await asAdmin(after, "m-1", benchmark(0));
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("task_exists");
    expect((await after.inject({ method: "GET", url: "/api/milestones/m-1/tmp-task" })).json().task.acceptedTier).toBe(3);
    // Validation after the restart is judged at the stored tier 3 (its TEE requirement), not 0.
    const v = await after.inject({ method: "POST", url: "/api/milestones/m-1/tmp-validate", payload: sensorSubmission });
    const findings: Array<{ check: string }> = v.json().result.findings;
    expect(findings.some((f) => f.check === "tier_requirement_tee_attestation")).toBe(true);
    await after.close();
  });

  it("two apps sharing the volume: only one creation wins", async () => {
    const a = await appWith({ isAdmin: adminHeader, store: new FsTmpTaskStore(dir) });
    const b = await appWith({ isAdmin: adminHeader, store: new FsTmpTaskStore(dir) });
    const codes = await Promise.all([asAdmin(a, "m-2", benchmark(3)), asAdmin(b, "m-2", benchmark(0))]).then((r) => r.map((x) => x.statusCode).sort());
    expect(codes).toEqual([201, 409]);
    await a.close();
    await b.close();
  });

  it("without a store, no task is created and none is read: the routes fail closed", async () => {
    const app = await appWith({ isAdmin: adminHeader, store: undefined });
    const res = await asAdmin(app, "m-1", benchmark(3));
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("task_store_unavailable");
    expect((await app.inject({ method: "GET", url: "/api/milestones/m-1/tmp-task" })).statusCode).toBe(404);
    await app.close();
  });

  it("a store that can't be written or read fails closed", async () => {
    const broken: TmpTaskStore = {
      get: async () => {
        throw new Error("volume unavailable");
      },
      createOnce: async () => {
        throw new Error("volume unavailable");
      },
    };
    const app = await appWith({ isAdmin: adminHeader, store: broken });
    expect((await asAdmin(app, "m-1", benchmark(3))).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/api/milestones/m-1/tmp-task" })).statusCode).toBe(503);
    expect((await app.inject({ method: "POST", url: "/api/milestones/m-1/tmp-validate", payload: sensorSubmission })).statusCode).toBe(503);
    await app.close();
  });

  it("lifecycle status is this process's view; the stored terms are what a restart keeps", async () => {
    const before = await appWith({ isAdmin: adminHeader, store: new FsTmpTaskStore(dir) });
    expect((await asAdmin(before, "m-c", { mode: "claim", modeConfig: { mode: "claim" }, assuranceTier: 1 })).statusCode).toBe(201);
    await before.inject({ method: "POST", url: "/api/milestones/m-c/tmp-claim", payload: { worker: "0x0000000000000000000000000000000000000002" } });
    expect((await before.inject({ method: "GET", url: "/api/milestones/m-c/tmp-task" })).json().task.status).toBe("active");
    await before.close();
    const after = await appWith({ isAdmin: adminHeader, store: new FsTmpTaskStore(dir) });
    const read = (await after.inject({ method: "GET", url: "/api/milestones/m-c/tmp-task" })).json().task;
    expect(read.status).toBe("pending");
    expect(read.acceptedTier).toBe(1);
    await after.close();
  });
});

describe("E11f MEDIUM: a benchmark task can't be created on a pipeline that can't enforce its tier", () => {
  it("zk_proof, merkle_commitment, a missing or an unknown pipeline is refused; the three enforcing ones are created", async () => {
    const app = await appWith({ isAdmin: adminHeader });
    // Built by hand: benchmark()'s default would turn a missing pipeline into sensor_evidence.
    const onPipeline = (proofType: string | undefined) => ({
      mode: "benchmark",
      modeConfig: { mode: "benchmark", metricTarget: "dimensional_accuracy >= 0.95", ...(proofType === undefined ? {} : { proofType }) },
      assuranceTier: 1,
    });
    for (const proofType of ["zk_proof", "merkle_commitment", undefined, "nonsense"]) {
      const res = await asAdmin(app, `m-${String(proofType)}`, onPipeline(proofType));
      expect(res.statusCode, String(proofType)).toBe(400);
      expect(res.json().error, String(proofType)).toBe("pipeline_unenforceable");
    }
    for (const proofType of ["sensor_evidence", "bittensor_verification", "oracle_verification"]) {
      expect((await asAdmin(app, `m-${proofType}`, benchmark(1, proofType))).statusCode, proofType).toBe(201);
    }
    await app.close();
  });
});
