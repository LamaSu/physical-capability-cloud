/**
 * Lob config gate: the #316-review architecture applied to the SECOND operator
 * (carrier-lane audit L3, bulletin #1577). Production classification is fail-closed
 * (isCarrierProductionEnv — unset/mistyped NODE_ENV counts as production), readiness is
 * recomputed per request, the public webhook's 503 is redacted, and — Lob-specific,
 * because Lob DOCUMENTS its key prefixes — a test_ or unrecognized key in production is
 * refused BY NAME as sandbox-as-real. Before this gate, an unconfigured production
 * deployment served MOCK letters that emitted courier_* evidence events.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { lobRoutes } from "../routes/lob.js";
import { _resetLobLetterStoreForTests } from "../services/lob-letter-store.js";
import { _setLobClientForTests } from "../services/lob-client.js";

const LOB_ENV = ["LOB_API_KEY", "LOB_WEBHOOK_SECRET"] as const;

let savedNodeEnv: string | undefined;
const savedLobEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedNodeEnv = process.env.NODE_ENV;
  for (const k of LOB_ENV) {
    savedLobEnv[k] = process.env[k];
    delete process.env[k];
  }
  _resetLobLetterStoreForTests();
  _setLobClientForTests(undefined);
});

afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  for (const k of LOB_ENV) {
    if (savedLobEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedLobEnv[k] as string;
  }
  _resetLobLetterStoreForTests();
  _setLobClientForTests(undefined);
});

/** Readiness is read per request, so env may be flipped after register(). `undefined` DELETES NODE_ENV. */
async function buildApp(nodeEnv: string | undefined): Promise<FastifyInstance> {
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const h = req.headers["x-test-operator"];
    if (typeof h === "string" && h) (req as unknown as { operatorId?: string }).operatorId = h;
  });
  await app.register(lobRoutes);
  await app.ready();
  return app;
}

const OWNER = { "x-test-operator": "0xlobgateowner" };

const validBody = {
  jobId: "job-any",
  kernelId: "kernel-any",
  to: { name: "A", addressLine1: "1 St", addressCity: "NY", addressState: "NY", addressZip: "10007" },
  from: { name: "B", addressLine1: "2 St", addressCity: "SF", addressState: "CA", addressZip: "94103" },
  file: "<html><body>doc</body></html>",
};

