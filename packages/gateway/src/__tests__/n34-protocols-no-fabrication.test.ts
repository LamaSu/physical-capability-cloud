/**
 * Protocol routes never pass fixtures off as live data (board N34, the server side of PX-3).
 *
 * Every route in protocols.ts answered from fixtures that nothing records: a two-template
 * "library" with invented authors and usage (runCount 7, rating 4.6), a "running" protocol
 * run on a made-up kernel with evidence hashes and robot transfer episodes, a fork,
 * automation statuses and transfer agents. The writes (create, update, publish, fork, start
 * a run, pause, resume, cancel, record an episode, advance a level) answered created,
 * updated, started or recorded and stored nothing, and /validate checked against a
 * hard-coded capability list.
 *
 * All 21 routes are SERVED-MOCK, so the plugin is gated by ONE encapsulated onRequest hook:
 * unless PCC_DEMO_ROUTES=true, each answers 501 not_available before anything is parsed or
 * read. With the flag, the old answers come back marked mock/demo. The hook must not leak:
 * checked below against a real DB-backed plugin (jobs, the real home of run state) and root
 * routes, with a control that proves the check can fail. It also sits behind the API-key
 * gate (401 without a key).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { protocolRoutes } from "../routes/protocols.js";
import { jobRoutes } from "../routes/jobs.js";
import { apiGate } from "../middleware/api-gate.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { initStore, closeStore } from "../db.js";

type Method = "GET" | "POST" | "PUT";

/** Values only the fixtures (or the fabricated write answers) carry. None may appear in a refusal. */
const FIXTURE =
  /ptpl_|pfork_|prun_|Serum Protein|Sarah Chen|user_dr_chen|Mike Torres|user_machinist_mike|user_lab_tech_j|job-bio-42|kernel-biolab-01|tagent-|R2D3|Jamie Lin|SmolVLA|astatus-|sha256:|ep-transfer|node-(liquid|centrifuge|hplc|inspect)|"(created|updated|published|accepted|started|paused|resumed|cancelled|recorded|advanced|valid)":/;

const RETURNED = "is not recorded on this gateway, so nothing is returned rather than an example.";
const TEMPLATES = "Protocol template data is not recorded on this gateway";
const RUNS = "Protocol run data is not recorded on this gateway";
const AUTOMATION = "Transfer automation data is not recorded on this gateway";

