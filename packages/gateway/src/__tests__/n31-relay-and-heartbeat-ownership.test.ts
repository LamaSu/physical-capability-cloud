/**
 * Board N31, #575 r2 (the steward's ruling #6493 (2): every kernel-scoped writer goes through the
 * ONE kernel-ownership guard; bus #6505). The route inventory found the device relay and the
 * kernel heartbeat with no kernel ownership check at all:
 *   - /api/relay/:kernelId/* (18 routes, mounted in production): any key created an execution
 *     scope on any kernel (with a body-supplied createdBy), queued write tool calls the kernel's
 *     executor runs (scripts/printer-executor.py), read and claimed its pending calls, forged its
 *     tool results, and read its camera and chat;
 *   - POST /api/kernels/:kernelId/heartbeat and /capabilities: any key set another kernel's
 *     status and upserted capabilities onto it.
 * Now (the steward's ruling #6508, fail-closed): the floor for every relay route, heartbeat and
 * capability announce is "operate": the kernel's own principal (the identity its operatorAddress
 * records), a proven operator wallet, or the admin. What authorizes or drives a device is a
 * decision on top: opening or revoking an execution scope, a WRITE tool call and a chat
 * instruction need the admin or the PROVEN operator wallet (WP-A's field, simulated here by a
 * test header). Anonymous is 401, anyone else 403, and an unregistered kernel 404 for a
 * non-admin.
 *
 * Mounted as production mounts it: apiGate, then the routes; the kernel is registered by the
 * operator's own key.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { schema, eq } from "@pcc/store";
import { apiGate } from "../middleware/api-gate.js";
import { kernelRoutes } from "../routes/kernels.js";
import { deviceRelayRoutes } from "../routes/device-relay.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { initStore, closeStore, getStore } from "../db.js";

const PREV_DB = process.env.PCC_DB_PATH;
const PREV_ADMIN = process.env.PCC_ADMIN_KEY;
const ADMIN = "n31-relay-admin-secret";
const OPERATOR = "0xA11cE00000000000000000000000000000000531";
const STRANGER = "0xBAD0000000000000000000000000000000000531";
const KERNEL = "kernel-n31-relay";

let app: FastifyInstance;
const keys = { operator: "", stranger: "" };
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const asOperator = () => bearer(keys.operator);
const asStranger = () => bearer(keys.stranger);
const asAdmin = () => ({ ...bearer(keys.stranger), "x-admin-key": ADMIN });
/** WP-A's proven wallet, simulated: any key plus the wallet the caller proved. */
const asProvenOperator = () => ({ ...bearer(keys.stranger), "x-test-proven-wallet": OPERATOR });
const ANON = { "x-forwarded-for": "10.31.5.1" };

function queueCall(id: string) {
  getStore().db.insert(schema.toolCallRelay).values({
    id,
    scopeId: null,
    kernelId: KERNEL,
    toolName: "printer_status",
    toolArgs: {},
    status: "claimed",
    createdAt: new Date().toISOString(),
    claimedAt: new Date().toISOString(),
  }).run();
}
const callRow = (id: string) => getStore().db.select().from(schema.toolCallRelay).where(eq(schema.toolCallRelay.id, id)).get();
const kernelRow = () => getStore().db.select().from(schema.shopKernels).where(eq(schema.shopKernels.id, KERNEL)).get();

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN;
  closeStore();
  initStore({ seed: true });
  app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const proven = req.headers["x-test-proven-wallet"];
    if (typeof proven === "string") (req as unknown as { provenWallet: string }).provenWallet = proven;
  });
  await app.register(apiGate);
  await app.register(kernelRoutes);
  await app.register(deviceRelayRoutes);
  await app.ready();
  keys.operator = provisionApiKey({ operatorId: OPERATOR, name: "n31-relay-operator", scopes: ["*"] }).rawKey;
  keys.stranger = provisionApiKey({ operatorId: STRANGER, name: "n31-relay-stranger", scopes: ["*"] }).rawKey;
  const reg = await app.inject({
    method: "POST",
    url: "/api/kernels",
    headers: asOperator(),
    payload: { id: KERNEL, name: "N31 relay kernel", location: { lat: 1, lng: 1 }, physicalAddress: "x" },
  });
  expect(reg.statusCode).toBe(201);
}, 60_000);

