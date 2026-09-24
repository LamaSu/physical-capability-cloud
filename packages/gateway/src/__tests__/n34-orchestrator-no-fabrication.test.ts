/**
 * Orchestrator routes never pass fixtures off as live data (board N34, the server side
 * of PX-3).
 *
 * Every route in orchestrator.ts answered from one made-up lab kernel
 * ("kernel-biolab-01"): a five-instrument transfer graph, two samples with a movement
 * history, one running workflow and its resource claims. GET /graphs/:kernelId answered
 * { error: "not_found" } with HTTP 200 for every real kernel, and POST /workflows said
 * accepted: true and recorded nothing.
 *
 * All eight routes are SERVED-MOCK, so the plugin is gated by ONE encapsulated onRequest
 * hook: unless PCC_DEMO_ROUTES=true, each answers 501 not_available before anything is
 * parsed or read. With the flag, the old answers come back marked mock/demo. The hook must
 * not leak: checked below against the other /api/orchestrator/* plugin (the template
 * directory), a real DB-backed plugin and root routes, with a control that proves the
 * check can fail. It also sits behind the API-key gate (401 without a key).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { orchestratorRoutes } from "../routes/orchestrator.js";
import { orchestratorTemplatesRoutes } from "../routes/orchestrator-templates.js";
import { kernelRoutes } from "../routes/kernels.js";
import { jobRoutes } from "../routes/jobs.js";
import { jobSubmitRoutes } from "../routes/job-submit.js";
import { apiGate } from "../middleware/api-gate.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { initStore, closeStore } from "../db.js";

type Method = "GET" | "POST";

/** Values only the fixtures (or the fabricated acceptance) carry. None may appear in a refusal. */
const FIXTURE =
  /kernel-biolab-01|graph-biolab-01|node-(staging|liquid|centrifuge|hplc|inspect)|dev-(liquid-handler|centrifuge|hplc)|Liquid Handler|Inspection Station|Serum Panel|samp-00[12]|mov-00|job-bio-42|wf-001|claim-00[12]|dilute_and_dispense|spin_separate|reverse_phase_c18|robot_arm|job-unknown|"accepted":true|workflowId/;

const RETURNED = "is not recorded on this gateway, so nothing is returned rather than an example.";
const GRAPHS = `Instrument transfer-graph data ${RETURNED}`;
const SAMPLES = `Sample location and movement data ${RETURNED}`;
const CLAIMS = `Instrument resource-claim data ${RETURNED}`;
const WORKFLOWS = `Instrument workflow data ${RETURNED}`;
const WORKFLOW_POST = "Instrument workflow data is not recorded on this gateway, so no workflow was accepted or started.";

const NEW_WORKFLOW = { kernelId: "kernel-n34-probe", jobId: "job-n34-probe", steps: [{ id: "s1" }, { id: "s2" }] };

interface Gated {
  method: Method;
  url: string;
  payload?: Record<string, unknown>;
  message: string;
  see: string[];
  /** The old (pre-gate) status, which demo mode must still give. */
  demoStatus: number;
  /** The old (pre-gate) answer, which demo mode must still give. */
  demo: (body: any) => void;
}

