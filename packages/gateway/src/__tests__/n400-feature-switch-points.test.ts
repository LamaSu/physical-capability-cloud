import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "@pcc/store";
import { initStore, closeStore, getStore } from "../db.js";
import { isFeatureEnabled } from "../services/feature-switches.js";
import { provisionRoutes } from "../routes/provision.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { contributorRoutes } from "../routes/contributors.js";
import { identitySessionRoutes } from "../routes/identity-session.js";
import { onboardRoutes } from "../routes/onboard.js";
import { litProvisionRoutes } from "../routes/lit-provision.js";
import { fiatRampRoutes } from "../routes/fiat-ramp.js";
import { kernelRoutes } from "../routes/kernels.js";
import { a2aTasksRoutes } from "../routes/a2a-tasks.js";
import { jobSubmitRoutes } from "../routes/job-submit.js";
import { kernelMarketplaceRoutes } from "../routes/kernel-marketplace.js";
import { onboardChatRoutes } from "../routes/onboard-chat.js";
import { identifyDeviceRoutes } from "../routes/identify-device.js";
import { commentaryRoutes } from "../routes/commentary.js";
import * as narrator from "../services/commentary-narrator.js";
import { streamHub } from "../sse/stream-hub.js";
import { requestRoutes, _setLLMClientForTests } from "../routes/requests.js";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { composeRoutes } from "../routes/compose.js";
import { setupRoutes } from "../routes/setup.js";
import { adminFeatureRoutes } from "../routes/admin-features.js";
import * as security from "../middleware/security-hardening.js";
import { CdpWalletClient, CdpOnrampClient } from "@pcc/payments";

vi.unmock("../services/feature-switches.js");
const models = vi.hoisted(() => ({ create: vi.fn(), stream: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {
  messages = { create: models.create, stream: models.stream };
} }));
vi.mock("../middleware/security-hardening.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../middleware/security-hardening.js")>();
  return { ...actual, canProvision: vi.fn(() => true), canSiweVerify: vi.fn(() => true), canOnboardChat: vi.fn(() => true), canOnboardChatGlobally: vi.fn(() => true) };
});

// Independent expectations: do not derive names, labels or refusals from production helpers.
const names = ["key_minting", "signups", "sign_in", "onboard_chat", "device_identify", "onboard_analysis", "commentary", "request_planner", "job_submission"] as const;
const labels = { key_minting: "Creating API keys", signups: "Sign-up", sign_in: "Sign-in", onboard_chat: "The onboarding chat", device_identify: "Device identification", onboard_analysis: "Onboarding analysis", commentary: "Live commentary", job_submission: "Job submission" };
type PausingFeature = keyof typeof labels;
type Point = { feature: PausingFeature; url: string; method: "GET" | "POST"; skill?: string; realCompose?: boolean };
const point = (feature: PausingFeature, url: string): Point => ({ feature, url, method: "POST" });
const points: Point[] = [
  ...["/api/auth/provision", "/api/auth/session-key", "/api/contributors/quickstart", "/api/identity/session", "/api/onboard/redeem", "/api/lit/provision", "/api/fiat-ramp/cdp/provision"].map((url) => point("key_minting", url)),
  ...["/api/auth/provision", "/api/contributors/quickstart", "/api/onboard/redeem", "/api/onboard/register", "/api/kernels/registration-challenges", "/api/kernels", "/api/devices/register", "/api/kernels/register"].map((url) => point("signups", url)),
  { ...point("signups", "/a2a/tasks/send"), skill: "pcc-author-integration" },
  point("sign_in", "/api/auth/verify"),
  point("onboard_chat", "/api/onboard/chat"),
  point("device_identify", "/api/onboard/identify-device"),
  point("onboard_analysis", "/api/onboard/analyze"),
  point("commentary", "/api/commentary/stream"),
  { ...point("commentary", "/api/commentary/stream"), method: "GET" },
  ...["/api/jobs/submit", "/api/jobs/submit-from-discovery", "/api/negotiate/session/missing/commit", "/api/compose/missing/execute", "/api/setup/test-job"].map((url) => point("job_submission", url)),
  { ...point("job_submission", "/api/compose/missing/execute"), realCompose: true },
  { ...point("job_submission", "/a2a/tasks/send"), skill: "pcc-submit" },
];
const refusal = (feature: PausingFeature) => ({ error: "feature_paused", feature, message: `${labels[feature]} is paused.` });
const secret = "synthetic-n400-points-admin";
let app: FastifyInstance;
let network: ReturnType<typeof vi.fn>;
let wallet: ReturnType<typeof vi.spyOn>;
let onramp: ReturnType<typeof vi.spyOn>;
let sessionStart: ReturnType<typeof vi.spyOn>;
let sequence = 0;
const setRaw = (name: string, enabled: number | string) => getStore().db.run(sql`UPDATE feature_switches SET enabled = ${enabled} WHERE name = ${name}`);
const adminSet = (name: string, enabled: boolean) => app.inject({ method: "PUT", url: `/api/admin/features/${name}`, headers: { "x-admin-key": secret }, payload: { enabled } });

