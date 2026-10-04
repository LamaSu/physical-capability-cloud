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
 * decision on top: opening an execution scope, a WRITE tool call and a chat instruction need the
 * admin or the PROVEN operator wallet (WP-A's field, simulated here by a test header). Revoking
 * a scope takes the stop tier (#6677): its creator, the kernel's own principal or the admin.
 * Anonymous is 401, anyone else 403, and an unregistered kernel 404 for a non-admin.
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

describe("N31 device relay on master: #400's relayAccessGuard refuses a stranger (cross-check)", () => {
  // The relay's guard is master's #400 relayAccessGuard (routes/device-relay.ts), tested in full by
  // device-relay.test.ts. This cross-check pins the N31 hole (bus #6505) closed on this branch: a
  // stranger's key gets nothing from another operator's kernel, and the kernel's own key keeps the
  // executor side. dc6d3833 (N126) runs that guard on auth/kernel-authority.ts, which puts the
  // steward's #6508 decision tier (the admin or the proven operator wallet) on the relay: opening
  // a scope, a chat instruction and a write tool call. A revoke takes the stop tier (#6677), and
  // every other route is "operate".
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

  it("a stranger cannot queue a tool call, read or claim the pending queue, or forge a result", async () => {
    const call = await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/tool-call`, headers: asStranger(), payload: { toolName: "printer_status", args: {} } });
    expect(call.statusCode).toBe(403);
    queueCall("call-n31-pending");
    getStore().db.update(schema.toolCallRelay).set({ status: "pending", claimedAt: null }).where(eq(schema.toolCallRelay.id, "call-n31-pending")).run();
    expect((await app.inject({ method: "GET", url: `/api/relay/${KERNEL}/tool-call/pending`, headers: asStranger() })).statusCode).toBe(403);
    expect(callRow("call-n31-pending")?.status).toBe("pending");
    queueCall("call-n31-forge");
    const forged = await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/tool-result`, headers: asStranger(), payload: { callId: "call-n31-forge", result: { forged: true } } });
    expect(forged.statusCode).toBe(403);
    expect(callRow("call-n31-forge")?.result ?? null).toBeNull();
  });

  it("a stranger cannot read the kernel's camera, chat or manifest, or post to its chat or camera", async () => {
    for (const [method, url, payload] of [
      ["GET", `/api/relay/${KERNEL}/camera/latest`, undefined],
      ["GET", `/api/relay/${KERNEL}/chat/messages`, undefined],
      ["POST", `/api/relay/${KERNEL}/chat`, { message: "n31" }],
      ["POST", `/api/relay/${KERNEL}/camera/frame`, { frame: "x" }],
      ["GET", `/api/relay/${KERNEL}/manifest`, undefined],
    ] as const) {
      const res = await app.inject({ method, url, headers: asStranger(), ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("the kernel's own key keeps the executor side: the pending queue and its call's result", async () => {
    expect((await app.inject({ method: "GET", url: `/api/relay/${KERNEL}/tool-call/pending`, headers: asOperator() })).statusCode).toBe(200);
    queueCall("call-n31-own");
    const res = await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/tool-result`, headers: asOperator(), payload: { callId: "call-n31-own", result: { ok: true } } });
    expect(res.statusCode).toBeLessThan(300);
  });
});

describe("DECISIONS 00:42 (#6690): a PROVEN scope holder may make its scoped write; the same address claimed may not", () => {
  // #400's table says WHO may write through the tool-call route: the kernel's operator, or an
  // active scope holder. N31b's decision tier asks that WHO to be AUTHENTIC: proven or admin.
  const BUYER = "0xB0B0000000000000000000000000000000000531";
  const WRITE = "printer_print_text"; // not a safe tool for this kernel's (generic) device
  let buyerRawKey = "";
  const buyerKey = () => (buyerRawKey ||= provisionApiKey({ operatorId: BUYER, name: "n31-relay-buyer", scopes: ["*"] }).rawKey);
  const asClaimedBuyer = () => bearer(buyerKey());
  const asProvenBuyer = () => ({ ...bearer(buyerKey()), "x-test-proven-wallet": BUYER });
  const rowsUnder = (scopeId: string) =>
    getStore().db.select().from(schema.toolCallRelay).where(eq(schema.toolCallRelay.scopeId, scopeId)).all().length;
  const mint = async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/relay/${KERNEL}/scope`,
      headers: asProvenOperator(),
      payload: { createdBy: BUYER, allowedTools: [WRITE], maxCommands: 5, expiresInMinutes: 5 },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };
  const write = (headers: Record<string, string>, scopeId?: string) =>
    app.inject({ method: "POST", url: `/api/relay/${KERNEL}/tool-call`, headers, payload: { ...(scopeId ? { scopeId } : {}), toolName: WRITE, args: {} } });

  it("the buyer's claimed key is refused its scoped write, and nothing is queued", async () => {
    const scopeId = await mint();
    const res = await write(asClaimedBuyer(), scopeId);
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe("operator_proof_required");
    expect(rowsUnder(scopeId)).toBe(0);
  });

  it("the buyer's PROVEN wallet makes its scoped write", async () => {
    const scopeId = await mint();
    const res = await write(asProvenBuyer(), scopeId);
    expect(res.statusCode).toBe(201);
    expect(rowsUnder(scopeId)).toBe(1);
  });

  it("a proven wallet is admitted only for a scope created for it, active, on this kernel", async () => {
    const scopeId = await mint();
    // A proven stranger naming the buyer's scope: the scope is not the stranger's.
    const stranger = await write({ ...asStranger(), "x-test-proven-wallet": STRANGER }, scopeId);
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json().reason).toBe("operator_proof_required");
    // The buyer's proof on someone else's key: the handler still requires the caller to be the holder.
    const mixed = await write({ ...asStranger(), "x-test-proven-wallet": BUYER }, scopeId);
    expect(mixed.statusCode).toBe(403);
    expect(mixed.json().error).toBe("scope_not_yours");
    // A key merely CLAIMING the kernel's public operatorAddress, sent with the buyer's proof: the
    // handler's operator test takes proof too, so the caller must still be the scope's holder.
    const claimedOperator = await write({ ...asOperator(), "x-test-proven-wallet": BUYER }, scopeId);
    expect(claimedOperator.statusCode).toBe(403);
    expect(claimedOperator.json().error).toBe("scope_not_yours");
    // A proven buyer naming no scope.
    const scopeless = await write(asProvenBuyer());
    expect(scopeless.statusCode).toBe(403);
    // Once the scope is revoked, the proof admits nothing.
    const revoke = await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/scope/${scopeId}/revoke`, headers: asOperator() });
    expect(revoke.statusCode).toBe(200);
    const afterRevoke = await write(asProvenBuyer(), scopeId);
    expect(afterRevoke.statusCode).toBe(403);
    expect(afterRevoke.json().reason).toBe("operator_proof_required");
    expect(rowsUnder(scopeId)).toBe(0);
  });

  it("a proven scope holder still cannot open a scope or send a chat instruction", async () => {
    await mint();
    const scope = await app.inject({
      method: "POST", url: `/api/relay/${KERNEL}/scope`, headers: asProvenBuyer(), payload: { createdBy: BUYER, allowedTools: [WRITE] },
    });
    expect(scope.statusCode).toBe(403);
    const chat = await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/chat`, headers: asProvenBuyer(), payload: { message: "start" } });
    expect(chat.statusCode).toBe(403);
  });
});

describe("DECISIONS 00:53 (#6711): the relay's human- and agent-facing side needs proof; the device's own side does not", () => {
  // The kernel listing publishes a kernel's operatorAddress, so a key that merely CLAIMS it (here,
  // an API key provisioned for that address, which apiGate resolves to it) proves nothing.
  const HOLDER = "0xC0FFEE0000000000000000000000000000000531";
  let holderRawKey = "";
  const holderKey = () => (holderRawKey ||= provisionApiKey({ operatorId: HOLDER, name: "n31-relay-holder", scopes: ["*"] }).rawKey);
  const asClaimedHolder = () => bearer(holderKey());
  const asProvenHolder = () => ({ ...bearer(holderKey()), "x-test-proven-wallet": HOLDER });
  const frame = { frame: Buffer.from("n31-frame").toString("base64") };
  const human = (scopeId?: string) =>
    [
      ["GET", `/api/relay/${KERNEL}/camera/latest`, undefined],
      ["GET", `/api/relay/${KERNEL}/chat/messages`, undefined],
      ["GET", `/api/relay/${KERNEL}/manifest`, undefined],
      ["POST", `/api/relay/${KERNEL}/tool-call`, { ...(scopeId ? { scopeId } : {}), toolName: "health", args: {} }],
    ] as const;
  const mintFor = async (holder: string) => {
    const res = await app.inject({
      method: "POST", url: `/api/relay/${KERNEL}/scope`, headers: asProvenOperator(),
      // KERNEL has no resolved device type, so even a read tool must be in the scope (#579 r1).
      payload: { createdBy: holder, allowedTools: ["printer_print_text", "health"], maxCommands: 5, expiresInMinutes: 5 },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };

  it("the device's own side keeps its claimed key: a frame upload, both polls and a result", async () => {
    expect((await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/camera/frame`, headers: asOperator(), payload: frame })).statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: `/api/relay/${KERNEL}/tool-call/pending`, headers: asOperator() })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/relay/${KERNEL}/chat/pending`, headers: asOperator() })).statusCode).toBe(200);
    queueCall("call-n31-device-side");
    const result = await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/tool-result`, headers: asOperator(), payload: { callId: "call-n31-device-side", result: { ok: true } } });
    expect(result.statusCode).toBeLessThan(300);
  });

  it("a key claiming the operator's address is refused the camera, the chat, the manifest and a read-only tool call", async () => {
    const before = getStore().db.select().from(schema.toolCallRelay).all().length;
    for (const [method, url, payload] of human()) {
      const res = await app.inject({ method, url, headers: asOperator(), ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().reason, `${method} ${url}`).toBe("operator_proof_required");
    }
    expect(getStore().db.select().from(schema.toolCallRelay).all().length).toBe(before);
  });

  it("the proven operator and the admin are admitted to each", async () => {
    for (const headers of [asProvenOperator(), asAdmin()]) {
      for (const [method, url, payload] of human()) {
        const res = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
        expect(res.statusCode, `${method} ${url}`).toBeLessThan(300);
      }
    }
  });

  it("a proven scope holder is admitted under its scope; the same address merely claimed is not", async () => {
    const scopeId = await mintFor(HOLDER);
    for (const [method, url, payload] of human(scopeId)) {
      const claimed = await app.inject({ method, url, headers: asClaimedHolder(), ...(payload ? { payload } : {}) });
      expect(claimed.statusCode, `claimed ${method} ${url}`).toBe(403);
      expect(claimed.json().reason, `claimed ${method} ${url}`).toBe("operator_proof_required");
      const proven = await app.inject({ method, url, headers: asProvenHolder(), ...(payload ? { payload } : {}) });
      expect(proven.statusCode, `proven ${method} ${url}`).toBeLessThan(300);
    }
    // Its scope and the scope's audit: read by the proven creator, not by the claimed one.
    for (const url of [`/api/relay/${KERNEL}/scope/${scopeId}`, `/api/relay/${KERNEL}/scope/${scopeId}/audit`]) {
      expect((await app.inject({ method: "GET", url, headers: asClaimedHolder() })).statusCode, url).toBe(403);
      expect((await app.inject({ method: "GET", url, headers: asProvenHolder() })).statusCode, url).toBe(200);
    }
  });

  it("a tool call's result is read with proof: the claimed operator is refused, the proven operator reads it", async () => {
    queueCall("call-n31-result-read");
    const url = `/api/relay/${KERNEL}/tool-result/call-n31-result-read`;
    expect((await app.inject({ method: "GET", url, headers: asOperator() })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url, headers: asProvenOperator() })).statusCode).toBe(200);
  });

  it("a stranger with no claim on the kernel still gets #400's refusal", async () => {
    const res = await app.inject({ method: "GET", url: `/api/relay/${KERNEL}/camera/latest`, headers: asStranger() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("relay_access_denied");
  });
});

describe("#579 r1 HIGH (astra): a tool the manifest calls 'safe' never widens a scope", () => {
  // The manifests list physical controls (category safe_control: home, reset, lights, identify,
  // connect, disconnect) among their safeTools, and a kernel whose device type cannot be resolved
  // falls back to the generic manifest, which lists reset. A scoped call may skip the scope's tool
  // list, budget and escrow only for a READ tool of an authoritatively resolved device type.
  const HOLDER2 = "0xD00D000000000000000000000000000000000531";
  const OT_KERNEL = "kernel-n31-relay-opentrons";
  let holderRawKey = "";
  const proven = () => ({ ...bearer((holderRawKey ||= provisionApiKey({ operatorId: HOLDER2, name: "n31-relay-holder2", scopes: ["*"] }).rawKey)), "x-test-proven-wallet": HOLDER2 });
  const mint = async (kernelId: string, allowedTools: string[]) => {
    const res = await app.inject({
      method: "POST", url: `/api/relay/${kernelId}/scope`, headers: asProvenOperator(),
      payload: { createdBy: HOLDER2, allowedTools, maxCommands: 5, expiresInMinutes: 5 },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };
  const call = (kernelId: string, scopeId: string, toolName: string) =>
    app.inject({ method: "POST", url: `/api/relay/${kernelId}/tool-call`, headers: proven(), payload: { scopeId, toolName, args: {} } });
  const scopeRow = (id: string) => getStore().db.select().from(schema.executionScopes).where(eq(schema.executionScopes.id, id)).get()!;
  const rowsUnder = (id: string) => getStore().db.select().from(schema.toolCallRelay).where(eq(schema.toolCallRelay.scopeId, id)).all();

  beforeAll(async () => {
    const reg = await app.inject({ method: "POST", url: "/api/kernels", headers: asOperator(), payload: { id: OT_KERNEL, name: "N31 relay opentrons kernel", location: { lat: 1, lng: 1 }, physicalAddress: "x" } });
    expect(reg.statusCode).toBe(201);
    getStore().db.insert(schema.kernelDevices).values({
      id: "dev-n31-relay-ot2", kernelId: OT_KERNEL, type: "machine", model: "OT-2", firmware: "1.0", status: "idle",
      contributesToCapabilities: [], lastUpdated: new Date().toISOString(), adapterType: "opentrons",
    }).run();
  });

  it("an unresolved device type grants no 'safe' tool: reset outside the scope is refused, nothing queued or spent", async () => {
    const scopeId = await mint(KERNEL, ["printer_print_text"]);
    const res = await call(KERNEL, scopeId, "reset");
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe("tool_not_allowed");
    expect(scopeRow(scopeId).commandCount).toBe(0);
    expect(rowsUnder(scopeId).filter((r) => r.status !== "rejected")).toHaveLength(0);
  });

  it("an unresolved device type fails closed: even a read tool must be in the scope", async () => {
    const scopeId = await mint(KERNEL, ["printer_print_text"]);
    const res = await call(KERNEL, scopeId, "health");
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe("tool_not_allowed");
  });

  it("a physical safe_control (opentrons home) outside the scope is refused", async () => {
    const scopeId = await mint(OT_KERNEL, ["run_create"]);
    const res = await call(OT_KERNEL, scopeId, "home");
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe("tool_not_allowed");
    expect(scopeRow(scopeId).commandCount).toBe(0);
  });

  it("a safe_control the scope allows runs, and spends one command of its budget", async () => {
    const scopeId = await mint(OT_KERNEL, ["home"]);
    const res = await call(OT_KERNEL, scopeId, "home");
    expect(res.statusCode).toBe(201);
    expect(scopeRow(scopeId).commandCount).toBe(1);
  });

  it("control: a READ tool of a resolved device type stays outside the scope's tool list and budget", async () => {
    const scopeId = await mint(OT_KERNEL, ["run_create"]);
    const res = await call(OT_KERNEL, scopeId, "health");
    expect(res.statusCode).toBe(201);
    expect(scopeRow(scopeId).commandCount).toBe(0);
  });

  it("dispatch re-checks it: a queued home outside its scope is rejected when the executor polls", async () => {
    const scopeId = await mint(OT_KERNEL, ["run_create"]);
    // A row admitted before this rule (or by any path that skipped admission) must not dispatch.
    getStore().db.insert(schema.toolCallRelay).values({
      id: "call-n31-legacy-home", scopeId, kernelId: OT_KERNEL, toolName: "home", toolArgs: {}, status: "pending", createdAt: new Date().toISOString(),
    }).run();
    const poll = await app.inject({ method: "GET", url: `/api/relay/${OT_KERNEL}/tool-call/pending`, headers: { ...asOperator(), "x-pcc-lease": "1" } });
    expect(poll.statusCode).toBe(200);
    expect((poll.json().calls as Array<{ id: string }>).map((c) => c.id)).not.toContain("call-n31-legacy-home");
    const row = getStore().db.select().from(schema.toolCallRelay).where(eq(schema.toolCallRelay.id, "call-n31-legacy-home")).get();
    expect(row).toMatchObject({ status: "rejected", error: "tool_not_allowed" });
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
