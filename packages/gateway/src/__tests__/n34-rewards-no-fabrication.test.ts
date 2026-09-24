/**
 * No fixture in production (board N34, the server side of PX-3), family "rewards".
 *
 * Every route in rewards.ts answered from invented data: DePIN epochs with kernel scores
 * and reward amounts, claims (one with a made-up transaction hash), soulbound capability
 * certificates, a treasury holding 50,000 USDC and 10.5 ETH. POST /api/rewards/claims said
 * created:true and POST /api/certificates/mint said minted:true; neither recorded or minted
 * anything.
 *
 * All nine routes are SERVED-MOCK, so the plugin is gated by ONE encapsulated onRequest
 * hook: unless PCC_DEMO_ROUTES=true, each answers 501 not_available (see: [], nothing real
 * exists on this gateway), before the body is even parsed. In demo the old answers stay,
 * marked mock/demo. The hook must not leak to other plugins: checked below with a real
 * sibling plugin (marketplace's POST /roi) and probe routes before and after. It also
 * sits behind the API-key gate (a root onRequest hook registered first, as in server.ts):
 * a caller without a key still gets 401, not the refusal.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { rewardRoutes } from "../routes/rewards.js";
import { marketplaceRoutes } from "../routes/marketplace.js";
import { apiGate } from "../middleware/api-gate.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { initStore, closeStore } from "../db.js";

type Method = "GET" | "POST";

let app: FastifyInstance;
let savedDemo: string | undefined;

beforeAll(async () => {
  savedDemo = process.env.PCC_DEMO_ROUTES;
  delete process.env.PCC_DEMO_ROUTES;
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  app = Fastify({ logger: false });
  await app.register(rewardRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
  if (savedDemo === undefined) delete process.env.PCC_DEMO_ROUTES;
  else process.env.PCC_DEMO_ROUTES = savedDemo;
});

beforeEach(() => {
  delete process.env.PCC_DEMO_ROUTES;
});

const req = (method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as any });

/** Values only the fixtures (or the fabricated write answers) contain. */
const FIXTURE =
  /cnft_biolab|cnft_metalshop|did:pcc:kernel|kernel-biolab-01|kernel-metalshop-01|kernel-printfarm-01|epoch_completed_001|epoch_active_002|4115\.000000|3560\.000000|10000\.000000|claim_biolab_ep1|claim_metalshop_ep1|mockTxHash|50000\.00|85000\.00|broker-agent|TreeAAAA|bafybei|"minted":true|"created":true|soulbound/;

const NEW_CLAIM = { kernelId: "kernel-n34-probe", epochId: "epoch-n34-probe", amount: "1.000000" };
const NEW_CERT = { kernelDid: "did:n34:probe", capabilityType: "fdm" };
const RETURNED = "so nothing is returned rather than an example.";

interface Gated {
  method: Method;
  url: string;
  body?: unknown;
  message: string;
  demoStatus: number;
  demo: (body: any) => void;
}