function snapshot() {
  const db = getStore().db;
  return db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('feature_switches', 'sqlite_sequence') ORDER BY name`)
    .map(({ name }) => [name, db.all(sql.raw(`SELECT * FROM "${name.replaceAll('"', '""')}"`))]);
}
function invoke(p: Point) {
  vi.stubEnv("PCC_COMPOSE_EXECUTE_REAL", p.realCompose ? "true" : "false");
  return app.inject({ method: p.method, url: p.url, ...(p.method === "POST" ? { payload: p.skill ? { jsonrpc: "2.0", id: ++sequence, method: "tasks/send", params: { skill: p.skill, params: { userAgentId: "unproved-buyer" } } } : {} } : {}) });
}
function expectPaused(response: Awaited<ReturnType<typeof app.inject>>, p: Point) {
  if (p.skill) {
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jsonrpc: "2.0", id: expect.any(Number), error: { code: -32001, message: `${labels[p.feature]} is paused.`, data: { skill: p.skill, error: "feature_paused", feature: p.feature } } });
  } else {
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(refusal(p.feature));
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["content-type"]).not.toContain("text/event-stream");
  }
}
async function invokeEnabled(p: Point) {
  if (p.feature !== "commentary") return invoke(p);
  // Start through the real HTTP handler, then shut it down through a real set.
  const before = sessionStart.mock.calls.length;
  const response = invoke(p).then((r) => r);
  await vi.waitFor(() => expect(sessionStart.mock.calls.length).toBe(before + 1));
  expect((await adminSet("commentary", false)).statusCode).toBe(200);
  return response;
}

