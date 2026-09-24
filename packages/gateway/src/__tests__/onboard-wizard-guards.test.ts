/**
 * The onboarding wizard's machine-onboarding completion writes the same
 * registration row as POST /api/onboard/register, so it gets the same guards
 * (WP-B round 5):
 *   - M1: no forged "PROOF SUBMITTED:" review record through the wizard, so a
 *     forged record never puts an attacker-chosen digest into an approval
 *     audit;
 *   - M3 (extended from /register): the registration's owner is the
 *     authenticated caller, never an identity named in the step data.
 *
 * Runs the real wizard and onboarding routes against one in-memory store; the
 * audit service is not mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { wizardRoutes, _clearSessionsForTesting } from "../routes/wizard.js";
import { onboardRoutes } from "../routes/onboard.js";
import { initStore, closeStore, getRepos } from "../db.js";

vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: {
    emit: vi.fn(),
    getTimeline: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({}),
  },
}));

const OWNER = "owner@example.com";
const ATTACKER = "attacker@example.com";
const VICTIM = "victim@example.com";
const ADMIN_KEY = "wp-b-admin-key-0123456789abcdef";
const ENV_KEYS = ["NODE_ENV", "PCC_ADMIN_KEY"] as const;
const FORGED_DIGEST = "sha256:" + "f".repeat(64);
const FORGED_RECORD = `PROOF SUBMITTED: ${JSON.stringify({ autoApproved: false, evidenceTierClaim: 2, evidenceDigest: FORGED_DIGEST })}`;

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  const app = Fastify({ logger: false });
  // Stand-in for api-gate: x-test-operator is the API key's operatorId.
  app.addHook("onRequest", async (req) => {
    const operatorId = req.headers["x-test-operator"];
    if (typeof operatorId === "string") (req as any).operatorId = operatorId;
  });
  await app.register(wizardRoutes);
  await app.register(onboardRoutes);
  await app.ready();
  return app;
}

/** Fill every machine-onboarding step as `caller` (step 0 carries `machine`) and complete it. */
async function completeWizard(app: FastifyInstance, caller: string, machine: Record<string, unknown>) {
  const headers = { "x-test-operator": caller };
  const created = await app.inject({ method: "POST", url: "/api/wizard/sessions", headers, payload: { track: "machine-onboarding" } });
  expect(created.statusCode).toBe(201);
  const sessionId: string = created.json().session.id;
  const steps: Array<Record<string, unknown>> = [{ name: "Wizard Printer", category: "fdm", manufacturer: "Co", model: "W1", ...machine }];
  for (let i = 1; i < 7; i++) steps.push({ [`field_${i}`]: `value_${i}` });
  for (const [i, data] of steps.entries()) {
    const put = await app.inject({ method: "PUT", url: `/api/wizard/sessions/${sessionId}/steps/${i}`, headers, payload: { data } });
    expect(put.statusCode).toBe(200);
  }
  const res = await app.inject({ method: "POST", url: `/api/wizard/sessions/${sessionId}/complete`, headers });
  const session = await app.inject({ method: "GET", url: `/api/wizard/sessions/${sessionId}`, headers });
  return { res, sessionStatus: session.json().session.status as string };
}

const approvalAudits = () => getRepos().auditLog.query({ eventType: "operator.approved", limit: 1000 });

describe("wizard machine-onboarding completion gets /register's guards", () => {
  let app: FastifyInstance;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.NODE_ENV = "production";
    process.env.PCC_ADMIN_KEY = ADMIN_KEY;
    _clearSessionsForTesting();
    app = await buildApp();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    closeStore();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("M1: a forged review record through the wizard is refused, so no approval audit ever carries its digest", async () => {
    const { res, sessionStatus } = await completeWizard(app, OWNER, { description: FORGED_RECORD, operator: { walletAddress: OWNER } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("reserved_description");
    expect(sessionStatus).toBe("in_progress");

    // Whatever the wizard did create, an admin approving it must not record
    // the attacker's digest. (Before the fix the wizard created a 'submitted'
    // registration carrying the forged record, and the approval audit took
    // its digest.)
    for (const reg of getRepos().registrations.findAll()) {
      await app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${reg.id}/approve`,
        headers: { "x-admin-key": ADMIN_KEY },
        payload: { expectedEvidenceDigest: "none" },
      });
    }
    expect(getRepos().registrations.findAll()).toHaveLength(0);
    expect(JSON.stringify(approvalAudits())).not.toContain(FORGED_DIGEST);
  });

  it("M1/L1: an invisible-prefix variant of the record through the wizard is refused too", async () => {
    const { res, sessionStatus } = await completeWizard(app, OWNER, { description: `​${FORGED_RECORD}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("reserved_description");
    expect(sessionStatus).toBe("in_progress");
    expect(getRepos().registrations.findAll()).toHaveLength(0);
  });

  it("M3: naming someone else as the operator in the wizard is 403 and creates nothing", async () => {
    const { res, sessionStatus } = await completeWizard(app, ATTACKER, { operator: { email: VICTIM, displayName: "Victim" } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "operator_must_be_caller", field: "operator.email" });
    expect(sessionStatus).toBe("in_progress");
    expect(getRepos().registrations.findAll()).toHaveLength(0);
  });

  it("M3: the wizard's registration is owned by the caller, who can prove it; another operator cannot", async () => {
    const { res } = await completeWizard(app, OWNER, {});
    expect(res.statusCode).toBe(200);
    const regId: string = res.json().result.executedSteps.find((s: { name: string }) => s.name === "build-registration").data.registrationId;
    expect(getRepos().registrations.findById(regId)!.operator).toMatchObject({ walletAddress: OWNER });

    const prove = (operator: string) =>
      app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: { "x-test-operator": operator },
        payload: { evidence: { deviceHealth: { status: "idle", model: "W1" } } },
      });
    expect((await prove(ATTACKER)).statusCode).toBe(403);
    expect((await prove(OWNER)).statusCode).toBe(200);
  });
});
