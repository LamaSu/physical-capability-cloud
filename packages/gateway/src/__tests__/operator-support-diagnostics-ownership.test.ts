/**
 * WP-A: support threads and diagnostic uploads belong to the identity that created
 * them (astra, pack 47 verdict: "diagnostics ownership ... must remain open").
 *
 * The routes trusted a caller-asserted kernelId as ownership, or checked nothing:
 * - GET /api/operator/support listed every operator's threads to any key;
 * - GET /api/operator/support/:threadId returned any thread's messages, retrieval
 *   codes and operator IP;
 * - GET /api/operator/support/mine?kernelId=X returned any kernel's threads;
 * - PATCH /api/operator/support/:threadId (documented as admin) changed any thread;
 * - POST /api/operator/support appended to whichever open thread carried the kernelId,
 *   so a thread opened by someone else captured the real operator's later messages
 *   and retrieval codes (and every "unknown"-kernel operator shared one thread);
 * - diagnostic uploads never recorded their uploader: the list matched the caller's
 *   identity against the caller-asserted kernelId, and GET /:id and POST /decrypt had
 *   no owner check at all.
 * Now each thread and upload records its creator's identity. Only that identity, or
 * the admin secret, reads or writes it; anyone else gets the same 404 as for an
 * unknown id. PATCH needs the admin secret.
 *
 * Runs on the real server (createGateway: apiGate, scope-checker, every route).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.PCC_SEED_DATA = "false";
const SECRET = "support-diag-owner-test-key-0123456789";
process.env.PCC_ADMIN_KEY = SECRET;
delete process.env.BROKER_OPERATORS;

const A = "owner-a@x.test";
const B = "other-b@x.test";
const C = "late-c@x.test";

let app: FastifyInstance;
let getRepos: typeof import("../db.js").getRepos;
let generateApiKey: typeof import("../auth/api-key-auth.js").generateApiKey;
let seq = 0;
let ipSeq = 10;

function seedKey(operatorId: string): string {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: `support-diag-owner-key-${++seq}`,
    keyHash,
    keyPrefix,
    operatorId,
    scopes: JSON.stringify(["operator"]),
    rateLimit: "1000/hour",
    usageCount: "0",
    createdAt: new Date().toISOString(),
  } as never);
  return rawKey;
}

const inj = (method: string, url: string, raw: string | null, headers: Record<string, string> = {}, payload?: unknown) =>
  app.inject({
    method: method as never,
    url,
    remoteAddress: `10.91.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    payload: payload as never,
    headers: { ...(raw ? { authorization: `Bearer ${raw}` } : {}), ...headers },
  });
const admin = { "x-admin-key": SECRET };

/** A bundle the gateway's decrypt route can open with `code` (AES-256-GCM, PBKDF2-SHA256 100k). */
function sealedBundle(kernelId: string, code: string, secretText: string) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(code, salt, 100_000, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ logs: secretText }), "utf-8"), cipher.final()]);
  return {
    kernelId,
    encrypted: {
      ciphertext_b64: ciphertext.toString("base64"),
      iv_b64: iv.toString("base64"),
      salt_b64: salt.toString("base64"),
      tag_b64: cipher.getAuthTag().toString("base64"),
    },
    bundleHash: "sha256:00",
    bundleSize: ciphertext.length,
    logLineCount: 1,
    systemPlatform: "linux",
    collectedAt: new Date().toISOString(),
  };
}

let keyA: string;
let keyB: string;
let keyC: string;
let threadA: string;
let uploadA: string;
const KERNEL_A = "kernel-owner-a";
const CODE_A = "RC-OWNER-A-7Q2";