beforeAll(async () => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("PCC_ADMIN_KEY", secret);
  vi.stubEnv("PCC_A2A_AUTH_DISABLED", "true");
  vi.stubEnv("PCC_UNMET_CAPTURE_ENABLED", "false");
  vi.stubEnv("PCC_LEGACY_FIAT_WEBHOOKS", "false");
  initStore({ seed: false });
  app = Fastify();
  for (const plugin of [provisionRoutes, siweAuthPlugin, contributorRoutes, identitySessionRoutes, onboardRoutes, litProvisionRoutes, fiatRampRoutes, kernelRoutes, a2aTasksRoutes, jobSubmitRoutes, kernelMarketplaceRoutes, onboardChatRoutes, identifyDeviceRoutes, commentaryRoutes, requestRoutes, paidJobFlowRoutes, negotiationRoutes, composeRoutes, setupRoutes, adminFeatureRoutes]) await app.register(plugin);
  await app.ready();
}, 120_000);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.stubEnv("PCC_AGENTIC_DECOMPOSE_DISABLED", "0");
  vi.stubEnv("PCC_AGENTIC_DECOMPOSE_ENABLED", "1");
  getStore().db.run(sql`CREATE TABLE IF NOT EXISTS feature_switches (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`);
  for (const name of names) getStore().db.run(sql`INSERT OR REPLACE INTO feature_switches VALUES (${name}, 1, ${"2026-11-24T00:00:00.000Z"}, NULL)`);
  network = vi.fn(() => { throw new Error("Unexpected outside call"); });
  vi.stubGlobal("fetch", network);
  wallet = vi.spyOn(CdpWalletClient.prototype, "createWallet").mockResolvedValue({ address: "0x1111111111111111111111111111111111111111", network: "base-sepolia", smartAccount: false } as never);
  onramp = vi.spyOn(CdpOnrampClient.prototype, "createSession").mockResolvedValue({ id: "synthetic-session", url: "https://synthetic.invalid" } as never);
  sessionStart = vi.spyOn(narrator, "startCommentarySession");
  models.create.mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
  models.stream.mockImplementation(async function* () { yield { type: "content_block_delta", delta: { text: "Synthetic narration." } }; });
  _setLLMClientForTests(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
afterAll(async () => { await app?.close(); closeStore(); vi.unstubAllEnvs(); });

describe.each(points)("N400 $feature $method $url $skill real=$realCompose", (p) => {
  it.each(["dropped", "missing", "two", "text", "off"])("T1/T5: %s fails closed before validation, writes or outside work", async (state) => {
    // The production CHECK is intentionally absent in this fixture so corrupt
    // stored values exercise the real strict read, rather than SQLite's CHECK.
    if (state === "dropped") getStore().db.run(sql`DROP TABLE feature_switches`);
    else if (state === "missing") getStore().db.run(sql`DELETE FROM feature_switches WHERE name = ${p.feature}`);
    else setRaw(p.feature, state === "two" ? 2 : state === "text" ? "yes" : 0);
    const before = snapshot();
    const response = await invoke(p);
    const expected = state === "dropped" && p.feature === "key_minting" && ["/api/auth/provision", "/api/contributors/quickstart", "/api/onboard/redeem"].includes(p.url)
      ? { ...p, feature: "signups" as const } : p;
    expectPaused(response, expected);
    expect(snapshot()).toEqual(before);
    expect(network).not.toHaveBeenCalled();
    expect(wallet).not.toHaveBeenCalled();
    expect(onramp).not.toHaveBeenCalled();
    expect(models.create).not.toHaveBeenCalled();
    expect(models.stream).not.toHaveBeenCalled();
    expect(sessionStart).not.toHaveBeenCalled();
    expect(security.canProvision).not.toHaveBeenCalled();
    expect(security.canSiweVerify).not.toHaveBeenCalled();
    expect(security.canOnboardChat).not.toHaveBeenCalled();
  });

  it("T2/T3: on passes; admin sets affect the next request in both directions without restart", async () => {
    setRaw(p.feature, 0);
    expectPaused(await invoke(p), p);
    expect((await adminSet(p.feature, true)).statusCode).toBe(200);
    const enabled = await invokeEnabled(p);
    if (p.skill) expect(enabled.json().error?.data?.error).not.toBe("feature_paused");
    else {
      expect(enabled.statusCode).not.toBe(409);
      if (p.feature !== "commentary") expect(enabled.json().error).not.toBe("feature_paused");
      else {
        expect(enabled.statusCode).toBe(200);
        expect(enabled.body).toContain("event: connected");
      }
    }
    expect((await adminSet(p.feature, false)).statusCode).toBe(200);
    expectPaused(await invoke(p), p);
  });
});

it.each(["/api/auth/provision", "/api/contributors/quickstart", "/api/onboard/redeem"])("T4: signups wins precedence at %s", async (url) => {
  for (const [signups, minting, feature] of [[0, 0, "signups"], [1, 0, "key_minting"], [0, 1, "signups"]] as const) {
    setRaw("signups", signups);
    setRaw("key_minting", minting);
    expectPaused(await invoke(point(feature, url)), point(feature, url));
  }
});

it.each(names)("R3: %s requires the integer 1 and never caches", (name) => {
  expect(isFeatureEnabled(name)).toBe(true);
  for (const value of [0, 2, "yes"]) {
    setRaw(name, value);
    expect(isFeatureEnabled(name)).toBe(false);
    setRaw(name, 1);
    expect(isFeatureEnabled(name)).toBe(true);
  }
  getStore().db.run(sql`DELETE FROM feature_switches WHERE name = ${name}`);
  expect(isFeatureEnabled(name)).toBe(false);
  getStore().db.run(sql`DROP TABLE feature_switches`);
  expect(isFeatureEnabled(name)).toBe(false);
});

const plannerBody = { title: "HPLC purity analysis", description: "HPLC analysis and characterization of compound X, purity assay and quantification.", budget: 500, deadline: "2027-01-01T00:00:00.000Z" };
function withoutGeneratedFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutGeneratedFields);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !["createdAt", "updatedAt"].includes(key)).map(([key, entry]) => [key, withoutGeneratedFields(entry)]));
  return typeof value === "string" ? value.replace(/req-\d+-[a-z0-9]+/g, "req-generated") : value;
}