const GATED: Gated[] = [
  {
    method: "GET",
    url: "/api/rewards/epochs",
    message: `DePIN reward epochs are not recorded on this gateway, ${RETURNED}`,
    demoStatus: 200,
    demo: (b) => expect(b).toMatchObject({ total: 2, epochs: [{ id: "epoch_completed_001" }, { id: "epoch_active_002" }] }),
  },
  {
    method: "GET",
    url: "/api/rewards/epochs/epoch_completed_001",
    message: `DePIN reward epochs are not recorded on this gateway, ${RETURNED}`,
    demoStatus: 200,
    demo: (b) => expect(b.epoch).toMatchObject({ id: "epoch_completed_001", epochNumber: 1 }),
  },
  {
    method: "GET",
    url: "/api/rewards/kernels/kernel-biolab-01",
    message: `Kernel reward history is not recorded on this gateway, ${RETURNED}`,
    demoStatus: 200,
    demo: (b) => expect(b).toMatchObject({ kernelId: "kernel-biolab-01", totalEarned: "4115.000000" }),
  },
  {
    method: "POST",
    url: "/api/rewards/claims",
    body: NEW_CLAIM,
    message: "DePIN reward claims are not recorded on this gateway, so no claim was created.",
    demoStatus: 201,
    demo: (b) => expect(b).toMatchObject({ created: true, claim: { ...NEW_CLAIM, chain: "base", status: "pending" } }),
  },
  {
    method: "GET",
    url: "/api/rewards/claims/claim_biolab_ep1",
    message: `DePIN reward claims are not recorded on this gateway, ${RETURNED}`,
    demoStatus: 200,
    demo: (b) => expect(b.claim).toMatchObject({ id: "claim_biolab_ep1", status: "claimed" }),
  },
  {
    method: "GET",
    url: "/api/certificates",
    message: `Capability certificates are not recorded on this gateway, ${RETURNED}`,
    demoStatus: 200,
    demo: (b) => expect(b).toMatchObject({ total: 3 }),
  },
  {
    method: "GET",
    url: "/api/certificates/cnft_biolab_fdm_001",
    message: `Capability certificates are not recorded on this gateway, ${RETURNED}`,
    demoStatus: 200,
    demo: (b) => expect(b.certificate).toMatchObject({ id: "cnft_biolab_fdm_001", soulbound: true }),
  },
  {
    method: "POST",
    url: "/api/certificates/mint",
    body: NEW_CERT,
    message: "Capability certificates are not recorded on this gateway, so nothing was minted.",
    demoStatus: 201,
    demo: (b) => expect(b).toMatchObject({ minted: true, certificate: { ...NEW_CERT, soulbound: true } }),
  },
  {
    method: "GET",
    url: "/api/treasury/summary",
    message: `Treasury balances and proposals are not recorded on this gateway, ${RETURNED}`,
    demoStatus: 200,
    demo: (b) => expect(b).toMatchObject({ treasury: { agentId: "broker-agent" }, proposalCount: 0 }),
  },
];

