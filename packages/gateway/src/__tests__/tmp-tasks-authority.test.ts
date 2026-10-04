/**
 * E11e (cross-family review of #560): the TMP task state that decides a proof's verdict (its tier, its
 * pipeline) must be authoritative and owner-bound. Nothing may come from the worker's submission or from
 * another caller's task creation (N118, restated by the steward in bus #6161). Until the gateway can
 * resolve a milestone's poster, only an admin creates a task (the steward's ruling on #6182).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Fastify, { type FastifyRequest } from "fastify";
import { tmpTaskRoutes, type TmpTaskRouteOptions } from "../routes/tmp-tasks.js";

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

/** An app whose requests carry the principal named in x-test-principal (what api-gate sets from a key). */
async function appWith(opts: TmpTaskRouteOptions) {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    const principal = req.headers["x-test-principal"];
    if (typeof principal === "string") (req as unknown as { operatorId: string }).operatorId = principal;
  });
  await app.register(tmpTaskRoutes, opts);
  return app;
}

const create = (app: Awaited<ReturnType<typeof appWith>>, milestone: string, principal: string | undefined, body: object) =>
  app.inject({
    method: "POST",
    url: `/api/milestones/${milestone}/tmp-task`,
    payload: body,
    headers: principal === undefined ? {} : { "x-test-principal": principal },
  });

describe("E11e HIGH 2: the accepted tier is owner-bound, authoritative task state", () => {
  const asAdmin = (app: Awaited<ReturnType<typeof appWith>>, milestone: string, body: object) =>
    app.inject({
      method: "POST",
      url: `/api/milestones/${milestone}/tmp-task`,
      payload: body,
      headers: { "x-test-principal": ADMIN, "x-test-admin": "yes" },
    });

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

  it("the gateway registers the route with the admin exception and no owner resolver", () => {
    // A source pin of the production wiring (server.ts), which no test boots: hasAdminScope decides, and
    // no milestoneOwner is wired until the caller's principal is proven (WP-A).
    const server = readFileSync(new URL("../server.ts", import.meta.url), "utf-8");
    expect(server).toContain("await app.register(tmpTaskRoutes, { isAdmin: hasAdminScope });");
    expect(server).not.toMatch(/tmpTaskRoutes,\s*\{[^}]*milestoneOwner/);
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
