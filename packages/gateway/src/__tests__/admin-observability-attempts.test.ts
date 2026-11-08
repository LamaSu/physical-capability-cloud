/**
 * admin-observability-attempts.test.ts — ADK track item 10a: the admin view
 * GET /api/admin/observability/attempts over the attempt reports stored in the
 * durable feedback JSONL. SYNTHETIC records only.
 *
 * Covers: the fail-closed admin gate, analysis over attempt records only
 * (classic reports, malformed lines and records older than `days` ignored),
 * bounded query params, the tail-scan cap, a missing sink, and session rows
 * that carry no report bodies.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let feedbackFile: string;
let adminObservabilityRoutes: typeof import("../routes/admin-observability.js").adminObservabilityRoutes;
let attemptScanBytes: typeof import("../routes/admin-observability.js").attemptScanBytes;

const ADMIN = "op-admin";
const SID_A = "aa000000-0000-4000-8000-00000000000a";
const SID_B = "bb000000-0000-4000-8000-00000000000b";
const envKeys = ["NODE_ENV", "PCC_OBSERVABILITY_ADMINS", "PCC_OBSERVABILITY_DEV_OPEN", "PCC_ATTEMPT_SCAN_MAX_BYTES"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "pcc-attempts-view-"));
  feedbackFile = join(tmpDir, "feedback.jsonl");
  process.env.PCC_DB_PATH = join(tmpDir, "pcc.sqlite");
  ({ adminObservabilityRoutes, attemptScanBytes } = await import("../routes/admin-observability.js"));
});

async function buildApp(operatorId: string | null): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("operatorId", null);
  app.addHook("onRequest", async (req) => {
    (req as unknown as { operatorId: string | null }).operatorId = operatorId;
  });
  await app.register(adminObservabilityRoutes);
  await app.ready();
  return app;
}

function attempt(sessionId: string, seq: number, phase: string, outcome: string, extra: Record<string, unknown> = {}) {
  return {
    id: `at-${sessionId.slice(0, 4)}-${seq}`,
    kind: "attempt",
    contract: "attempt.v1",
    sessionId,
    seq,
    phase,
    outcome,
    durationMs: 1000,
    summary: `${phase}: ${outcome}`,
    detail: "private detail text",
    logs: null,
    harness: { name: "claude-code", version: "1", model: "m" },
    device: { make: "Opentrons", model: "OT-2", class: "lab_instrument" },
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    ...extra,
  };
}

function writeSink(lines: Array<Record<string, unknown> | string>): void {
  writeFileSync(feedbackFile, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n", "utf8");
}

async function get(app: FastifyInstance, query = "") {
  return app.inject({ method: "GET", url: `/api/admin/observability/attempts${query}` });
}

beforeEach(() => {
  for (const k of envKeys) savedEnv[k] = process.env[k];
  process.env.NODE_ENV = "production";
  process.env.PCC_OBSERVABILITY_ADMINS = ADMIN;
  delete process.env.PCC_OBSERVABILITY_DEV_OPEN;
  delete process.env.PCC_ATTEMPT_SCAN_MAX_BYTES;
  rmSync(feedbackFile, { force: true });
});

afterEach(() => {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("GET /api/admin/observability/attempts: gate", () => {
  it("fails closed in production without an allowlist", async () => {
    delete process.env.PCC_OBSERVABILITY_ADMINS;
    const app = await buildApp(ADMIN);
    try {
      expect((await get(app)).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("refuses an operator who is not on the allowlist, and an anonymous caller", async () => {
    for (const who of ["op-someone-else", null]) {
      const app = await buildApp(who);
      try {
        expect((await get(app)).statusCode).toBe(403);
      } finally {
        await app.close();
      }
    }
  });
});

describe("GET /api/admin/observability/attempts: analysis", () => {
  it("analyses attempt records only, ignoring classic reports, malformed lines and old records", async () => {
    writeSink([
      { id: "fb-1", kind: "feedback", type: "bug", summary: "classic attempt-looking report", createdAt: new Date().toISOString() },
      attempt(SID_A, 0, "intake", "ok"),
      attempt(SID_A, 1, "register", "failed", { summary: "POST /api/kernels returned 400", logs: [{ step: 1, method: "POST", path: "/api/kernels", status: 400 }] }),
      attempt(SID_A, 2, "session", "failed"),
      attempt(SID_B, 0, "intake", "ok", { harness: { name: "codex" } }),
      attempt(SID_B, 1, "session", "ok"),
      "{not json attempt",
      attempt("cc000000-0000-4000-8000-00000000000c", 0, "intake", "failed", { createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString() }),
    ]);
    const app = await buildApp(ADMIN);
    try {
      const res = await get(app);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.source).toBe("feedback_jsonl");
      expect(body.days).toBe(30);
      expect(body.records).toBe(5);
      expect(body.scan_truncated).toBe(false);
      expect(body.totals).toMatchObject({ sessions: 2, finishedOk: 1, failedOrBlocked: 1, harnessSplit: { "claude-code": 1, codex: 1 } });
      expect(body.signatures).toHaveLength(1);
      expect(body.signatures[0].template.startsWith("register/failed POST /api/kernels 400")).toBe(true);
      const intake = body.funnel.find((r: { phase: string }) => r.phase === "intake");
      expect(intake).toMatchObject({ reached: 2, ok: 2 });
      expect(body.sessions.map((s: { session_id: string }) => s.session_id).sort()).toEqual([SID_A, SID_B].sort());
    } finally {
      await app.close();
    }
  });

  it("returns session rows without report bodies", async () => {
    writeSink([attempt(SID_A, 0, "intake", "ok"), attempt(SID_A, 1, "session", "ok")]);
    const app = await buildApp(ADMIN);
    try {
      const body = (await get(app)).json();
      const row = body.sessions[0];
      expect(Object.keys(row).sort()).toEqual(
        ["budget_stop", "device_class", "final_outcome", "first_at", "harness", "last_at", "last_phase", "pack_version", "proposals", "reports", "session_id", "stalled", "total_duration_ms"].sort(),
      );
      expect(JSON.stringify(body.sessions)).not.toContain("private detail text");
    } finally {
      await app.close();
    }
  });

  it("bounds days and sessions", async () => {
    writeSink(Array.from({ length: 30 }, (_, i) => attempt(`dd0000${String(i).padStart(2, "0")}-0000-4000-8000-000000000000`, 0, "intake", "ok")));
    const app = await buildApp(ADMIN);
    try {
      expect((await get(app, "?days=1000")).json().days).toBe(90);
      expect((await get(app, "?days=-3")).json().days).toBe(30);
      expect((await get(app, "?sessions=5")).json().sessions).toHaveLength(5);
      expect((await get(app, "?sessions=100000")).json().sessions).toHaveLength(30);
    } finally {
      await app.close();
    }
  });

  it("scans only the sink's tail when the sink is larger than the cap", async () => {
    const records = Array.from({ length: 40 }, (_, i) => attempt(SID_A, i, "build", "ok", { summary: `step ${i} ${"x".repeat(200)}` }));
    writeSink(records);
    process.env.PCC_ATTEMPT_SCAN_MAX_BYTES = "3000";
    const app = await buildApp(ADMIN);
    try {
      const body = (await get(app)).json();
      expect(body.scan_truncated).toBe(true);
      expect(body.records).toBeGreaterThan(0);
      expect(body.records).toBeLessThan(40);
      expect(body.sessions[0].reports).toBe(body.records);
    } finally {
      await app.close();
    }
  });

  it("returns an empty analysis when the sink does not exist", async () => {
    const app = await buildApp(ADMIN);
    try {
      const res = await get(app);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ records: 0, scan_truncated: false, sessions: [], signatures: [] });
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/admin/observability/attempts: F2 proposal examples redaction", () => {
  it("omits proposal examples (verbatim public report text) from the JSON view", async () => {
    writeSink([
      attempt(SID_A, 0, "register", "failed", {
        proposal: { target: "code", path: "x.ts", text: "Patient Alice has condition X" },
      }),
    ]);
    const app = await buildApp(ADMIN);
    try {
      const body = (await get(app)).json();
      expect(body.proposals.length).toBeGreaterThan(0);
      for (const group of body.proposals) {
        expect(group).not.toHaveProperty("examples");
        expect(Object.keys(group).sort()).toEqual(["count", "routeTo", "sessions", "target"]);
      }
      expect(JSON.stringify(body.proposals)).not.toContain("Patient Alice");
    } finally {
      await app.close();
    }
  });
});

describe("attemptScanBytes: F5 ceiling", () => {
  it("clamps an oversized configured value to 200 MB (209715200)", () => {
    process.env.PCC_ATTEMPT_SCAN_MAX_BYTES = String(500 * 1024 * 1024); // 500MB misconfiguration
    expect(attemptScanBytes()).toBe(209715200);
  });

  it("still honors a value within the ceiling", () => {
    process.env.PCC_ATTEMPT_SCAN_MAX_BYTES = "1000";
    expect(attemptScanBytes()).toBe(1000);
  });

  it("falls back to the 20MB default when unset or invalid", () => {
    delete process.env.PCC_ATTEMPT_SCAN_MAX_BYTES;
    expect(attemptScanBytes()).toBe(20 * 1024 * 1024);
    process.env.PCC_ATTEMPT_SCAN_MAX_BYTES = "-5";
    expect(attemptScanBytes()).toBe(20 * 1024 * 1024);
  });
});

describe("GET /api/admin/observability/attempts?format=digest", () => {
  it("returns the Markdown digest, bounded, with no session ids or emails, behind the same gate", async () => {
    writeSink([
      attempt(SID_A, 0, "register", "failed", { summary: "POST /api/kernels returned 400 for grace@example.com" }),
      attempt(SID_A, 1, "session", "failed"),
    ]);
    const app = await buildApp(ADMIN);
    try {
      const res = await get(app, "?format=digest&days=7");
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/markdown");
      expect(res.body.startsWith("# Attempt digest — last 7 days to ")).toBe(true);
      expect(Buffer.byteLength(res.body, "utf8")).toBeLessThanOrEqual(3000);
      expect(res.body).not.toContain(SID_A);
      expect(res.body).not.toContain("grace@example.com");
    } finally {
      await app.close();
    }
    const outsider = await buildApp("op-someone-else");
    try {
      expect((await get(outsider, "?format=digest")).statusCode).toBe(403);
    } finally {
      await outsider.close();
    }
  });
});
