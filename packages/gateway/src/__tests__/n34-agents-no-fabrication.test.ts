/**
 * The agent-conversation routes never pass fixtures off as live data (board N34, the
 * server side of PX-3).
 *
 * GET /api/agents/conversations and /:convId answered from two hard-coded conversations
 * (topics, participant agents, message counts, timestamps). They read no agent bus.
 *
 * Now, unless PCC_DEMO_ROUTES=true, both answer 501 not_available and point at
 * GET /api/agents/live/conversations, the route that reads the gateway's agent bus. With
 * the flag, the old answers come back marked mock/demo. The gate is one onRequest hook
 * encapsulated to this plugin; the last block proves the other /api/agents/* routes (the
 * heartbeat plugin) never see it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { agentRoutes } from "../routes/agents.js";
import { agentHeartbeatRoutes } from "../routes/agent-heartbeat.js";
import { initStore, closeStore } from "../db.js";

// Values only the fixtures carry. None may appear in a refusal.
const FIXTURE = /conv-0|FDM capability discovery|CNC quote request|user-agent|broker-agent|kernel-(nyc|sf)-agent|messageCount|2026-03-03/;
const REFUSAL = {
  error: "not_available",
  message:
    "Agent conversations are not recorded by this route, so nothing is returned rather than an example. " +
    "The gateway's live agent bus is read at GET /api/agents/live/conversations.",
  see: ["GET /api/agents/live/conversations"],
};

type Case = { url: string; old: (body: any) => void };

const CASES: Case[] = [
  {
    url: "/api/agents/conversations",
    old: (b) => expect(b.conversations.map((c: { id: string }) => c.id)).toEqual(["conv-001", "conv-002"]),
  },
  {
    url: "/api/agents/conversations/conv-001",
    old: (b) => expect(b.conversation).toMatchObject({ id: "conv-001", topic: "FDM capability discovery" }),
  },
];

const ENV = ["PCC_DEMO_ROUTES", "PCC_DB_PATH"] as const;
const saved: Record<string, string | undefined> = {};
let app: FastifyInstance;

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  delete process.env.PCC_DEMO_ROUTES;
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  app = Fastify({ logger: false });
  // Siblings: a root route declared before the plugin, and the real /api/agents/*
  // heartbeat plugin registered after it (the order in which a leaked hook would reach it).
  app.get("/probe/root", async () => ({ ok: true }));
  await app.register(agentRoutes);
  await app.register(agentHeartbeatRoutes);
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
});

const get = (url: string) => app.inject({ method: "GET", url });

describe("NEGATIVE: without PCC_DEMO_ROUTES the conversation routes refuse (501 not_available)", () => {
  for (const c of CASES) {
    it(`GET ${c.url} -> 501, nothing from the fixtures, and a pointer to the live route`, async () => {
      const res = await get(c.url);
      expect(res.statusCode, res.body).toBe(501);
      // The refusal is the whole body: nothing else rides along.
      expect(res.json()).toEqual(REFUSAL);
      expect(res.body).not.toMatch(FIXTURE);
      expect(res.headers["x-pcc-demo"]).toBeUndefined();
    });
  }

  it("only the literal \"true\" turns demo on", async () => {
    for (const v of ["false", "1", "TRUE", "yes", ""]) {
      process.env.PCC_DEMO_ROUTES = v;
      const res = await get("/api/agents/conversations");
      expect(res.statusCode, `PCC_DEMO_ROUTES=${JSON.stringify(v)}`).toBe(501);
    }
  });

  it("an unknown id is refused the same way (no fixture lookup, no not_found oracle)", async () => {
    const res = await get("/api/agents/conversations/conv-none");
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual(REFUSAL);
  });
});

describe("PCC_DEMO_ROUTES=true: the old answers, each marked mock/demo", () => {
  beforeEach(() => {
    process.env.PCC_DEMO_ROUTES = "true";
  });

  for (const c of CASES) {
    it(`GET ${c.url} -> 200 with mock:true, demo:true`, async () => {
      const res = await get(c.url);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ mock: true, demo: true });
      expect(res.headers["x-pcc-demo"]).toBe("true");
      c.old(body);
    });
  }

  it("the old not_found answer stays as it was (200), and is marked demo too", async () => {
    const res = await get("/api/agents/conversations/conv-none");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ error: "not_found", mock: true, demo: true });
  });
});

describe("the gate is encapsulated to the agent-conversations plugin", () => {
  for (const demo of [false, true]) {
    it(`the heartbeat plugin and a root route are untouched with PCC_DEMO_ROUTES ${demo ? "on" : "off"}`, async () => {
      if (demo) process.env.PCC_DEMO_ROUTES = "true";
      const health = await get("/api/agents/health");
      expect(health.statusCode, health.body).toBe(200);
      expect(health.json()).toEqual({ agents: [], source: "monitor_not_initialized" });
      expect(health.headers["x-pcc-demo"]).toBeUndefined();

      const beat = await app.inject({ method: "POST", url: "/api/agents/heartbeat", payload: { agentId: "agent-x" } });
      expect(beat.statusCode, beat.body).toBe(200);
      expect(beat.json()).toEqual({ ok: true, agentId: "agent-x", note: "monitor_not_ready" });
      expect(beat.headers["x-pcc-demo"]).toBeUndefined();

      const root = await get("/probe/root");
      expect(root.statusCode).toBe(200);
      expect(root.json()).toEqual({ ok: true });
      expect(root.headers["x-pcc-demo"]).toBeUndefined();
    });
  }

  it("control: the same plugin with skip-override WOULD gate a sibling, so the check above can fail", async () => {
    const leaky = Object.assign(async (i: FastifyInstance) => agentRoutes(i), {
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