describe("NEGATIVE: outside demo, every rewards route refuses with 501 not_available", () => {
  for (const c of GATED) {
    it(`${c.method} ${c.url} -> 501, its own message, no fixture value`, async () => {
      const res = await req(c.method, c.url, c.body);
      expect(res.statusCode, res.body).toBe(501);
      expect(res.json()).toEqual({ error: "not_available", message: c.message, see: [] });
      expect(res.body).not.toMatch(FIXTURE);
    });
  }

  it("unknown ids and filters are refused the same way (nothing reveals which fixture ids exist)", async () => {
    for (const url of [
      "/api/rewards/epochs?status=completed",
      "/api/rewards/epochs/nope",
      "/api/rewards/kernels/nope",
      "/api/rewards/claims/nope",
      "/api/certificates?kernelDid=did:pcc:kernel:biolab-01",
      "/api/certificates/nope",
    ]) {
      const res = await req("GET", url);
      expect(res.statusCode, url).toBe(501);
      expect(res.body).not.toMatch(FIXTURE);
    }
  });

  it("a write is refused before its body is parsed: malformed JSON is 501, not 400", async () => {
    for (const url of ["/api/rewards/claims", "/api/certificates/mint"]) {
      const res = await app.inject({
        method: "POST",
        url,
        payload: "{not json",
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode, url).toBe(501);
      expect(res.json().error).toBe("not_available");
    }
  });

  it("HEAD is refused too", async () => {
    const res = await app.inject({ method: "HEAD", url: "/api/treasury/summary" });
    expect(res.statusCode).toBe(501);
  });
});

describe("PCC_DEMO_ROUTES=true: the old answers, each marked mock/demo", () => {
  beforeEach(() => {
    process.env.PCC_DEMO_ROUTES = "true";
  });

  for (const c of GATED) {
    it(`${c.method} ${c.url} -> ${c.demoStatus} with mock:true, demo:true`, async () => {
      const res = await req(c.method, c.url, c.body);
      expect(res.statusCode, res.body).toBe(c.demoStatus);
      const body = res.json();
      expect(body).toMatchObject({ mock: true, demo: true });
      c.demo(body);
    });
  }

  it("demo errors keep their old status and are marked (404 unknown id, 400 missing fields)", async () => {
    const missing = await req("GET", "/api/certificates/nope");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not_found", message: "Certificate not found", mock: true, demo: true });
    const bad = await req("POST", "/api/rewards/claims", { kernelId: "k" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "bad_request", mock: true, demo: true });
  });
});

describe("the gate is encapsulated: it never touches another plugin's routes", () => {
  let mixed: FastifyInstance;

  beforeAll(async () => {
    mixed = Fastify({ logger: false });
    mixed.get("/api/root-probe-before", async () => ({ ok: "root-before" }));
    await mixed.register(rewardRoutes);
    // A real sibling, registered after (as in server.ts): its REAL calculator route.
    await mixed.register(marketplaceRoutes);
    await mixed.register(async (sibling) => {
      sibling.post("/api/sibling-probe", async (r) => ({ ok: "sibling", body: r.body }));
    });
    mixed.get("/api/root-probe-after", async () => ({ ok: "root-after" }));
    await mixed.ready();
  });

  afterAll(async () => {
    await mixed.close();
  });

  it("demo off: rewards refuse, while the parent's and siblings' routes answer normally", async () => {
    expect((await mixed.inject({ method: "GET", url: "/api/treasury/summary" })).statusCode).toBe(501);

    for (const url of ["/api/root-probe-before", "/api/root-probe-after"]) {
      const res = await mixed.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.json()).not.toHaveProperty("error");
    }

    const roi = await mixed.inject({
      method: "POST",
      url: "/api/marketplace/roi",
      payload: { monthlyCost: 200, avgJobValue: 30, utilization: 65 },
    });
    expect(roi.statusCode).toBe(200);
    expect(roi.json().breakEvenMonth).toBe(3);

    const probe = await mixed.inject({ method: "POST", url: "/api/sibling-probe", payload: { a: 1 } });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toEqual({ ok: "sibling", body: { a: 1 } });

    // An unmatched path is the ordinary 404, not the rewards refusal.
    expect((await mixed.inject({ method: "GET", url: "/api/rewards/nope" })).statusCode).toBe(404);
  });
});

describe("the gate runs after the API-key gate (registered first, as in server.ts)", () => {
  let gated: FastifyInstance;
  let key: string;

  beforeAll(async () => {
    key = provisionApiKey({ operatorId: "n34-rewards-probe", name: "n34 rewards probe" }).rawKey;
    gated = Fastify({ logger: false });
    await gated.register(apiGate);
    await gated.register(rewardRoutes);
    await gated.ready();
  });

  afterAll(async () => {
    await gated.close();
  });

  it("no key: 401 api_key_required on a read and a write, never the rewards refusal", async () => {
    const read = await gated.inject({ method: "GET", url: "/api/treasury/summary" });
    expect(read.statusCode).toBe(401);
    expect(read.json().error).toBe("api_key_required");
    const write = await gated.inject({ method: "POST", url: "/api/certificates/mint", payload: NEW_CERT });
    expect(write.statusCode).toBe(401);
    expect(write.json().error).toBe("api_key_required");
  });

  it("with a key: the refusal outside demo, the marked demo answer with the flag on", async () => {
    const headers = { authorization: `Bearer ${key}` };
    const off = await gated.inject({ method: "GET", url: "/api/treasury/summary", headers });
    expect(off.statusCode).toBe(501);
    expect(off.json().error).toBe("not_available");
    expect(off.body).not.toMatch(FIXTURE);
    process.env.PCC_DEMO_ROUTES = "true";
    const on = await gated.inject({ method: "GET", url: "/api/treasury/summary", headers });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ treasury: { agentId: "broker-agent" }, mock: true, demo: true });
  });
});
