/**
 * Carrier config gate: FAIL AT THE REQUEST, NOT AT BOOT.
 *
 * Regression for the defect that reddened master CI on 2026-09-02. server.ts registers
 * carrierRoutes UNCONDITIONALLY, and carrierRoutes used to `throw` during registration when
 * production config was incomplete. Composed, that meant a missing shipping-vendor credential
 * took down the ENTIRE gateway — including deployments that will never mail anything
 * (printing-only, CNC-only) — and staging, which boots in production mode without EasyPost
 * credentials, served 502 on every route until the deploy-staging smoke test gave up.
 *
 * The safety property is NOT relaxed by the fix and is asserted here: it must remain
 * impossible to buy a label or admit a carrier scan without real credentials. What changed is
 * only the blast radius — the mail capability goes unavailable and SAYS SO, instead of the
 * process refusing to start.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { carrierRoutes } from "../routes/carrier.js";
import {
  _resetCarrierShipmentStoreForTests,
  initCarrierShipmentStore,
  getCarrierShipmentStore,
  type SqliteDatabaseLike,
} from "../services/carrier-shipment-store.js";
import { EasyPostClient, _setEasyPostClientForTests } from "../services/easypost-client.js";
import { initSigningKey, _resetForTests as _resetSigningKeyForTests } from "../signing-key.js";
import { initStore, closeStore, getStore } from "../db.js";

const CARRIER_ENV = ["EASYPOST_API_KEY", "EASYPOST_WEBHOOK_SECRET", "PCC_AGENT_CARD_SIGNING_KEY"] as const;

let savedNodeEnv: string | undefined;
const savedCarrierEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
});
afterAll(() => closeStore());

beforeEach(() => {
  savedNodeEnv = process.env.NODE_ENV;
  for (const k of CARRIER_ENV) {
    savedCarrierEnv[k] = process.env[k];
    delete process.env[k];
  }
  _resetCarrierShipmentStoreForTests();
  initCarrierShipmentStore({});
});

afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  for (const k of CARRIER_ENV) {
    if (savedCarrierEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedCarrierEnv[k] as string;
  }
  _resetCarrierShipmentStoreForTests();
  _resetSigningKeyForTests();
  _setEasyPostClientForTests(undefined);
});

/**
 * Readiness is recomputed PER REQUEST (sol #316 review, finding 3) — NODE_ENV and the
 * config env vars are read live, so tests may flip them after register() and the very
 * next request sees the change. `undefined` DELETES NODE_ENV, which must classify as
 * production (finding 2: fail-closed default).
 */
async function buildApp(nodeEnv: string | undefined): Promise<FastifyInstance> {
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  const app = Fastify({ logger: false });
  await app.register(carrierRoutes);
  await app.ready();
  return app;
}

/** buildApp + the x-test-operator auth hook carrier.test.ts uses, so authed paths are reachable. */
async function buildAuthedApp(nodeEnv: string | undefined): Promise<FastifyInstance> {
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const h = req.headers["x-test-operator"];
    if (typeof h === "string" && h) (req as unknown as { operatorId?: string }).operatorId = h;
  });
  await app.register(carrierRoutes);
  await app.ready();
  return app;
}

/**
 * Configure ALL FOUR requirements for real: env keys, a real ES256 (P-256) signing key
 * loaded into the active module cache, and a DURABLE store on the shared :memory: SQLite
 * handle (the same $client trick server.ts uses). From here a test can knock out exactly
 * one requirement and prove the guard names exactly that one.
 */
async function configureAllFour(): Promise<void> {
  process.env.EASYPOST_API_KEY = "EZTK_test_fully_configured";
  process.env.EASYPOST_WEBHOOK_SECRET = "whsec_test_fully_configured";
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.PCC_AGENT_CARD_SIGNING_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  _resetSigningKeyForTests();
  await initSigningKey();
  const raw = (getStore().db as unknown as { $client?: SqliteDatabaseLike }).$client;
  if (!raw) throw new Error("test rig: no raw SQLite handle on the store");
  _resetCarrierShipmentStoreForTests();
  initCarrierShipmentStore({ sqlite: raw, strictHydration: true });
}