afterAll(async () => {
  await app.close();
  closeStore();
  if (PREV_DB === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = PREV_DB;
  if (PREV_ADMIN === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = PREV_ADMIN;
});

const SCOPE_BODY = { createdBy: "anyone", allowedTools: ["printer_print_text"], maxCommands: 5, expiresInMinutes: 5 };

describe("N31 device relay: only the kernel's operator or the admin", () => {
  it("anonymous is 401 on a write and a read", async () => {
    expect((await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/scope`, headers: ANON, payload: SCOPE_BODY })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/api/relay/${KERNEL}/tool-call/pending`, headers: ANON })).statusCode).toBe(401);
  });

  it("a stranger cannot create an execution scope on another operator's kernel", async () => {
    const before = getStore().db.select().from(schema.executionScopes).all().length;
    const res = await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/scope`, headers: asStranger(), payload: SCOPE_BODY });
    expect(res.statusCode).toBe(403);
    expect(getStore().db.select().from(schema.executionScopes).all().length).toBe(before);
  });

  it("a stranger cannot queue a tool call, even a safe one", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/relay/${KERNEL}/tool-call`,
      headers: asStranger(),
      payload: { toolName: "printer_status", args: {} },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "forbidden", reason: "not_kernel_operator" });
  });

  it("a stranger cannot read or claim the kernel's pending calls", async () => {
    queueCall("call-n31-pending");
    getStore().db.update(schema.toolCallRelay).set({ status: "pending", claimedAt: null }).where(eq(schema.toolCallRelay.id, "call-n31-pending")).run();
    const res = await app.inject({ method: "GET", url: `/api/relay/${KERNEL}/tool-call/pending`, headers: asStranger() });
    expect(res.statusCode).toBe(403);
    expect(callRow("call-n31-pending")?.status).toBe("pending");
  });

  it("a stranger cannot forge the result of the kernel's tool call", async () => {
    queueCall("call-n31-forge");
    const res = await app.inject({
      method: "POST",
      url: `/api/relay/${KERNEL}/tool-result`,
      headers: asStranger(),
      payload: { callId: "call-n31-forge", result: { forged: true } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "forbidden", reason: "not_kernel_operator" });
    expect(callRow("call-n31-forge")?.status).toBe("claimed");
    expect(callRow("call-n31-forge")?.result ?? null).toBeNull();
  });

  it("a stranger cannot read the kernel's camera or post to its chat", async () => {
    for (const [method, url, payload] of [
      ["GET", `/api/relay/${KERNEL}/camera/latest`, undefined],
      ["GET", `/api/relay/${KERNEL}/chat/messages`, undefined],
      ["POST", `/api/relay/${KERNEL}/chat`, { message: "n31" }],
      ["POST", `/api/relay/${KERNEL}/camera/frame`, { frame: "x" }],
      ["GET", `/api/relay/${KERNEL}/manifest`, undefined],
    ] as const) {
      const res = await app.inject({ method, url, headers: asStranger(), ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json(), `${method} ${url}`).toMatchObject({ reason: "not_kernel_operator" });
    }
  });

  it("an unregistered kernel is 404 for a non-admin", async () => {
    const res = await app.inject({ method: "POST", url: "/api/relay/kernel-n31-relay-missing/scope", headers: asOperator(), payload: SCOPE_BODY });
    expect(res.statusCode).toBe(404);
  });

  it("the executor side stays the kernel's own principal's: the pending queue", async () => {
    for (const headers of [asOperator(), asProvenOperator(), asAdmin()]) {
      const pending = await app.inject({ method: "GET", url: `/api/relay/${KERNEL}/tool-call/pending`, headers });
      expect(pending.statusCode).toBe(200);
    }
  });

  it("opening a scope is a decision: the operator's claimed key is 403; its proven wallet and the admin open one", async () => {
    const claimed = await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/scope`, headers: asOperator(), payload: SCOPE_BODY });
    expect(claimed.statusCode).toBe(403);
    expect(claimed.json()).toMatchObject({ error: "forbidden", reason: "operator_proof_required" });
    for (const headers of [asProvenOperator(), asAdmin()]) {
      const scope = await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/scope`, headers, payload: SCOPE_BODY });
      expect(scope.statusCode).toBeLessThan(300);
    }
  });

  it("queueing a WRITE tool is a decision: the operator's claimed key is 403 before any scope check", async () => {
    const claimed = await app.inject({
      method: "POST",
      url: `/api/relay/${KERNEL}/tool-call`,
      headers: asOperator(),
      payload: { scopeId: "scope-n31-any", toolName: "printer_print_text", args: { text: "n31" } },
    });
    expect(claimed.statusCode).toBe(403);
    expect(claimed.json()).toMatchObject({ error: "forbidden", reason: "operator_proof_required" });
    // The admin passes the guard; what follows is the relay's own scope check.
    const admin = await app.inject({
      method: "POST",
      url: `/api/relay/${KERNEL}/tool-call`,
      headers: asAdmin(),
      payload: { scopeId: "scope-n31-any", toolName: "printer_print_text", args: { text: "n31" } },
    });
    expect(admin.json()?.reason).not.toBe("operator_proof_required");
    expect(admin.json()?.reason).not.toBe("not_kernel_operator");
  });

  it("revoking a scope is a decision, and only this kernel's scope can be revoked here", async () => {
    const opened = await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/scope`, headers: asAdmin(), payload: SCOPE_BODY });
    const scopeId = opened.json().id as string;
    const claimed = await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/scope/${scopeId}/revoke`, headers: asOperator(), payload: {} });
    expect(claimed.statusCode).toBe(403);
    // A scope of another kernel is not found through this kernel's path, even for the admin.
    getStore().db.update(schema.executionScopes).set({ kernelId: "kernel-n31-relay-other" }).where(eq(schema.executionScopes.id, scopeId)).run();
    expect((await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/scope/${scopeId}/revoke`, headers: asAdmin(), payload: {} })).statusCode).toBe(404);
    getStore().db.update(schema.executionScopes).set({ kernelId: KERNEL }).where(eq(schema.executionScopes.id, scopeId)).run();
    expect((await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/scope/${scopeId}/revoke`, headers: asProvenOperator(), payload: {} })).statusCode).toBeLessThan(300);
  });

  it("a chat instruction is a decision; the device agent's reply is the executor side", async () => {
    const claimed = await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/chat`, headers: asOperator(), payload: { message: "n31" } });
    expect(claimed.statusCode).toBe(403);
    expect(claimed.json()).toMatchObject({ reason: "operator_proof_required" });
    const asked = await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/chat`, headers: asAdmin(), payload: { message: "n31" } });
    expect(asked.statusCode).toBe(201);
    const reply = await app.inject({
      method: "POST",
      url: `/api/relay/${KERNEL}/chat/respond`,
      headers: asOperator(),
      payload: { messageId: asked.json().id, response: "done" },
    });
    expect(reply.statusCode).toBe(201);
  });

  it("the device agent's reply cannot complete another kernel's message", async () => {
    getStore().db.insert(schema.ot2ChatMessages).values({
      id: "msg-n31-other-kernel",
      kernelId: "kernel-n31-relay-other",
      role: "user",
      content: "other",
      status: "pending",
      createdAt: new Date().toISOString(),
    }).run();
    const res = await app.inject({
      method: "POST",
      url: `/api/relay/${KERNEL}/chat/respond`,
      headers: asOperator(),
      payload: { messageId: "msg-n31-other-kernel", response: "x" },
    });
    expect(res.statusCode).toBe(201);
    const row = getStore().db.select().from(schema.ot2ChatMessages).where(eq(schema.ot2ChatMessages.id, "msg-n31-other-kernel")).get();
    expect(row?.status).toBe("pending");
  });

  it("the kernel's operator may post its own call's result", async () => {
    queueCall("call-n31-own");
    const res = await app.inject({
      method: "POST",
      url: `/api/relay/${KERNEL}/tool-result`,
      headers: asOperator(),
      payload: { callId: "call-n31-own", result: { ok: true } },
    });
    expect(res.statusCode).toBeLessThan(300);
  });
});