describe.each(["create", "decompose"])("N400 request_planner %s", (verb) => {
  it.each(["dropped", "missing", "two", "text", "off"])("T1/T6: %s uses exactly the env-flag template path without a model", async (state) => {
    const llm = { planSteps: vi.fn(async () => [{ title: "Model step", description: "Synthetic model", searchQuery: "fdm", kind: "make" as const }]) };
    _setLLMClientForTests(llm);
    vi.stubEnv("PCC_AGENTIC_DECOMPOSE_DISABLED", "1");
    const baseline = await app.inject({ method: "POST", url: "/api/requests", payload: plannerBody });
    expect(baseline.statusCode).toBe(201);
    const requestId = baseline.json().request.id;
    const expected = verb === "create" ? baseline : await app.inject({ method: "POST", url: `/api/requests/${requestId}/decompose` });
    vi.stubEnv("PCC_AGENTIC_DECOMPOSE_DISABLED", "0");
    if (state === "dropped") getStore().db.run(sql`DROP TABLE feature_switches`);
    else if (state === "missing") getStore().db.run(sql`DELETE FROM feature_switches WHERE name = 'request_planner'`);
    else setRaw("request_planner", state === "two" ? 2 : state === "text" ? "yes" : 0);
    const actual = await app.inject({ method: "POST", url: verb === "create" ? "/api/requests" : `/api/requests/${requestId}/decompose`, ...(verb === "create" ? { payload: plannerBody } : {}) });
    expect(actual.statusCode).toBe(verb === "create" ? 201 : 200);
    expect(withoutGeneratedFields(actual.json())).toEqual(withoutGeneratedFields(expected.json()));
    expect(llm.planSteps).not.toHaveBeenCalled();
    expect(models.create).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it("T2/T3: real sets enable and disable the model on the next request", async () => {
    const llm = { planSteps: vi.fn(async () => [{ title: "Model step", description: "Synthetic model", searchQuery: "fdm", kind: "make" as const }]) };
    _setLLMClientForTests(llm);
    setRaw("request_planner", 0);
    const first = await app.inject({ method: "POST", url: "/api/requests", payload: plannerBody });
    expect(llm.planSteps).not.toHaveBeenCalled();
    const url = verb === "create" ? "/api/requests" : `/api/requests/${first.json().request.id}/decompose`;
    const run = () => app.inject({ method: "POST", url, ...(verb === "create" ? { payload: plannerBody } : {}) });
    expect((await adminSet("request_planner", true)).statusCode).toBe(200);
    expect((await run()).statusCode).toBe(verb === "create" ? 201 : 200);
    expect(llm.planSteps).toHaveBeenCalledTimes(1);
    expect((await adminSet("request_planner", false)).statusCode).toBe(200);
    await run();
    expect(llm.planSteps).toHaveBeenCalledTimes(1);
  });
});

it.each(["off", "missing", "dropped", "two", "text"])("T5: open commentary closes at the next tick (%s), with the last SSE error and no model call", async (state) => {
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-n400-anthropic");
  narrator._resetAnthropicCache();
  const chunks: narrator.CommentaryChunk[] = [];
  vi.useFakeTimers();
  const session = narrator.startCommentarySession({ windowMs: 250 }, (chunk) => { chunks.push(chunk); });
  try {
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2));
    const timerCount = vi.getTimerCount();
    expect(timerCount).toBeGreaterThanOrEqual(2);
    streamHub.publish([{ type: "global", id: "*" }], { id: "n400-event-1", type: "job.started", timestamp: new Date().toISOString(), topic: { type: "global", id: "*" }, payload: { jobId: "synthetic-job" } });
    await vi.advanceTimersByTimeAsync(250);
    expect(models.stream).toHaveBeenCalledTimes(1);
    models.stream.mockClear();
    streamHub.publish([{ type: "global", id: "*" }], { id: "n400-event-2", type: "job.started", timestamp: new Date().toISOString(), topic: { type: "global", id: "*" }, payload: { jobId: "synthetic-next-job" } });
    if (state === "dropped") getStore().db.run(sql`DROP TABLE feature_switches`);
    else if (state === "missing") getStore().db.run(sql`DELETE FROM feature_switches WHERE name = 'commentary'`);
    else setRaw("commentary", state === "two" ? 2 : state === "text" ? "yes" : 0);
    await vi.advanceTimersByTimeAsync(250);
    await session.done;
    expect(chunks.at(-1)).toEqual({ type: "error", ts: expect.any(String), message: "Live commentary is paused.", error: "feature_paused", feature: "commentary" });
    expect(new Date(chunks.at(-1)!.ts).toISOString()).toBe(chunks.at(-1)!.ts);
    expect(chunks.filter((c) => c.error === "feature_paused")).toHaveLength(1);
    expect(models.stream).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timerCount - 2);
    const count = chunks.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(chunks).toHaveLength(count);
  } finally { session.stop(); }
});