const GATED: Gated[] = [
  {
    method: "GET",
    url: "/api/orchestrator/graphs",
    message: GRAPHS,
    see: ["GET /api/kernels", "GET /api/kernels/:kernelId/devices"],
    demoStatus: 200,
    demo: (b) => {
      expect(b.graphs).toHaveLength(1);
      expect(b.graphs[0]).toMatchObject({ id: "graph-biolab-01", kernelId: "kernel-biolab-01" });
      expect(b.graphs[0].nodes).toHaveLength(5);
    },
  },
  {
    method: "GET",
    url: "/api/orchestrator/graphs/kernel-biolab-01",
    message: GRAPHS,
    see: ["GET /api/kernels/:kernelId/devices"],
    demoStatus: 200,
    demo: (b) => expect(b.graph).toMatchObject({ id: "graph-biolab-01", kernelId: "kernel-biolab-01" }),
  },
  {
    method: "GET",
    url: "/api/orchestrator/samples",
    message: SAMPLES,
    see: [],
    demoStatus: 200,
    demo: (b) => expect(b.samples.map((s: { id: string }) => s.id)).toEqual(["samp-001", "samp-002"]),
  },
  {
    // The old filters still apply in demo mode.
    method: "GET",
    url: "/api/orchestrator/samples?kernelId=kernel-biolab-01&jobId=job-bio-42",
    message: SAMPLES,
    see: [],
    demoStatus: 200,
    demo: (b) => expect(b.samples).toHaveLength(2),
  },
  {
    method: "GET",
    url: "/api/orchestrator/samples/samp-001",
    message: SAMPLES,
    see: [],
    demoStatus: 200,
    demo: (b) => expect(b.sample).toMatchObject({ id: "samp-001", label: "Serum Panel A", currentNodeId: "node-centrifuge" }),
  },
  {
    method: "GET",
    url: "/api/orchestrator/claims",
    message: CLAIMS,
    see: [],
    demoStatus: 200,
    // Only the unreleased claim, as before.
    demo: (b) => expect(b.claims.map((c: { id: string }) => c.id)).toEqual(["claim-001"]),
  },
  {
    method: "POST",
    url: "/api/orchestrator/workflows",
    payload: NEW_WORKFLOW,
    message: WORKFLOW_POST,
    see: ["POST /api/jobs/submit"],
    demoStatus: 202,
    demo: (b) => {
      expect(b).toMatchObject({ accepted: true, kernelId: "kernel-n34-probe", jobId: "job-n34-probe", stepCount: 2 });
      expect(b.workflowId).toMatch(/^wf-/);
    },
  },
  {
    method: "GET",
    url: "/api/orchestrator/workflows",
    message: WORKFLOWS,
    see: ["GET /api/jobs"],
    demoStatus: 200,
    demo: (b) => expect(b.workflows.map((w: { id: string }) => w.id)).toEqual(["wf-001"]),
  },
  {
    method: "GET",
    url: "/api/orchestrator/workflows?status=running",
    message: WORKFLOWS,
    see: ["GET /api/jobs"],
    demoStatus: 200,
    demo: (b) => expect(b.workflows).toHaveLength(1),
  },
  {
    method: "GET",
    url: "/api/orchestrator/workflows/wf-001",
    message: WORKFLOWS,
    see: ["GET /api/jobs/:jobId"],
    demoStatus: 200,
    demo: (b) => expect(b.workflow).toMatchObject({ id: "wf-001", jobId: "job-bio-42", status: "running" }),
  },
];

const ENV = ["PCC_DEMO_ROUTES", "PCC_DB_PATH", "NODE_ENV"] as const;
const saved: Record<string, string | undefined> = {};
let app: FastifyInstance;

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  delete process.env.PCC_DEMO_ROUTES;
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  app = Fastify({ logger: false });
  // Siblings: a root route declared before the plugin; after it (the order in which a
  // leaked hook would reach them), the other /api/orchestrator/* plugin and a real
  // DB-backed plugin, as in server.ts.
  app.get("/probe/root", async () => ({ ok: true }));
  await app.register(orchestratorRoutes);
  await app.register(orchestratorTemplatesRoutes);
  await app.register(kernelRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  delete process.env.PCC_DEMO_ROUTES;
  process.env.NODE_ENV = saved.NODE_ENV ?? "test";
});

const call = (c: { method: Method | "HEAD"; url: string; payload?: unknown }) =>
  app.inject({ method: c.method, url: c.url, payload: c.payload as any });