describe("carrier config gate — production, nothing configured", () => {
  it("REGISTERS without throwing (the regression: this used to kill the whole gateway)", async () => {
    // The assertion is that this line does not reject. A throw here is the 502.
    const app = await buildApp("production");
    expect(app).toBeTruthy();
    await app.close();
  });

  it("keeps /api/carrier/healthz serving, so ops can see WHAT is unconfigured", async () => {
    const app = await buildApp("production");
    try {
      const res = await app.inject({ method: "GET", url: "/api/carrier/healthz" });
      // NOT 500. getEasyPostClient() throws mock_forbidden_in_production here
      // (easypost-client.ts:385, requireProductionMode derived from NODE_ENV at :850), so an
      // eager call made healthz die in exactly the case an operator is trying to diagnose.
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // ok reflects CAPABILITY usability, not merely "the handler ran".
      expect(body.ok).toBe(false);
      expect(body.configured).toBe(false);
      // It must name what is missing, or it is a dead end for whoever is on call.
      expect(Array.isArray(body.missingConfig)).toBe(true);
      expect(body.missingConfig.join(" ")).toContain("EASYPOST_API_KEY");
      // Proves the degradation path actually fired rather than the client happening to build.
      expect(typeof body.clientError).toBe("string");
      // Visibility that existed before the fix must survive it.
      expect(body).toHaveProperty("webhookConfigured");
      expect(body).toHaveProperty("commitmentSigningConfigured");
      expect(body).toHaveProperty("durable");
    } finally {
      await app.close();
    }
  });

  it("FAILS CLOSED on the webhook — evidence cannot be admitted without real config", async () => {
    const app = await buildApp("production");
    try {
      const body = JSON.stringify({ id: "e", description: "tracker.updated", result: { tracking_code: "EZ_X", status: "in_transit" } });
      const res = await app.inject({
        method: "POST",
        url: "/api/carrier/webhook/easypost",
        payload: body,
        headers: { "content-type": "application/json", "x-hmac-signature": "hmac-sha256-hex=deadbeef" },
      });
      expect(res.statusCode).toBe(503);
      const json = res.json();
      expect(json.error).toBe("carrier_not_configured");
      // REDACTED for this one route (sol #316 review, finding 5): the webhook is public —
      // HMAC is its auth, so its gate answers ANONYMOUS callers and must not hand them the
      // missing[] posture (signing-key + storage-durability status). The actionable detail
      // is not lost: authenticated healthz reports it (asserted above), as do the logs.
      expect(json).not.toHaveProperty("missing");
      expect(typeof json.message).toBe("string");
    } finally {
      await app.close();
    }
  });

  it("FAILS CLOSED on the money route rather than reaching label purchase", async () => {
    const app = await buildApp("production");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/carrier/shipments",
        payload: { jobId: "job-1", kernelId: "k-1", documentHash: "a".repeat(64) },
        headers: { "content-type": "application/json" },
      });
      // Unauthenticated, so 401 is correct and is still fail-closed — the point is that it is
      // NEVER 2xx, i.e. no label can be bought on this deployment.
      expect([401, 503]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("carrier config gate — non-production is untouched", () => {
  it("does not gate outside production, so every existing suite behaves exactly as before", async () => {
    const app = await buildApp("test");
    try {
      const res = await app.inject({ method: "GET", url: "/api/carrier/healthz" });
      expect(res.statusCode).toBe(200);
      // Pins the behaviour carrier.test.ts already asserts (ok: true in test mode), so the
      // ok-semantics change cannot silently regress the existing suite.
      expect(res.json().ok).toBe(true);
      expect(res.json().configured).toBe(true);
      // No carrier_not_configured anywhere in dev/test: the gate is production-only, which is
      // why this change cannot alter the behaviour the other carrier suites assert.
      const evidence = await app.inject({ method: "GET", url: "/api/carrier/shipments/job-1/evidence" });
      expect(evidence.statusCode).not.toBe(503);
    } finally {
      await app.close();
    }
  });
});

/**
 * sol cross-family review of #316 (bulletin #1548), finding 1: the config guard was placed on
 * the /:jobId/evidence seam but NOT on the plain /:jobId detail route, whose toShipmentDTO
 * carries the SAME commitment + events. An authenticated owner could pull spec-shaped carrier
 * evidence from an unconfigured deployment holding prior records, and a kernel could fold it into
 * a signed bundle — bypassing the 503 the evidence route returns. These tests are AUTHENTICATED
 * and run against a SEEDED record (addressing the same review's finding 4: the pre-existing
 * unconfigured test is unauthenticated, so it would still pass if the guard were deleted). With
 * the owner matching the record, the detail route would return 200 with the full DTO if the guard
 * were removed — so a 503 here proves the guard specifically, not the owner check.
 */
describe("carrier config gate — evidence egress is guarded on EVERY route (sol #316 review, finding 1)", () => {
  const OWNER = "0xownerguardtest";
  const KERNEL = "kernel-guard-test";
  const JOB = "job-guard-test";

  // Production gate active AND test-auth wired, so the guard is exercised for a real
  // authenticated owner rather than short-circuited at the 401. NODE_ENV is restored by
  // the file-level afterEach.
  const buildAuthedProdApp = () => buildAuthedApp("production");

  it("503s GET /:jobId for an authed owner WITH a seeded record — commitment+events must not egress unconfigured", async () => {
    const app = await buildAuthedProdApp();
    try {
      // sol's exact scenario: a durable store still holds a prior record after the key is gone.
      getCarrierShipmentStore().reserve({ jobId: JOB, kernelId: KERNEL, ownerId: OWNER, requestFingerprint: "seeded-for-guard-test" });
      const res = await app.inject({ method: "GET", url: `/api/carrier/shipments/${JOB}`, headers: { "x-test-operator": OWNER } });
      expect(res.statusCode).toBe(503); // 200 (full DTO) if the guard were absent — the owner matches
      expect(res.json().error).toBe("carrier_not_configured");
      expect(Array.isArray(res.json().missing)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("503s GET /:jobId/evidence identically — regression lock on the route that WAS guarded", async () => {
    const app = await buildAuthedProdApp();
    try {
      getCarrierShipmentStore().reserve({ jobId: JOB, kernelId: KERNEL, ownerId: OWNER, requestFingerprint: "seeded-for-guard-test" });
      const res = await app.inject({ method: "GET", url: `/api/carrier/shipments/${JOB}/evidence`, headers: { "x-test-operator": OWNER } });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("carrier_not_configured");
    } finally {
      await app.close();
    }
  });
});

/**
 * sol #316 review, finding 2: the gate used to run ONLY when NODE_ENV === "production" —
 * one misclassification (unset, typo'd, "staging") and the ENTIRE 4-requirement gate was
 * off: money could move and mock evidence could flow on a box that merely forgot an env
 * var. Production is now the fail-closed DEFAULT (isCarrierProductionEnv): only an
 * explicit NODE_ENV of "test" or "development" opts out.
 */
describe("carrier config gate — production is the fail-closed DEFAULT (sol #316 review, finding 2)", () => {
  it("gates when NODE_ENV is UNSET — forgetting the env var must select the STRICT mode", async () => {
    const app = await buildAuthedApp(undefined);
    try {
      const health = await app.inject({ method: "GET", url: "/api/carrier/healthz" });
      expect(health.json().configured).toBe(false);
      const res = await app.inject({
        method: "GET",
        url: "/api/carrier/shipments/job-noenv/evidence",
        headers: { "x-test-operator": "0xanyowner" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("carrier_not_configured");
    } finally {
      await app.close();
    }
  });

  it("gates on a MISTYPED NODE_ENV ('staging') — unrecognized values are production, not permissive", async () => {
    const app = await buildAuthedApp("staging");
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/carrier/shipments/job-mistyped",
        headers: { "x-test-operator": "0xanyowner" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("carrier_not_configured");
    } finally {
      await app.close();
    }
  });

  it("does NOT gate under an explicit NODE_ENV=development — the recognized opt-out still works", async () => {
    const app = await buildAuthedApp("development");
    try {
      const health = await app.inject({ method: "GET", url: "/api/carrier/healthz" });
      expect(health.json().configured).toBe(true);
      const res = await app.inject({
        method: "GET",
        url: "/api/carrier/shipments/job-dev/evidence",
        headers: { "x-test-operator": "0xanyowner" },
      });
      expect(res.statusCode).not.toBe(503);
    } finally {
      await app.close();
    }
  });
});

/**
 * sol #316 review, finding 3: readiness was SNAPSHOTTED at plugin registration — config
 * that disappeared after boot kept passing the guard, and a vanished signing key silently
 * stopped signature verification on admitted evidence. Readiness is now recomputed on
 * EVERY request, proven here by flipping config between two requests on one live app.
 */
describe("carrier config gate — readiness is recomputed PER REQUEST (sol #316 review, finding 3)", () => {
  const OWNER = "0xtemporalowner";

  it("EASYPOST_API_KEY removed AFTER registration turns the next request into a 503 naming exactly it", async () => {
    await configureAllFour();
    const app = await buildAuthedApp("production");
    try {
      getCarrierShipmentStore().reserve({
        jobId: "job-temporal-key",
        kernelId: "kernel-temporal",
        ownerId: OWNER,
        requestFingerprint: "temporal-1",
      });
      const url = "/api/carrier/shipments/job-temporal-key";
      const before = await app.inject({ method: "GET", url, headers: { "x-test-operator": OWNER } });
      // Fully configured: the guard passes and the owner reads their record — this is also
      // the counterfactual for every 503 assertion in this file (the guard, not something
      // else, is what blocks).
      expect(before.statusCode).toBe(200);
      delete process.env.EASYPOST_API_KEY;
      const after = await app.inject({ method: "GET", url, headers: { "x-test-operator": OWNER } });
      expect(after.statusCode).toBe(503);
      expect(after.json().missing).toHaveLength(1);
      expect(after.json().missing[0]).toContain("EASYPOST_API_KEY");
    } finally {
      await app.close();
    }
  });

  it("the SIGNING KEY disappearing after boot turns into 503s — never silently-unverified evidence", async () => {
    await configureAllFour();
    const app = await buildAuthedApp("production");
    try {
      getCarrierShipmentStore().reserve({
        jobId: "job-temporal-sign",
        kernelId: "kernel-temporal",
        ownerId: OWNER,
        requestFingerprint: "temporal-2",
      });
      const url = "/api/carrier/shipments/job-temporal-sign/evidence";
      const before = await app.inject({ method: "GET", url, headers: { "x-test-operator": OWNER } });
      expect(before.statusCode).toBe(200);
      // sol's exact scenario: the active key object is gone mid-process. The evidence
      // plane must go 503, not keep serving with signature enforcement silently off.
      _resetSigningKeyForTests();
      const after = await app.inject({ method: "GET", url, headers: { "x-test-operator": OWNER } });
      expect(after.statusCode).toBe(503);
      expect(after.json().missing).toHaveLength(1);
      expect(after.json().missing[0]).toContain("PCC_AGENT_CARD_SIGNING_KEY");
    } finally {
      await app.close();
    }
  });

  it("each of the four requirements, missing INDIVIDUALLY, 503s and is named alone", async () => {
    const cases: Array<[string, () => void]> = [
      ["EASYPOST_API_KEY", () => void delete process.env.EASYPOST_API_KEY],
      ["EASYPOST_WEBHOOK_SECRET", () => void delete process.env.EASYPOST_WEBHOOK_SECRET],
      ["PCC_AGENT_CARD_SIGNING_KEY", () => _resetSigningKeyForTests()],
      [
        "durable carrier store",
        () => {
          _resetCarrierShipmentStoreForTests();
          initCarrierShipmentStore({});
        },
      ],
    ];
    for (const [label, knockOut] of cases) {
      await configureAllFour();
      const app = await buildAuthedApp("production");
      try {
        knockOut();
        const jobId = `job-single-${cases.findIndex(([l]) => l === label)}`;
        getCarrierShipmentStore().reserve({
          jobId,
          kernelId: "kernel-single",
          ownerId: OWNER,
          requestFingerprint: `single-${label}`,
        });
        const res = await app.inject({
          method: "GET",
          url: `/api/carrier/shipments/${jobId}`,
          headers: { "x-test-operator": OWNER },
        });
        expect(res.statusCode, label).toBe(503);
        expect(res.json().missing, label).toHaveLength(1);
        expect(res.json().missing[0], label).toContain(label);
      } finally {
        await app.close();
      }
    }
  });
});

/**
 * sol #316 review, finding 4: the original unconfigured purchase test was UNAUTHENTICATED,
 * so it 401'd before the config guard and would still pass with the guard deleted. This
 * one authenticates, sends an otherwise-valid body, and proves the 503 happens BEFORE any
 * provider call or reservation — the money guard itself, not a side effect.
 */
describe("carrier config gate — the MONEY guard is proven, not implied (sol #316 review, finding 4)", () => {
  it("an authenticated, otherwise-valid purchase 503s with ZERO provider calls and ZERO reservations", async () => {
    let fetchCalls = 0;
    _setEasyPostClientForTests(
      new EasyPostClient({
        apiKey: "EZTK_spy",
        webhookSecret: "whsec_spy",
        requireProductionMode: true,
        fetchImpl: (async () => {
          fetchCalls += 1;
          throw new Error("carrier spend path must not be reached while unconfigured");
        }) as unknown as typeof fetch,
      }),
    );
    const app = await buildAuthedApp("production");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/carrier/shipments",
        headers: { "x-test-operator": "0xbuyer" },
        payload: {
          jobId: "job-money-guard",
          kernelId: "kernel-money-guard",
          documentHash: "a".repeat(64),
          toAddress: { name: "R. Recipient", street1: "1 Delivery Way", city: "Reno", state: "NV", zip: "89501" },
          fromAddress: { name: "S. Sender", street1: "2 Origin Rd", city: "Reno", state: "NV", zip: "89501" },
          parcel: { weightOz: 1 },
        },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("carrier_not_configured");
      // Authenticated callers DO get the actionable missing list (only the public webhook is redacted).
      expect(Array.isArray(res.json().missing)).toBe(true);
      // The guard fired BEFORE the spend path: no provider HTTP, no reservation row.
      expect(fetchCalls).toBe(0);
      expect(getCarrierShipmentStore().size()).toBe(0);
    } finally {
      await app.close();
    }
  });
});