beforeAll(async () => {
  const server = await import("../server.js");
  ({ getRepos } = await import("../db.js"));
  ({ generateApiKey } = await import("../auth/api-key-auth.js"));
  const gw = await server.createGateway(0);
  app = gw.app as unknown as FastifyInstance;
  await app.ready();
  keyA = seedKey(A);
  keyB = seedKey(B);
  keyC = seedKey(C);

  const th = await inj("POST", "/api/operator/support", keyA, {}, {
    kernelId: KERNEL_A,
    message: "A's private problem report",
    retrievalCode: CODE_A,
  });
  expect(th.statusCode, th.body).toBe(200);
  threadA = (th.json() as { threadId: string }).threadId;

  // Uploaded under the KERNEL id, not the operator's identity, as pcc-node does.
  const up = await inj("POST", "/api/operator/diagnostics", keyA, {}, sealedBundle(KERNEL_A, CODE_A, "A's private logs"));
  expect(up.statusCode, up.body).toBe(200);
  uploadA = (up.json() as { uploadId: string }).uploadId;
});

afterAll(async () => {
  await app?.close();
});

const threadIds = (res: { json(): unknown }) => ((res.json() as { threads?: Array<{ id: string }> }).threads ?? []).map((t) => t.id);
const adminThread = async (id: string) =>
  (await inj("GET", `/api/operator/support/${id}`, keyA, admin)).json() as {
    thread: { operatorId?: string; status: string; messages: Array<{ text: string; retrievalCode?: string }> };
  };

describe("support threads: only the creating identity (or the admin secret) reads or writes them", () => {
  it("[neg] another key's list does not include A's thread", async () => {
    const res = await inj("GET", "/api/operator/support", keyB);
    expect(res.statusCode).toBe(200);
    expect(threadIds(res)).not.toContain(threadA);
  });

  it("[neg] another key cannot read A's thread by id (404, as for an unknown id)", async () => {
    const res = await inj("GET", `/api/operator/support/${threadA}`, keyB);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(CODE_A);
  });

  it("[neg] another key cannot read A's threads by naming A's kernel", async () => {
    const res = await inj("GET", `/api/operator/support/mine?kernelId=${KERNEL_A}`, keyB);
    expect(res.statusCode).toBe(200);
    expect(threadIds(res)).not.toContain(threadA);
    expect(res.body).not.toContain(CODE_A);
  });

  it("[neg] PATCH needs the admin secret: another key cannot close A's thread", async () => {
    // Its own thread, so a PATCH that wrongly succeeds cannot mask the append tests below.
    const own = await inj("POST", "/api/operator/support", keyA, {}, { kernelId: `kernel-a-patch-${++seq}`, message: "A, patch target" });
    const target = (own.json() as { threadId: string }).threadId;
    const res = await inj("PATCH", `/api/operator/support/${target}`, keyB, {}, { status: "closed" });
    expect([401, 403, 404]).toContain(res.statusCode);
    expect((await adminThread(target)).thread.status).not.toBe("closed");
  });

  it("[neg] a message for A's kernel from another key is not appended to A's thread", async () => {
    const res = await inj("POST", "/api/operator/support", keyB, {}, { kernelId: KERNEL_A, message: "B writes into A's thread" });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { threadId: string }).threadId).not.toBe(threadA);
    expect((await adminThread(threadA)).thread.messages.map((m) => m.text)).not.toContain("B writes into A's thread");
  });

  it("[neg] a thread another key opened first for C's kernel does not capture C's messages or retrieval code", async () => {
    const kernelC = `kernel-late-c-${++seq}`;
    const trap = await inj("POST", "/api/operator/support", keyB, {}, { kernelId: kernelC, message: "opened by B first" });
    const trapId = (trap.json() as { threadId: string }).threadId;
    const real = await inj("POST", "/api/operator/support", keyC, {}, { kernelId: kernelC, message: "C's real report", retrievalCode: "RC-C-SECRET" });
    expect(real.statusCode, real.body).toBe(200);
    expect((real.json() as { threadId: string }).threadId).not.toBe(trapId);
    const asB = await inj("GET", `/api/operator/support/${trapId}`, keyB);
    expect(asB.body).not.toContain("RC-C-SECRET");
    const mineB = await inj("GET", `/api/operator/support/mine?kernelId=${kernelC}`, keyB);
    expect(mineB.body).not.toContain("RC-C-SECRET");
  });

  it("[neg] operators with no kernel id ('unknown', as pcc-node sends) do not share one thread", async () => {
    const a = await inj("POST", "/api/operator/support", keyA, {}, { kernelId: "unknown", message: "A without a kernel" });
    const b = await inj("POST", "/api/operator/support", keyB, {}, { kernelId: "unknown", message: "B without a kernel" });
    expect((b.json() as { threadId: string }).threadId).not.toBe((a.json() as { threadId: string }).threadId);
    const mineA = await inj("GET", "/api/operator/support/mine?kernelId=unknown", keyA);
    expect(mineA.body).not.toContain("B without a kernel");
  });

  it("control: the owner lists, reads and polls its own thread; its next message joins it", async () => {
    expect(threadIds(await inj("GET", "/api/operator/support", keyA))).toContain(threadA);
    const own = await inj("GET", `/api/operator/support/${threadA}`, keyA);
    expect(own.statusCode).toBe(200);
    expect(own.body).toContain(CODE_A);
    expect(threadIds(await inj("GET", `/api/operator/support/mine?kernelId=${KERNEL_A}`, keyA))).toContain(threadA);
    const again = await inj("POST", "/api/operator/support", keyA, {}, { kernelId: KERNEL_A, message: "A follows up" });
    expect((again.json() as { threadId: string }).threadId).toBe(threadA);
  });

  it("control: the admin secret lists every thread, reads any, and changes status", async () => {
    expect(threadIds(await inj("GET", "/api/operator/support", keyB, admin))).toContain(threadA);
    const patched = await inj("PATCH", `/api/operator/support/${threadA}`, keyB, admin, { status: "resolved" });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((await adminThread(threadA)).thread.status).toBe("resolved");
  });
});