describe("NEGATIVE: without PCC_DEMO_ROUTES every orchestrator route refuses (501 not_available)", () => {
  it("every route the plugin registers (8) is refused with its own message, none with the fallback", async () => {
    const FALLBACK = `Instrument orchestration data ${RETURNED}`;
    const registered: Array<{ method: string; url: string }> = [];
    const probe = Fastify({ logger: false });
    probe.addHook("onRoute", (r) => {
      for (const m of Array.isArray(r.method) ? r.method : [r.method]) {
        if (m !== "HEAD") registered.push({ method: m, url: r.url });
      }
    });
    await probe.register(orchestratorRoutes);
    await probe.ready();
    try {
      expect(registered).toHaveLength(8);
      // The table above exercises each of them.
      expect(new Set(GATED.map((c) => `${c.method} ${c.url.split("?")[0]}`)).size).toBe(8);
      for (const r of registered) {
        const res = await probe.inject({ method: r.method as Method, url: r.url.replace(/:[A-Za-z]+/g, "x") });
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(501);
        expect(res.json().message, `${r.method} ${r.url}`).not.toBe(FALLBACK);
      }
    } finally {
      await probe.close();
    }
  });

  it("every `see` pointer names a route this gateway registers", async () => {
    const probe = Fastify({ logger: false });
    await probe.register(kernelRoutes);
    await probe.register(jobRoutes);
    await probe.register(jobSubmitRoutes);
    await probe.ready();
    try {
      const pointers = new Set(GATED.flatMap((c) => c.see));
      expect(pointers.size).toBe(5);
      for (const p of pointers) {
        const [method, url] = p.split(" ");
        expect(probe.hasRoute({ method: method as Method, url }), p).toBe(true);
      }
    } finally {
      await probe.close();
    }
  });

  for (const c of GATED) {
    it(`${c.method} ${c.url} -> 501, its own message and pointers, nothing from the fixtures`, async () => {
      const res = await call(c);
      expect(res.statusCode, res.body).toBe(501);
      // The refusal is the whole body: nothing else rides along.
      expect(res.json()).toEqual({ error: "not_available", message: c.message, see: c.see });
      expect(res.body).not.toMatch(FIXTURE);
      expect(res.headers["x-pcc-demo"]).toBeUndefined();
    });
  }

  it("only the literal \"true\" turns demo on", async () => {
    for (const v of ["false", "1", "TRUE", "yes", ""]) {
      process.env.PCC_DEMO_ROUTES = v;
      const res = await call({ method: "GET", url: "/api/orchestrator/graphs" });
      expect(res.statusCode, `PCC_DEMO_ROUTES=${JSON.stringify(v)}`).toBe(501);
    }
  });

  it("PCC_DEMO_ROUTES=true is ignored under NODE_ENV=production", async () => {
    process.env.PCC_DEMO_ROUTES = "true";
    process.env.NODE_ENV = "production";
    for (const c of GATED) {
      const res = await call(c);
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(501);
      expect(res.body).not.toMatch(FIXTURE);
      expect(res.headers["x-pcc-demo"]).toBeUndefined();
    }
  });

  it("unknown ids and filters are refused the same way (no fixture lookup, no not_found oracle)", async () => {
    for (const url of [
      "/api/orchestrator/graphs/kernel-none",
      "/api/orchestrator/samples/samp-none",
      "/api/orchestrator/samples?jobId=job-none",
      "/api/orchestrator/workflows/wf-none",
      "/api/orchestrator/workflows?status=completed",
    ]) {
      const res = await call({ method: "GET", url });
      expect(res.statusCode, url).toBe(501);
      expect(res.json().error).toBe("not_available");
      expect(res.body).not.toMatch(FIXTURE);
    }
  });

  it("POST /workflows refuses a malformed body with 501, not a 400: the gate runs before parsing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/orchestrator/workflows",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: "not_available", message: WORKFLOW_POST, see: ["POST /api/jobs/submit"] });
  });

  it("HEAD is refused too", async () => {
    const res = await call({ method: "HEAD", url: "/api/orchestrator/graphs" });
    expect(res.statusCode).toBe(501);
    expect(res.headers["x-pcc-demo"]).toBeUndefined();
  });
});

