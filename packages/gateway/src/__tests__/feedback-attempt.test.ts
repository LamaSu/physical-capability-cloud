/**
 * feedback-attempt.test.ts — ADK track item 3: `kind: "attempt"` reports on the
 * public POST /api/feedback route (contract attempt.v1).
 *
 * Covers the contract rules: required sessionId / seq / phase / outcome, enum
 * normalisation, secret AND email redaction, id / digest limits, transcripts never
 * stored, dedup on (sessionId, seq), no raw IP, principal hashing, the session
 * roll-up, Discord only for failed / blocked / budget_stop, the agent.attempt
 * audit event, admin filters, and a linear-time check on the email pattern.
 *
 * Env is read at module-load time, so the route is imported AFTER the env is set.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { auditService } from "../services/audit-service.js";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ADMIN_TOKEN = "test-admin-token-attempt";
const SID = "6f1c2a4e-8b7d-4c3f-9a21-0d5e6b7c8f90";
const SID2 = "0b8e7a1c-3d2f-4e5a-8b9c-1a2b3c4d5e6f";
const HEX64 = "a".repeat(64);

let tmpDir: string;
let feedbackFile: string;
let mod: typeof import("../routes/feedback.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "pcc-attempt-test-"));
  feedbackFile = join(tmpDir, "feedback.jsonl");
  process.env.PCC_DB_PATH = join(tmpDir, "pcc.sqlite");
  process.env.PCC_FEEDBACK_RATE_MAX = "50";
  process.env.WAITLIST_ADMIN_TOKEN = ADMIN_TOKEN;
  delete process.env.DISCORD_WEBHOOK_URL;
  mod = await import("../routes/feedback.js");
});

async function buildApp(opts: { apiKeyId?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  if (opts.apiKeyId) {
    app.decorateRequest("apiKeyId", null);
    app.addHook("onRequest", async (req) => {
      (req as unknown as { apiKeyId: string }).apiKeyId = opts.apiKeyId!;
    });
  }
  await app.register(mod.feedbackRoutes);
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  rmSync(feedbackFile, { force: true });
  mod.__resetFeedbackRateLimit();
  mod.__resetFeedbackDedup();
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

function attempt(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "attempt", contract: 1, sessionId: SID, seq: 1, phase: "register", outcome: "failed", ...extra };
}

async function post(payload: Record<string, unknown>, a: FastifyInstance = app) {
  return a.inject({ method: "POST", url: "/api/feedback", payload });
}

function storedLines(): string[] {
  return existsSync(feedbackFile) ? readFileSync(feedbackFile, "utf8").split("\n").filter(Boolean) : [];
}

function stored(): Array<Record<string, any>> {
  return storedLines().map((l) => JSON.parse(l));
}

async function admin(query = ""): Promise<{ total: number; items: any[] }> {
  const res = await app.inject({ method: "GET", url: `/api/admin/feedback${query}`, headers: { "x-admin-token": ADMIN_TOKEN } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("attempt reports: accepted shape", () => {
  it("stores a phase report with every contract field normalised", async () => {
    const res = await post(
      attempt({
        durationMs: 41200,
        summary: "POST /api/kernels returned 400: missing evidence tier",
        detail: "Tried twice.",
        logs: [{ step: 3, method: "post", path: "/api/kernels?x=1", status: 400, note: "evidenceTier required" }],
        ids: { kernelId: "kernel_abc-123", capabilityId: "pcc://capabilities/liquid-handling/v1", kitId: "kit:lh/1", jobId: "job_9" },
        device: { make: "Opentrons", model: "OT-2", class: "LAB_INSTRUMENT" },
        harness: { name: "Claude-Code", version: "2.3.1", model: "claude-opus-5-5" },
        pack: { version: "2.20.0", digest: `sha256:${"0123456789abcdef".repeat(4)}` },
        env: { os: "linux", python: "3.12.4", pccNode: "0.9.2" },
        tokens: { in: 1200, out: 340, source: "self_reported" },
        proposal: { target: "runbook", path: "runbook.json#register", text: "Ask for the evidence tier during intake" },
        traceId: "tr_abc",
        consent: { transcript: false },
      }),
    );
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ status: "ok", submitted: true, sessionId: SID });
    expect(body.id).toMatch(/^at-/);
    const [rec] = stored();
    expect(rec).toMatchObject({
      id: body.id,
      kind: "attempt",
      contract: "attempt.v1",
      sessionId: SID,
      seq: 1,
      phase: "register",
      outcome: "failed",
      durationMs: 41200,
      summary: "POST /api/kernels returned 400: missing evidence tier",
      detail: "Tried twice.",
      logs: [{ step: 3, method: "POST", path: "/api/kernels", status: 400, note: "evidenceTier required" }],
      ids: { kernelId: "kernel_abc-123", capabilityId: "pcc://capabilities/liquid-handling/v1", kitId: "kit:lh/1", jobId: "job_9" },
      device: { make: "Opentrons", model: "OT-2", class: "lab_instrument" },
      harness: { name: "claude-code", version: "2.3.1", model: "claude-opus-5-5" },
      pack: { version: "2.20.0", digestPrefix: "sha256:0123456789abcdef" },
      env: { os: "linux", python: "3.12.4", pccNode: "0.9.2" },
      tokens: { in: 1200, out: 340, source: "self_reported" },
      proposal: { target: "runbook", path: "runbook.json#register", text: "Ask for the evidence tier during intake" },
      traceId: "tr_abc",
      consent: { transcript: false },
      principal: "anonymous",
      status: "new",
    });
    expect(rec.createdAt).toBeTruthy();
  });

  it("fills a missing summary as '<phase>: <outcome>' (summary is optional for attempts)", async () => {
    expect((await post(attempt({ phase: "verify", outcome: "ok" }))).statusCode).toBe(201);
    expect(stored()[0].summary).toBe("verify: ok");
  });

  it("accepts every contract phase and outcome, and budget-stop as budget_stop", async () => {
    let seq = 0;
    for (const phase of mod.ATTEMPT_PHASES) {
      expect((await post(attempt({ seq: seq++, phase, outcome: "ok" }))).statusCode).toBe(201);
    }
    for (const outcome of mod.ATTEMPT_OUTCOMES) {
      expect((await post(attempt({ seq: seq++, outcome }))).statusCode).toBe(201);
    }
    expect((await post(attempt({ seq: seq++, outcome: "budget-stop" }))).statusCode).toBe(201);
    const recs = stored();
    expect(recs.map((r) => r.phase).slice(0, mod.ATTEMPT_PHASES.length)).toEqual([...mod.ATTEMPT_PHASES]);
    expect(recs.at(-1)!.outcome).toBe("budget_stop");
  });

  it("keeps an unknown phase or outcome as 'other' / 'unknown' with a redacted label, never a 400", async () => {
    await post(attempt({ phase: `calibrate pcc_live_${"x".repeat(20)}`, outcome: "exploded" }));
    const [rec] = stored();
    expect(rec.phase).toBe("other");
    expect(rec.phaseLabel).toBe("calibrate pcc_live_redacted");
    expect(rec.outcome).toBe("unknown");
    expect(rec.outcomeLabel).toBe("exploded");
  });
});

describe("attempt reports: required fields", () => {
  const bad: Array<[string, Record<string, unknown>, string]> = [
    ["a missing sessionId", { sessionId: undefined }, "sessionId"],
    ["free text as sessionId", { sessionId: "my session with alice@example.com" }, "sessionId"],
    ["a UUID v1 as sessionId", { sessionId: "6f1c2a4e-8b7d-1c3f-9a21-0d5e6b7c8f90" }, "sessionId"],
    ["a missing seq", { seq: undefined }, "seq"],
    ["a negative seq", { seq: -1 }, "seq"],
    ["a fractional seq", { seq: 1.5 }, "seq"],
    ["an over-range seq", { seq: 10_001 }, "seq"],
    ["a missing phase", { phase: undefined }, "phase"],
    ["a blank outcome", { outcome: "  " }, "outcome"],
  ];
  for (const [name, change, field] of bad) {
    it(`rejects ${name} with a 400 naming ${field}`, async () => {
      const res = await post(attempt(change));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "bad_request", field });
      expect(storedLines()).toHaveLength(0);
    });
  }
});

describe("attempt reports: redaction and limits", () => {
  it("redacts secrets AND emails in every free-text field", async () => {
    const secret = `pcc_live_${"k".repeat(24)}`;
    await post(
      attempt({
        summary: `failed for bob@example.com with ${secret}`,
        detail: `Bearer ${"t".repeat(30)} and 0x${HEX64}`,
        logs: [{ step: 1, note: "mail carol@lab.example.org" }],
        device: { make: "dave@example.com", model: `sk-${"s".repeat(20)}` },
        harness: { name: "codex", version: "1.0", model: "eve@example.com" },
        env: { os: "linux erin@example.com" },
        proposal: { target: "docs", path: "/docs/frank@example.com/x?token=abc", text: `use ${secret}` },
      }),
    );
    const line = storedLines()[0]!;
    for (const leak of ["bob@", "carol@", "dave@", "eve@", "erin@", "frank@", "k".repeat(24), "t".repeat(30), HEX64, "s".repeat(20), "token=abc"]) {
      expect(line).not.toContain(leak);
    }
    const rec = JSON.parse(line);
    expect(rec.summary).toBe("failed for [redacted-email] with pcc_live_redacted");
    expect(rec.logs[0].note).toBe("mail [redacted-email]");
    expect(rec.proposal.path).toBe("/docs/[redacted-email]/x");
  });

  it("keeps a public wallet address (40 hex) in free text", async () => {
    await post(attempt({ detail: `wallet 0x${"b".repeat(40)}` }));
    expect(stored()[0].detail).toBe(`wallet 0x${"b".repeat(40)}`);
  });

  it("keeps only id-shaped, secret-free ids", async () => {
    await post(attempt({ ids: { kernelId: "grace@example.com", capabilityId: `0x${HEX64}`, kitId: "kit 1; drop", jobId: "job_ok-1" } }));
    expect(stored()[0].ids).toEqual({ jobId: "job_ok-1" });
  });

  it("stores a pack digest only as a 16-hex prefix, and drops a malformed one", async () => {
    await post(attempt({ seq: 1, pack: { version: "2.20.0", digest: `sha256:${HEX64}` } }));
    await post(attempt({ seq: 2, pack: { digest: "md5:abc" } }));
    const [a, b] = stored();
    expect(a.pack).toEqual({ version: "2.20.0", digestPrefix: `sha256:${"a".repeat(16)}` });
    expect(storedLines()[0]).not.toContain(HEX64);
    expect(b.pack).toBeNull();
  });

  it("never guesses tokens: bad counts become null and a missing source becomes 'unknown'", async () => {
    await post(attempt({ tokens: { in: -5, out: "12", source: "made-up" } }));
    expect(stored()[0].tokens).toEqual({ in: null, out: 12, source: "unknown" });
  });

  it("maps an unknown harness or device class to 'other', keeping the harness label", async () => {
    await post(attempt({ harness: { name: "Cursor" }, device: { class: "toaster" } }));
    const rec = stored()[0];
    expect(rec.harness).toMatchObject({ name: "other", label: "Cursor" });
    expect(rec.device.class).toBe("other");
  });

  it("stores a proposal only when it has text, with the target defaulting to 'other'", async () => {
    await post(attempt({ seq: 1, proposal: { target: "runbook", path: "/x" } }));
    await post(attempt({ seq: 2, proposal: { target: "nonsense", text: "Add a dry-run step" } }));
    const [a, b] = stored();
    expect(a.proposal).toBeNull();
    expect(b.proposal).toEqual({ target: "other", path: null, text: "Add a dry-run step" });
  });

  it("matches emails in linear time on a pathological 64k input", () => {
    const hostile = ["a".repeat(64_000), `a@${"b.".repeat(30_000)}`, `${"x.".repeat(20_000)}@`];
    for (const h of hostile) {
      const t0 = performance.now();
      const res = mod.parseAttemptReport(attempt({ detail: h, summary: h }) as Record<string, unknown>);
      expect(res.ok).toBe(true);
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });
});

describe("attempt reports: transcripts (operator item 99)", () => {
  it("never stores a transcript, whatever consent says, and records that one was dropped", async () => {
    const res = await post(attempt({ transcript: "user: my key is hunter2\nagent: ok", consent: { transcript: true } }));
    expect(res.statusCode).toBe(201);
    const line = storedLines()[0]!;
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain('"transcript":"');
    const rec = JSON.parse(line);
    expect(rec.transcriptDropped).toBe(true);
    expect(rec.consent).toEqual({ transcript: true });
    expect("transcript" in rec).toBe(false);
  });

  it("records consent false by default and no transcriptDropped when none was sent", async () => {
    await post(attempt());
    const rec = stored()[0];
    expect(rec.consent).toEqual({ transcript: false });
    expect("transcriptDropped" in rec).toBe(false);
  });
});

describe("attempt reports: dedup, principal, roll-up", () => {
  it("collapses a retried report (same sessionId and seq) but keeps distinct seqs and sessions", async () => {
    expect((await post(attempt({ seq: 7 }))).statusCode).toBe(201);
    const retry = await post(attempt({ seq: 7, summary: "different text, same report" }));
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ deduped: true, submitted: false, sessionId: SID });
    expect((await post(attempt({ seq: 8 }))).statusCode).toBe(201);
    expect((await post(attempt({ sessionId: SID2, seq: 7 }))).statusCode).toBe(201);
    expect(storedLines()).toHaveLength(3);
  });

  it("stores no raw IP, and an authenticated principal only as a hash", async () => {
    await post(attempt());
    const anon = storedLines()[0]!;
    expect(anon).not.toContain("127.0.0.1");
    expect(JSON.parse(anon)).toMatchObject({ principal: "anonymous" });
    expect("principalHash" in JSON.parse(anon)).toBe(false);

    const keyed = await buildApp({ apiKeyId: "key_secret_id_123" });
    try {
      await post(attempt({ seq: 2 }), keyed);
    } finally {
      await keyed.close();
    }
    const line = storedLines()[1]!;
    expect(line).not.toContain("key_secret_id_123");
    expect(JSON.parse(line).principal).toBe("apiKey");
    expect(JSON.parse(line).principalHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the phases roll-up only on the session report, real phases only, at most 16", async () => {
    const rollup = [
      { phase: "intake", outcome: "ok", durationMs: 1000 },
      { phase: "register", outcome: "budget-stop" },
      { phase: "session", outcome: "ok" },
      { phase: "bogus", outcome: "ok" },
      ...Array.from({ length: 30 }, () => ({ phase: "verify", outcome: "failed" })),
    ];
    await post(attempt({ seq: 1, phase: "session", outcome: "abandoned", phases: rollup }));
    await post(attempt({ seq: 2, phase: "build", outcome: "ok", phases: rollup }));
    const [session, build] = stored();
    expect(session.phases[0]).toEqual({ phase: "intake", outcome: "ok", durationMs: 1000 });
    expect(session.phases[1]).toEqual({ phase: "register", outcome: "budget_stop", durationMs: null });
    expect(session.phases.some((p: { phase: string }) => p.phase === "session" || p.phase === "bogus")).toBe(false);
    expect(session.phases.length).toBeLessThanOrEqual(16);
    expect("phases" in build).toBe(false);
  });
});

describe("attempt reports: observability and admin", () => {
  it("logs an agent.attempt audit event with metadata only", async () => {
    const spy = vi.spyOn(auditService, "log").mockImplementation((() => undefined) as never);
    await post(attempt({ harness: { name: "codex" }, device: { class: "robot" }, proposal: { text: "x" }, transcript: "t" }));
    const call = spy.mock.calls.find((c) => (c[0] as { eventType: string }).eventType === "agent.attempt");
    expect(call).toBeDefined();
    const entry = call![0] as { actor: string; metadata: Record<string, unknown>; ip?: string };
    expect(entry.actor).toBe("anonymous");
    expect(entry.ip).toBeUndefined();
    expect(entry.metadata).toMatchObject({
      session_id: SID,
      seq: 1,
      phase: "register",
      outcome: "failed",
      harness: "codex",
      device_class: "robot",
      has_proposal: true,
      transcript_dropped: true,
    });
  });

  it("filters the admin read by kind and sessionId, and is unchanged without filters", async () => {
    await post({ type: "bug", summary: "classic report" });
    await post(attempt({ seq: 1 }));
    await post(attempt({ sessionId: SID2, seq: 1 }));
    expect((await admin()).total).toBe(3);
    expect((await admin("?kind=feedback")).items.map((r) => r.summary)).toEqual(["classic report"]);
    expect((await admin("?kind=attempt")).total).toBe(2);
    expect((await admin(`?kind=attempt&sessionId=${SID2.toUpperCase()}`)).items.map((r) => r.sessionId)).toEqual([SID2]);
  });

  it("leaves the classic path unchanged: no kind means a classic report, emails in its summary are not touched", async () => {
    const res = await post({ type: "bug", summary: "contact me at zoe@example.com" });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toMatch(/^fb-/);
    expect(stored()[0]).toMatchObject({ kind: "feedback", summary: "contact me at zoe@example.com" });
  });

  it("shares the per-IP rate limit with classic reports", async () => {
    for (let i = 0; i < 50; i++) await post(attempt({ seq: i }));
    expect((await post(attempt({ seq: 999 }))).statusCode).toBe(429);
  });
});

describe("attempt reports: Discord hears only failed / blocked / budget_stop", () => {
  it("notifies for alert outcomes only", async () => {
    vi.resetModules();
    process.env.DISCORD_WEBHOOK_URL = "https://discord.invalid/webhook";
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const fresh = await import("../routes/feedback.js");
      const a = Fastify({ logger: false });
      await a.register(fresh.feedbackRoutes);
      await a.ready();
      try {
        let seq = 0;
        for (const outcome of ["ok", "skipped", "in_progress", "abandoned", "failed", "blocked", "budget_stop"]) {
          await a.inject({ method: "POST", url: "/api/feedback", payload: attempt({ seq: seq++, outcome }) });
        }
        await new Promise((r) => setTimeout(r, 20));
        expect(fetchSpy).toHaveBeenCalledTimes(3);
      } finally {
        await a.close();
      }
    } finally {
      vi.unstubAllGlobals();
      delete process.env.DISCORD_WEBHOOK_URL;
    }
  });
});