it.each(["GET", "POST"] as const)("T5: %s stream writes exactly the final error event and ends at its next idle tick", async (method) => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  const responsePromise = invoke({ ...point("commentary", "/api/commentary/stream?windowMs=250"), method }).then((r) => r);
  await vi.waitFor(() => expect(sessionStart).toHaveBeenCalledTimes(1));
  expect((await adminSet("commentary", false)).statusCode).toBe(200);
  const response = await responsePromise;
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("text/event-stream");
  const blocks = response.body.trim().split("\n\n");
  expect(blocks.filter((b) => b.startsWith("event: error\n"))).toHaveLength(1);
  const last = blocks.at(-1)!;
  expect(last.startsWith("event: error\ndata: ")).toBe(true);
  const data = JSON.parse(last.split("\ndata: ")[1]);
  expect(data).toEqual({ type: "error", ts: expect.any(String), message: "Live commentary is paused.", error: "feature_paused", feature: "commentary" });
  expect(new Date(data.ts).toISOString()).toBe(data.ts);
  expect(models.stream).not.toHaveBeenCalled();
});

it("T12: GET discovery and onboarding reads remain available with every switch off", async () => {
  const urls = ["/api/kernels", "/api/onboard/chat/health", "/api/onboard/chat/missing", "/api/commentary/status", "/api/onboard/status"];
  const before = await Promise.all(urls.map((url) => app.inject({ url })));
  getStore().db.run(sql`UPDATE feature_switches SET enabled = 0`);
  for (const [index, url] of urls.entries()) {
    const after = await app.inject({ url });
    expect(after.statusCode).toBe(before[index].statusCode);
    expect(after.json()).toEqual(before[index].json());
  }
});

it.each(names)("R3: %s rejects real and text lookalikes of the integer 1", (name) => {
  getStore().db.run(sql`DROP TABLE feature_switches`);
  getStore().db.run(sql`CREATE TABLE feature_switches (name TEXT PRIMARY KEY, enabled, updated_at TEXT NOT NULL, updated_by TEXT)`);
  getStore().db.run(sql`INSERT INTO feature_switches VALUES (${name}, ${"1"}, ${new Date().toISOString()}, NULL)`);
  expect(isFeatureEnabled(name)).toBe(false);
  getStore().db.run(sql`UPDATE feature_switches SET enabled = CAST(1 AS REAL)`);
  expect(isFeatureEnabled(name)).toBe(false);
  getStore().db.run(sql`UPDATE feature_switches SET enabled = 1`);
  expect(isFeatureEnabled(name)).toBe(true);
});