describe("PCC_DEMO_ROUTES=true: the old answers, each marked mock/demo", () => {
  beforeEach(() => {
    process.env.PCC_DEMO_ROUTES = "true";
  });

  for (const c of GATED) {
    it(`${c.method} ${c.url} -> ${c.demoStatus} with mock:true, demo:true and x-pcc-demo`, async () => {
      const res = await call(c);
      expect(res.statusCode, res.body).toBe(c.demoStatus);
      const body = res.json();
      expect(body).toMatchObject({ mock: true, demo: true });
      expect(res.headers["x-pcc-demo"]).toBe("true");
      c.demo(body);
    });
  }

  it("the old not_found answers stay as they were (HTTP 200), and are marked demo too", async () => {
    for (const url of [
      "/api/orchestrator/graphs/kernel-none",
      "/api/orchestrator/samples/samp-none",
      "/api/orchestrator/workflows/wf-none",
    ]) {
      const res = await call({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.json()).toEqual({ error: "not_found", mock: true, demo: true });
      expect(res.headers["x-pcc-demo"]).toBe("true");
    }
  });
});

describe("the gate is encapsulated to the orchestrator plugin", () => {
  for (const demo of [false, true]) {
    it(`siblings are untouched with PCC_DEMO_ROUTES ${demo ? "on" : "off"}`, async () => {
      if (demo) process.env.PCC_DEMO_ROUTES = "true";

      // Same /api/orchestrator/ prefix, different plugin: served as before, never marked.
      const templates = await call({ method: "GET", url: "/api/orchestrator/templates" });
      expect(templates.statusCode, templates.body).toBe(200);
      expect(templates.json().templates.map((t: { slug: string }) => t.slug)).toEqual(
        expect.arrayContaining(["physical-operator", "data-product"]),
      );
      expect(templates.json()).not.toHaveProperty("mock");
      expect(templates.json()).not.toHaveProperty("demo");
      expect(templates.headers["x-pcc-demo"]).toBeUndefined();

      const kernels = await call({ method: "GET", url: "/api/kernels" });
      expect(kernels.statusCode, kernels.body).toBe(200);
      expect(kernels.json().kernels.length).toBeGreaterThan(0);
      expect(kernels.json()).not.toHaveProperty("mock");
      expect(kernels.headers["x-pcc-demo"]).toBeUndefined();

      const root = await call({ method: "GET", url: "/probe/root" });
      expect(root.statusCode).toBe(200);
      expect(root.json()).toEqual({ ok: true });
      expect(root.headers["x-pcc-demo"]).toBeUndefined();

      // An unmatched path under the prefix is the ordinary 404, not the refusal.
      expect((await call({ method: "GET", url: "/api/orchestrator/nope" })).statusCode).toBe(404);
    });
  }

  it("control: the same plugin with skip-override WOULD gate a sibling, so the check above can fail", async () => {
    const leaky = Object.assign(async (i: FastifyInstance) => orchestratorRoutes(i), {
      [Symbol.for("skip-override")]: true,
    });
    const probe = Fastify({ logger: false });
    await probe.register(leaky);
    await probe.register(orchestratorTemplatesRoutes);
    await probe.ready();
    try {
      const res = await probe.inject({ method: "GET", url: "/api/orchestrator/templates" });
      expect(res.statusCode).toBe(501);
    } finally {
      await probe.close();
    }
  });
});

describe("the gate runs after the API-key gate (registered first, as in server.ts)", () => {
  let gated: FastifyInstance;
  let key: string;

  beforeAll(async () => {
    key = provisionApiKey({
      operatorId: "n34-orchestrator-probe",
      name: "n34 orchestrator probe",
      scopes: ["operator"],
    }).rawKey;
    gated = Fastify({ logger: false });
    await gated.register(apiGate);
    await gated.register(orchestratorRoutes);
    await gated.ready();
  });

  afterAll(async () => {
    await gated.close();
  });

  it("no key: 401 api_key_required on a read and a write, never the refusal", async () => {
    const read = await gated.inject({ method: "GET", url: "/api/orchestrator/graphs" });
    expect(read.statusCode).toBe(401);
    expect(read.json().error).toBe("api_key_required");
    const write = await gated.inject({ method: "POST", url: "/api/orchestrator/workflows", payload: NEW_WORKFLOW });
    expect(write.statusCode).toBe(401);
    expect(write.json().error).toBe("api_key_required");
  });

  it("with a key: the refusal outside demo, the marked demo answer with the flag on", async () => {
    const headers = { authorization: `Bearer ${key}` };
    const off = await gated.inject({ method: "GET", url: "/api/orchestrator/graphs", headers });
    expect(off.statusCode).toBe(501);
    expect(off.json().error).toBe("not_available");
    expect(off.body).not.toMatch(FIXTURE);
    process.env.PCC_DEMO_ROUTES = "true";
    const on = await gated.inject({ method: "GET", url: "/api/orchestrator/graphs", headers });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ graphs: [{ id: "graph-biolab-01" }], mock: true, demo: true });
  });
});