describe("lob config gate — production, nothing configured", () => {
  it("REGISTERS without throwing and 503s the money route for an AUTHED caller, naming both requirements", async () => {
    const app = await buildApp("production");
    try {
      const res = await app.inject({ method: "POST", url: "/api/lob/letters", payload: validBody, headers: OWNER });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("lob_not_configured");
      const missing = res.json().missing.join(" ");
      expect(missing).toContain("LOB_API_KEY");
      expect(missing).toContain("LOB_WEBHOOK_SECRET");
    } finally {
      await app.close();
    }
  });

  it("401s an ANONYMOUS caller on the money route — no config posture for anonymous callers", async () => {
    const app = await buildApp("production");
    try {
      const res = await app.inject({ method: "POST", url: "/api/lob/letters", payload: validBody });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("authentication_required");
    } finally {
      await app.close();
    }
  });

  it("503s the webhook REDACTED — an anonymous caller learns the capability is off, not which requirement is missing", async () => {
    const app = await buildApp("production");
    try {
      const payload = JSON.stringify({ id: "evt_x", event_type: { id: "letter.mailed" }, reference_id: "ltr_x", object: "event" });
      const res = await app.inject({
        method: "POST",
        url: "/api/lob/webhook",
        payload,
        headers: { "content-type": "application/json", "lob-signature": "00", "lob-signature-timestamp": Date.now().toString() },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("lob_not_configured");
      expect(res.json()).not.toHaveProperty("missing");
    } finally {
      await app.close();
    }
  });

  it("rejects BEFORE parsing: malformed JSON to the webhook is the redacted 503, not a parse 400", async () => {
    const app = await buildApp("production");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/lob/webhook",
        payload: "{not json",
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("lob_not_configured");
    } finally {
      await app.close();
    }
  });

  it("REDACTS healthz for anonymous production callers; authed callers get the posture", async () => {
    const app = await buildApp("production");
    try {
      const anon = await app.inject({ method: "GET", url: "/api/lob/healthz" });
      expect(anon.statusCode).toBe(200);
      expect(anon.json().redacted).toBe(true);
      expect(anon.json().configured).toBe(false);
      expect(anon.json()).not.toHaveProperty("missingConfig");
      expect(anon.json()).not.toHaveProperty("letters");

      const authed = await app.inject({ method: "GET", url: "/api/lob/healthz", headers: OWNER });
      expect(authed.json().ok).toBe(false);
      expect(authed.json().configured).toBe(false);
      expect(authed.json().missingConfig.join(" ")).toContain("LOB_API_KEY");
    } finally {
      await app.close();
    }
  });
});

describe("lob config gate — documented key prefixes are POLICY (sandbox-as-real refused)", () => {
  it("refuses a test_ key in production BY NAME — Lob's sandbox must not produce production evidence", async () => {
    process.env.LOB_API_KEY = "test_abc123";
    process.env.LOB_WEBHOOK_SECRET = "whsec_x";
    const app = await buildApp("production");
    try {
      const res = await app.inject({ method: "POST", url: "/api/lob/letters", payload: validBody, headers: OWNER });
      expect(res.statusCode).toBe(503);
      expect(res.json().missing[0]).toContain("live_");
    } finally {
      await app.close();
    }
  });

  it("refuses an UNRECOGNIZED key prefix in production — never guess a key's environment", async () => {
    process.env.LOB_API_KEY = "sk_mystery_prefix";
    process.env.LOB_WEBHOOK_SECRET = "whsec_x";
    const app = await buildApp("production");
    try {
      const res = await app.inject({ method: "POST", url: "/api/lob/letters", payload: validBody, headers: OWNER });
      expect(res.statusCode).toBe(503);
      expect(res.json().missing[0]).toContain("live_");
    } finally {
      await app.close();
    }
  });

  it("a live_ key + secret satisfies the credential requirements, readiness is PER REQUEST — and the DURABLE STORE remains required", async () => {
    process.env.LOB_API_KEY = "live_abc123";
    process.env.LOB_WEBHOOK_SECRET = "whsec_x";
    const app = await buildApp("production");
    try {
      const before = await app.inject({ method: "GET", url: "/api/lob/healthz", headers: OWNER });
      // Credentials satisfied — the ONLY remaining requirement is the durable letter
      // store (sol lob review R2/R3): with a memory-only store, production Lob stays
      // 503 BY CONSTRUCTION until a durable implementation lands. A capability that
      // can double-charge after a restart must not be enable-able by env vars alone.
      expect(before.json().configured).toBe(false);
      expect(before.json().keyMode).toBe("live");
      expect(before.json().missingConfig).toHaveLength(1);
      expect(before.json().missingConfig[0]).toContain("durable letter store");
      // The key disappears mid-process: the very next request must see it (no snapshot).
      delete process.env.LOB_API_KEY;
      const after = await app.inject({ method: "GET", url: "/api/lob/healthz", headers: OWNER });
      expect(after.json().missingConfig.join(" ")).toContain("LOB_API_KEY");
      expect(after.json().missingConfig).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
});

describe("lob config gate — environment classification is fail-closed", () => {
  it("gates when NODE_ENV is UNSET — forgetting the env var selects the STRICT mode", async () => {
    const app = await buildApp(undefined);
    try {
      const res = await app.inject({ method: "POST", url: "/api/lob/letters", payload: validBody, headers: OWNER });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("lob_not_configured");
    } finally {
      await app.close();
    }
  });

  it("gates on a MISTYPED NODE_ENV ('staging')", async () => {
    const app = await buildApp("staging");
    try {
      const res = await app.inject({ method: "GET", url: "/api/lob/healthz" });
      expect(res.json().redacted).toBe(true);
      expect(res.json().configured).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("does NOT gate under explicit test/development — existing suites and dev flows unchanged", async () => {
    const app = await buildApp("development");
    try {
      const health = await app.inject({ method: "GET", url: "/api/lob/healthz" });
      expect(health.json().configured).toBe(true);
      expect(health.json().mock).toBe(true); // mock is allowed OUTSIDE production classification
    } finally {
      await app.close();
    }
  });
});

describe("lob config gate — real-money posture follows the KEY, not the label (sol lob round 2, NEW-4)", () => {
  it("a live_ key under NODE_ENV=test still demands the money-path requirements", async () => {
    process.env.LOB_API_KEY = "live_real_money_key";
    // no webhook secret, memory store
    const app = await buildApp("test");
    try {
      const res = await app.inject({ method: "POST", url: "/api/lob/letters", payload: validBody, headers: OWNER });
      // Without this rule, test/development classification returned NO requirements and
      // this request would have charged the REAL Lob account with no durability and no
      // webhook authentication.
      expect(res.statusCode).toBe(503);
      const missing = res.json().missing.join(" ");
      expect(missing).toContain("LOB_WEBHOOK_SECRET");
      expect(missing).toContain("durable letter store");
    } finally {
      await app.close();
    }
  });

  it("no key at all under NODE_ENV=test stays ungated — mock dev flows unchanged", async () => {
    const app = await buildApp("test");
    try {
      const health = await app.inject({ method: "GET", url: "/api/lob/healthz" });
      expect(health.json().configured).toBe(true);
    } finally {
      await app.close();
    }
  });
});