describe("diagnostic uploads: only the uploading identity (or the admin secret) lists, fetches or decrypts them", () => {
  it("[neg] an upload whose kernelId names another key's identity is not in that key's list", async () => {
    const planted = await inj("POST", "/api/operator/diagnostics", keyC, {}, sealedBundle(B, "RC-PLANT", "planted"));
    const plantedId = (planted.json() as { uploadId: string }).uploadId;
    const res = await inj("GET", "/api/operator/diagnostics", keyB);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { uploads: Array<{ id: string }> }).uploads.map((u) => u.id)).not.toContain(plantedId);
  });

  it("[neg] another key cannot fetch A's upload by id (404)", async () => {
    const res = await inj("GET", `/api/operator/diagnostics/${uploadA}`, keyB);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("ciphertext_b64");
  });

  it("[neg] another key cannot decrypt A's upload even with the right retrieval code (404)", async () => {
    const res = await inj("POST", "/api/operator/diagnostics/decrypt", keyB, {}, { uploadId: uploadA, retrievalCode: CODE_A });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("A's private logs");
  });

  it("control: the uploader sees its upload (uploaded under a KERNEL id), fetches it and decrypts it", async () => {
    const list = await inj("GET", "/api/operator/diagnostics", keyA);
    expect((list.json() as { uploads: Array<{ id: string }> }).uploads.map((u) => u.id)).toContain(uploadA);
    expect((await inj("GET", `/api/operator/diagnostics/${uploadA}`, keyA)).statusCode).toBe(200);
    const dec = await inj("POST", "/api/operator/diagnostics/decrypt", keyA, {}, { uploadId: uploadA, retrievalCode: CODE_A });
    expect(dec.statusCode, dec.body).toBe(200);
    expect(dec.body).toContain("A's private logs");
  });

  it("control: the admin secret fetches and decrypts any upload (support's workflow)", async () => {
    expect((await inj("GET", `/api/operator/diagnostics/${uploadA}`, keyB, admin)).statusCode).toBe(200);
    const dec = await inj("POST", "/api/operator/diagnostics/decrypt", keyB, admin, { uploadId: uploadA, retrievalCode: CODE_A });
    expect(dec.statusCode, dec.body).toBe(200);
  });
});