const BIOASSAY = "ptpl_bioassay001";
const RUN = "prun_active_001";

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
  // ── Templates ──
  {
    method: "GET",
    url: "/api/protocols",
    message: `Protocol template data ${RETURNED}`,
    see: [],
    demoStatus: 200,
    demo: (b) => {
      expect(b.total).toBe(2);
      expect(b.templates.map((t: { id: string }) => t.id)).toEqual([BIOASSAY, "ptpl_3dprint_qc001"]);
    },
  },
  {
    // The old filters still apply in demo mode.
    method: "GET",
    url: "/api/protocols?tags=biotech&status=published",
    message: `Protocol template data ${RETURNED}`,
    see: [],
    demoStatus: 200,
    demo: (b) => expect(b.templates.map((t: { id: string }) => t.id)).toEqual([BIOASSAY]),
  },
  {
    method: "GET",
    url: `/api/protocols/${BIOASSAY}`,
    message: `Protocol template data ${RETURNED}`,
    see: [],
    demoStatus: 200,
    demo: (b) => expect(b.template).toMatchObject({ id: BIOASSAY, name: "Serum Protein Analysis", runCount: 7 }),
  },
  {
    method: "POST",
    url: "/api/protocols",
    payload: { name: "N34 probe protocol" },
    message: `${TEMPLATES}, so no template was created.`,
    see: [],
    demoStatus: 201,
    demo: (b) => {
      expect(b).toMatchObject({ created: true, name: "N34 probe protocol", status: "draft" });
      expect(b.id).toMatch(/^ptpl_/);
    },
  },
  {
    method: "PUT",
    url: `/api/protocols/${BIOASSAY}`,
    payload: { name: "N34 renamed" },
    message: `${TEMPLATES}, so no template was updated.`,
    see: [],
    demoStatus: 200,
    demo: (b) => expect(b).toMatchObject({ updated: true, id: BIOASSAY, name: "N34 renamed", version: "1.2.0" }),
  },
  {
    method: "POST",
    url: "/api/protocols/ptpl_3dprint_qc001/publish",
    message: `${TEMPLATES}, so nothing was published.`,
    see: [],
    demoStatus: 200,
    demo: (b) => expect(b).toMatchObject({ published: true, id: "ptpl_3dprint_qc001", status: "published" }),
  },
  {
    method: "POST",
    url: `/api/protocols/${BIOASSAY}/fork`,
    payload: { name: "N34 fork" },
    message: `${TEMPLATES}, so no fork was created.`,
    see: [],
    demoStatus: 201,
    demo: (b) => {
      expect(b).toMatchObject({ created: true, sourceTemplateId: BIOASSAY, sourceTemplateVersion: "1.2.0", name: "N34 fork" });
      expect(b.forkId).toMatch(/^pfork_/);
    },
  },
  {
    method: "GET",
    url: `/api/protocols/${BIOASSAY}/forks`,
    message: `Protocol fork data ${RETURNED}`,
    see: [],
    demoStatus: 200,
    demo: (b) => expect(b).toMatchObject({ total: 1, forks: [{ id: "pfork_highvol_001" }] }),
  },
  {
    method: "POST",
    url: `/api/protocols/${BIOASSAY}/validate`,
    payload: { kernelId: "kernel-n34-probe" },
    message: `${TEMPLATES}, so nothing was validated.`,
    see: ["GET /api/capabilities/by-kernel/:kernelId"],
    demoStatus: 200,
    demo: (b) => {
      expect(b).toMatchObject({ valid: true, templateId: BIOASSAY, kernelId: "kernel-n34-probe", stepCount: 4, transferCount: 3 });
      expect(b.missingCapabilities).toEqual([]);
      expect(b.transferWarnings.map((w: { transferId: string }) => w.transferId)).toEqual(["ptx-002"]);
    },
  },
  // ── Runs ──
  {
    method: "GET",
    url: `/api/protocols/${BIOASSAY}/runs`,
    message: `Protocol run data ${RETURNED}`,
    see: ["GET /api/jobs"],
    demoStatus: 200,
    demo: (b) => expect(b).toMatchObject({ total: 1, runs: [{ id: RUN, status: "running" }] }),
  },
  {
    method: "GET",
    url: "/api/protocol-runs",
    message: `Protocol run data ${RETURNED}`,
    see: ["GET /api/jobs"],
    demoStatus: 200,
    demo: (b) => expect(b).toMatchObject({ total: 1, runs: [{ id: RUN }] }),
  },
  {
    method: "GET",
    url: "/api/protocol-runs?status=running&kernelId=kernel-biolab-01",
    message: `Protocol run data ${RETURNED}`,
    see: ["GET /api/jobs"],
    demoStatus: 200,
    demo: (b) => expect(b.total).toBe(1),
  },
  {
    method: "GET",
    url: `/api/protocol-runs/${RUN}`,
    message: `Protocol run data ${RETURNED}`,
    see: ["GET /api/jobs/:jobId"],
    demoStatus: 200,
    demo: (b) => expect(b.run).toMatchObject({ id: RUN, jobId: "job-bio-42", status: "running", currentStepIndex: 2 }),
  },
  {
    method: "POST",
    url: `/api/protocols/${BIOASSAY}/runs`,
    payload: { kernelId: "kernel-n34-probe" },
    message: `${RUNS}, so no run was created or started.`,
    see: ["POST /api/jobs/submit"],
    demoStatus: 202,
    demo: (b) => {
      expect(b).toMatchObject({ accepted: true, templateId: BIOASSAY, kernelId: "kernel-n34-probe", status: "binding" });
      expect(b.runId).toMatch(/^prun_/);
    },
  },
  {
    // The only fixture run is "running", so the old answer is the 409.
    method: "POST",
    url: `/api/protocol-runs/${RUN}/start`,
    message: `${RUNS}, so no run was started.`,
    see: [],
    demoStatus: 409,
    demo: (b) => expect(b).toMatchObject({ error: "invalid_state", message: "Cannot start run in status 'running'" }),
  },
  {
    method: "POST",
    url: `/api/protocol-runs/${RUN}/pause`,
    message: `${RUNS}, so no run was paused.`,
    see: [],
    demoStatus: 200,
    demo: (b) => expect(b).toMatchObject({ paused: true, runId: RUN, status: "paused" }),
  },
  {
    method: "POST",
    url: `/api/protocol-runs/${RUN}/resume`,
    message: `${RUNS}, so no run was resumed.`,
    see: [],
    demoStatus: 409,
    demo: (b) => expect(b).toMatchObject({ error: "invalid_state", message: "Cannot resume run in status 'running'" }),
  },
  {
    method: "POST",
    url: `/api/protocol-runs/${RUN}/cancel`,
    message: `${RUNS}, so no run was cancelled.`,
    see: [],
    demoStatus: 200,
    demo: (b) => expect(b).toMatchObject({ cancelled: true, runId: RUN, status: "cancelled" }),
  },
  // ── Transfer automation ──
  {
    method: "GET",
    url: "/api/automation-status",
    message: `Transfer automation data ${RETURNED}`,
    see: [],
    demoStatus: 200,
    demo: (b) => expect(b.total).toBe(2),
  },
  {
    method: "GET",
    url: "/api/automation-status?kernelId=kernel-biolab-01",
    message: `Transfer automation data ${RETURNED}`,
    see: [],
    demoStatus: 200,
    demo: (b) => expect(b.statuses).toHaveLength(2),
  },
  {
    method: "GET",
    url: "/api/automation-status/node-liquid/node-centrifuge",
    message: `Transfer automation data ${RETURNED}`,
    see: [],
    demoStatus: 200,
    demo: (b) => expect(b.status).toMatchObject({ id: "astatus-liq-centri", currentLevel: "manual", episodeCount: 5 }),
  },
  {
    method: "POST",
    url: "/api/automation-status/node-centrifuge/node-hplc/episode",
    payload: { episodeId: "ep-n34-probe", success: true },
    message: `${AUTOMATION}, so no episode was recorded.`,
    see: [],
    demoStatus: 200,
    demo: (b) => expect(b).toMatchObject({ recorded: true, episodeCount: 46, minEpisodesForTraining: 50, readyForTraining: false }),
  },
  {
    method: "POST",
    url: "/api/automation-status/node-liquid/node-centrifuge/advance",
    message: `${AUTOMATION}, so no automation level was changed.`,
    see: [],
    demoStatus: 200,
    demo: (b) => expect(b).toMatchObject({ advanced: true, previousLevel: "manual", newLevel: "teleoperated" }),
  },
  {
    method: "GET",
    url: "/api/transfer-agents",
    message: `Transfer agent data ${RETURNED}`,
    see: [],
    demoStatus: 200,
    demo: (b) => expect(b.agents.map((a: { id: string }) => a.id)).toEqual(["tagent-r2d3-alpha", "tagent-manual-op01"]),
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
  // Siblings: a root route declared before the plugin, and a real DB-backed plugin
  // registered after it (the order in which a leaked hook would reach it).
  app.get("/probe/root", async () => ({ ok: true }));
  await app.register(protocolRoutes);
  await app.register(jobRoutes);
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

describe("NEGATIVE: without PCC_DEMO_ROUTES every protocol route refuses (501 not_available)", () => {
  it("every route the plugin registers (21) is refused with its own message, none with the fallback", async () => {
    const FALLBACK = `Protocol data ${RETURNED}`;
    const registered: Array<{ method: string; url: string }> = [];
    const probe = Fastify({ logger: false });
    probe.addHook("onRoute", (r) => {
      for (const m of Array.isArray(r.method) ? r.method : [r.method]) {
        if (m !== "HEAD") registered.push({ method: m, url: r.url });
      }
    });
    await probe.register(protocolRoutes);
    await probe.ready();
    try {
      expect(registered).toHaveLength(21);
      // The table above exercises each of them.
      expect(new Set(GATED.map((c) => `${c.method} ${c.url.split("?")[0]}`)).size).toBe(21);
      for (const r of registered) {
        const res = await probe.inject({ method: r.method as Method, url: r.url.replace(/:[A-Za-z]+/g, "x") });
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(501);
        expect(res.json().message, `${r.method} ${r.url}`).not.toBe(FALLBACK);
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
      const res = await call({ method: "GET", url: "/api/protocols" });
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

  it("unknown ids are refused the same way (no fixture lookup, no not_found oracle)", async () => {
    for (const c of [
      { method: "GET" as const, url: "/api/protocols/ptpl_none" },
      { method: "PUT" as const, url: "/api/protocols/ptpl_none" },
      { method: "POST" as const, url: "/api/protocols/ptpl_none/publish" },
      { method: "GET" as const, url: "/api/protocol-runs/prun_none" },
      { method: "POST" as const, url: "/api/protocol-runs/prun_none/cancel" },
      { method: "GET" as const, url: "/api/automation-status/node-a/node-b" },
      { method: "POST" as const, url: "/api/automation-status/node-a/node-b/advance" },
    ]) {
      const res = await call(c);
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(501);
      expect(res.json().error).toBe("not_available");
      expect(res.body).not.toMatch(FIXTURE);
    }
  });

  it("writes refuse a malformed body with 501, not a 400: the gate runs before parsing", async () => {
    for (const [method, url] of [
      ["POST", "/api/protocols"],
      ["PUT", `/api/protocols/${BIOASSAY}`],
      ["POST", `/api/protocols/${BIOASSAY}/runs`],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { "content-type": "application/json" },
        payload: "{not json",
      });
      expect(res.statusCode, `${method} ${url}`).toBe(501);
      expect(res.json().error).toBe("not_available");
    }
  });

  it("HEAD is refused too", async () => {
    const res = await call({ method: "HEAD", url: "/api/protocol-runs" });
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

  it("demo errors keep their old status and are marked (404 unknown template, 409 already published)", async () => {
    const missing = await call({ method: "GET", url: "/api/protocols/ptpl_none" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: "not_found",
      message: "Protocol template not found",
      mock: true,
      demo: true,
    });
    const published = await call({ method: "POST", url: `/api/protocols/${BIOASSAY}/publish` });
    expect(published.statusCode).toBe(409);
    expect(published.json()).toMatchObject({ error: "already_published", mock: true, demo: true });
  });
});

describe("the gate is encapsulated to the protocols plugin", () => {
  for (const demo of [false, true]) {
    it(`siblings are untouched with PCC_DEMO_ROUTES ${demo ? "on" : "off"}`, async () => {
      if (demo) process.env.PCC_DEMO_ROUTES = "true";

      const jobs = await call({ method: "GET", url: "/api/jobs" });
      expect(jobs.statusCode, jobs.body).toBe(200);
      expect(jobs.json().jobs.length).toBeGreaterThan(0);
      expect(jobs.json()).not.toHaveProperty("mock");
      expect(jobs.json()).not.toHaveProperty("demo");
      expect(jobs.headers["x-pcc-demo"]).toBeUndefined();

      const root = await call({ method: "GET", url: "/probe/root" });
      expect(root.statusCode).toBe(200);
      expect(root.json()).toEqual({ ok: true });
      expect(root.headers["x-pcc-demo"]).toBeUndefined();

      // An unmatched path next to the plugin's is the ordinary 404, not the refusal.
      expect((await call({ method: "GET", url: "/api/protocols-nope" })).statusCode).toBe(404);
    });
  }

  it("control: the same plugin with skip-override WOULD gate a sibling, so the check above can fail", async () => {
    const leaky = Object.assign(async (i: FastifyInstance) => protocolRoutes(i), {
      [Symbol.for("skip-override")]: true,
    });
    const probe = Fastify({ logger: false });
    await probe.register(leaky);
    probe.get("/probe/after", async () => ({ ok: true }));
    await probe.ready();
    try {
      const res = await probe.inject({ method: "GET", url: "/probe/after" });
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
      operatorId: "n34-protocols-probe",
      name: "n34 protocols probe",
      scopes: ["operator"],
    }).rawKey;
    gated = Fastify({ logger: false });
    await gated.register(apiGate);
    await gated.register(protocolRoutes);
    await gated.ready();
  });

  afterAll(async () => {
    await gated.close();
  });

  it("no key: 401 api_key_required on a read and a write, never the refusal", async () => {
    const read = await gated.inject({ method: "GET", url: "/api/protocols" });
    expect(read.statusCode).toBe(401);
    expect(read.json().error).toBe("api_key_required");
    const write = await gated.inject({ method: "POST", url: `/api/protocols/${BIOASSAY}/runs`, payload: {} });
    expect(write.statusCode).toBe(401);
    expect(write.json().error).toBe("api_key_required");
  });

  it("with a key: the refusal outside demo, the marked demo answer with the flag on", async () => {
    const headers = { authorization: `Bearer ${key}` };
    const off = await gated.inject({ method: "GET", url: "/api/protocols", headers });
    expect(off.statusCode).toBe(501);
    expect(off.json().error).toBe("not_available");
    expect(off.body).not.toMatch(FIXTURE);
    process.env.PCC_DEMO_ROUTES = "true";
    const on = await gated.inject({ method: "GET", url: "/api/protocols", headers });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ total: 2, mock: true, demo: true });
  });
});