describe("N31 kernel heartbeat and capability announce: only the kernel's operator or the admin", () => {
  it("anonymous is 401", async () => {
    expect((await app.inject({ method: "POST", url: `/api/kernels/${KERNEL}/heartbeat`, headers: ANON, payload: {} })).statusCode).toBe(401);
  });

  it("a stranger cannot set another operator's kernel status or add capabilities to it", async () => {
    const statusBefore = kernelRow()?.status;
    const capsBefore = getStore().db.select().from(schema.capabilities).where(eq(schema.capabilities.kernelId, KERNEL)).all().length;
    const hb = await app.inject({
      method: "POST",
      url: `/api/kernels/${KERNEL}/heartbeat`,
      headers: asStranger(),
      payload: { status: "maintenance", capabilities: [{ type: "n31-forged", name: "forged by a stranger" }] },
    });
    expect(hb.statusCode).toBe(403);
    const ann = await app.inject({
      method: "POST",
      url: `/api/kernels/${KERNEL}/capabilities`,
      headers: asStranger(),
      payload: { capabilities: [{ type: "n31-forged-2", name: "forged by a stranger" }] },
    });
    expect(ann.statusCode).toBe(403);
    expect(kernelRow()?.status).toBe(statusBefore);
    expect(getStore().db.select().from(schema.capabilities).where(eq(schema.capabilities.kernelId, KERNEL)).all().length).toBe(capsBefore);
  });

  it("the kernel's operator (its own key) and the admin heartbeat it", async () => {
    for (const headers of [asOperator(), asAdmin()]) {
      const res = await app.inject({ method: "POST", url: `/api/kernels/${KERNEL}/heartbeat`, headers, payload: { status: "online" } });
      expect(res.statusCode).toBe(200);
    }
  });

  it("an unregistered kernel is 404 for a non-admin", async () => {
    expect((await app.inject({ method: "POST", url: "/api/kernels/kernel-n31-hb-missing/heartbeat", headers: asOperator(), payload: {} })).statusCode).toBe(404);
  });
});
