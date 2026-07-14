/**
 * Unit tests for the §8.5-step-6 async evidence flow: CheckpointClient + createAsyncKernelHandler.
 *
 * The gateway is mocked with a FAITHFUL in-memory fake that mirrors the real endpoints'
 * byte-level contract — so a passing test means the device speaks the gateway's language:
 *   - it computes checkpointHash with node:crypto `createHash` over `canonicalize(content)`
 *     (exactly the real gateway, evidence-async.ts) → proves the client's @pcc/spec.sha256
 *     path is BYTE-IDENTICAL,
 *   - it signs receipts with node:crypto raw Ed25519 over `canonicalize(receipt sans sig)`
 *     (exactly the real gateway signer, auth/ed25519.ts) → the client verifies them with
 *     tweetnacl, proving RFC-8032 cross-library verification,
 *   - it verifies the session signature over `canonicalize(content)` against the delegation's
 *     public key, enforces `checkpointType ∈ scope.allowedActions` (SessionKeyService check 4),
 *     and (when given the principal pubkey) verifies the parent delegation over the canonical
 *     session-key bytes → proves the handler mints a delegation the real gateway accepts.
 *
 * No live gateway is required.
 */

import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import nacl from "tweetnacl";
import { canonicalize } from "@pcc/spec";
import type { DigitalKernelManifest, PrincipalKey, SessionKeyAuthorization } from "@pcc/spec";
import {
  CheckpointClient,
  CheckpointSubmissionError,
  createAsyncKernelHandler,
  DEFAULT_CHECKPOINT_ACTIONS,
  createKernelHandler,
  verifyBundleSignature,
} from "../index.js";

// ── hex + hash helpers (tests may use Buffer / node:crypto; they are build-excluded) ──

const toHexT = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const fromHexT = (h: string): Uint8Array =>
  Uint8Array.from(Buffer.from(h.startsWith("0x") ? h.slice(2) : h, "hex"));
const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Independent (node:crypto + shared canonicalize) recomputation of the cross-wave hash. */
function canonicalSha256T(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

/** Independent replica of the gateway's canonical session-key bytes (explicit key order). */
function canonicalSessionKeyBytesT(auth: SessionKeyAuthorization): Uint8Array {
  const body: Record<string, unknown> = {
    sessionId: auth.sessionId,
    parentAgentId: auth.parentAgentId,
    publicKey: auth.publicKey,
    issuedAt: auth.issuedAt,
    expiresAt: auth.expiresAt,
    scope: {
      allowedActions: [...auth.scope.allowedActions].sort(),
      contractIds: [...auth.scope.contractIds].sort(),
      maxSignatures: auth.scope.maxSignatures,
    },
  };
  if (auth.derivationPath !== undefined) body.derivationPath = auth.derivationPath;
  return new TextEncoder().encode(JSON.stringify(body));
}

interface CheckpointBody {
  sessionId: string;
  seq: number;
  createdAt: number;
  prevCheckpointHash: string | null;
  eventsRoot: string;
  checkpointType: string;
  signature: string;
}
interface RecordedCall {
  path: string;
  body: any;
}

/** A faithful in-memory gateway for the three async endpoints. */
class FakeGateway {
  private readonly receiptPriv: KeyObject;
  readonly receiptPublicKeyHex: string;
  readonly keyId = "gw-rcpt-test";
  private readonly sessions = new Map<
    string,
    {
      auth: SessionKeyAuthorization;
      nextSeq: number;
      lastHash: string | null;
      hashes: string[];
      eventsRootBySeq: Map<number, string>;
      revealedBySeq: Map<number, unknown>;
    }
  >();
  readonly calls: RecordedCall[] = [];

  /** When set, begin verifies the parent delegation over the canonical session-key bytes. */
  parentPublicKeyHex: string | null = null;
  /** Return a 409 seq_gap_or_replay exactly once (network-blip simulation), without advancing. */
  blipCheckpointOnce = false;
  /** Corrupt the next minted receipt signature (integrity-failure simulation). */
  corruptNextReceiptSig = false;

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    this.receiptPriv = privateKey;
    const spki = publicKey.export({ type: "spki", format: "der" });
    this.receiptPublicKeyHex = Buffer.from(spki.subarray(12)).toString("hex");
  }

  get fetchImpl(): typeof fetch {
    return (async (url: unknown, init: any) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(init.body as string) : {};
      this.calls.push({ path, body });
      const jobId = path.split("/")[3];
      let out: { status: number; body: unknown };
      if (path.endsWith("/evidence/begin")) out = this.begin(jobId, body);
      else if (path.endsWith("/reveal")) out = this.reveal(path, body);
      else if (path.endsWith("/evidence/checkpoints")) out = this.checkpoint(jobId, body);
      else if (path.endsWith("/evidence/finalize")) out = this.finalize(jobId, body);
      else out = { status: 404, body: { error: "not_found" } };
      return {
        ok: out.status >= 200 && out.status < 300,
        status: out.status,
        json: async () => out.body,
      } as Response;
    }) as unknown as typeof fetch;
  }

  private begin(jobId: string, body: any): { status: number; body: unknown } {
    const auth = body.sessionKeyAuthorization as SessionKeyAuthorization;
    if (this.parentPublicKeyHex) {
      const ok = nacl.sign.detached.verify(
        canonicalSessionKeyBytesT(auth),
        fromHexT(auth.parentSignature),
        fromHexT(this.parentPublicKeyHex),
      );
      if (!ok) return { status: 403, body: { error: "delegation_invalid", reason: "parent_signature_invalid" } };
    }
    let s = this.sessions.get(auth.sessionId);
    const idempotent = Boolean(s);
    if (!s) {
      s = { auth, nextSeq: 1, lastHash: null, hashes: [], eventsRootBySeq: new Map(), revealedBySeq: new Map() };
      this.sessions.set(auth.sessionId, s);
    }
    return {
      status: idempotent ? 200 : 201,
      body: {
        sessionId: auth.sessionId,
        window: { notBefore: nowSec(), expiresAt: auth.expiresAt, evidenceSubmissionDeadline: auth.expiresAt + 3600 },
        maxSignatures: auth.scope.maxSignatures,
        nextSeq: s.nextSeq,
        lastAcceptedHash: s.lastHash,
        gatewayReceiptPublicKey: this.receiptPublicKeyHex,
        checkpointPath: `/api/jobs/${jobId}/evidence/checkpoints`,
        finalizePath: `/api/jobs/${jobId}/evidence/finalize`,
        ...(idempotent ? { idempotent: true } : {}),
      },
    };
  }

  private checkpoint(jobId: string, body: CheckpointBody): { status: number; body: unknown } {
    const s = this.sessions.get(body.sessionId);
    if (!s) return { status: 404, body: { error: "session_not_found" } };
    if (this.blipCheckpointOnce) {
      this.blipCheckpointOnce = false;
      return { status: 409, body: { error: "checkpoint_rejected", reason: "seq_gap_or_replay" } };
    }
    const content = {
      sessionId: body.sessionId,
      seq: body.seq,
      createdAt: body.createdAt,
      prevCheckpointHash: body.prevCheckpointHash ?? null,
      eventsRoot: body.eventsRoot,
      checkpointType: body.checkpointType,
    };
    const canonical = canonicalize(content);
    // Session signature over canonicalize(content) — proves the device signed the right bytes.
    const sigOk = nacl.sign.detached.verify(
      new TextEncoder().encode(canonical),
      fromHexT(body.signature),
      fromHexT(s.auth.publicKey),
    );
    if (!sigOk) return { status: 403, body: { error: "checkpoint_verification_failed", reason: "session_signature_invalid" } };
    // Check 4: checkpointType must be in scope.allowedActions.
    if (!s.auth.scope.allowedActions.includes(body.checkpointType)) {
      return { status: 403, body: { error: "checkpoint_verification_failed", reason: "action_not_allowed" } };
    }
    // Sequence: strict serial + chain continuity.
    if (body.seq !== s.nextSeq) return { status: 409, body: { error: "checkpoint_rejected", reason: "seq_gap_or_replay" } };
    if ((body.prevCheckpointHash ?? null) !== s.lastHash) {
      return { status: 409, body: { error: "checkpoint_rejected", reason: "chain_broken" } };
    }
    const checkpointHash = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
    const receiptContent = {
      receiptId: `grcpt-${body.sessionId}-${body.seq}`,
      gatewayKeyId: this.keyId,
      jobId,
      sessionId: body.sessionId,
      seq: body.seq,
      checkpointHash,
      previousAcceptedHash: s.lastHash,
      sessionStateVersion: body.seq,
      acceptedAt: nowSec(),
    };
    let signature = sign(null, Buffer.from(new TextEncoder().encode(canonicalize(receiptContent))), this.receiptPriv).toString("hex");
    if (this.corruptNextReceiptSig) {
      this.corruptNextReceiptSig = false;
      signature = flipLastHexNibble(signature);
    }
    const receipt = { ...receiptContent, signature };
    // Advance only after minting the receipt.
    s.nextSeq += 1;
    s.lastHash = checkpointHash;
    s.hashes.push(checkpointHash);
    s.eventsRootBySeq.set(body.seq, body.eventsRoot);
    return {
      status: 201,
      body: { receipt, skewSeconds: Math.abs(body.createdAt - receiptContent.acceptedAt), skewWithinPolicy: true },
    };
  }

  private reveal(path: string, body: any): { status: number; body: unknown } {
    const seq = Number(path.split("/")[6]); // /api/jobs/:jobId/evidence/checkpoints/:seq/reveal
    const s = this.sessions.get(body.sessionId);
    if (!s) return { status: 404, body: { error: "session_not_found" } };
    const eventsRoot = s.eventsRootBySeq.get(seq);
    if (eventsRoot === undefined) return { status: 404, body: { error: "checkpoint_not_found" } };
    if (canonicalSha256T(body.events) !== eventsRoot) {
      return { status: 422, body: { error: "payload_commitment_mismatch" } };
    }
    s.revealedBySeq.set(seq, body.events); // idempotent overwrite
    return { status: 200, body: { revealed: true, sessionId: body.sessionId, seq } };
  }

  private finalize(jobId: string, _body: any): { status: number; body: unknown } {
    const s = [...this.sessions.values()].find((x) => x.auth.scope.contractIds.includes(jobId));
    if (!s) return { status: 404, body: { error: "session_not_found" } };
    // S6-5: finalize takes NO caller payloads; it includes every DURABLY-revealed payload
    // (set via the reveal endpoint) in seq order — mirrors the real gateway.
    const payloads = [...s.revealedBySeq.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([seq, events]) => ({ seq, events }));
    return {
      status: 201,
      body: {
        package: {
          acceptedCheckpointHashes: s.hashes,
          receiptIds: s.hashes.map((_, i) => `grcpt-${i + 1}`),
          ...(payloads.length > 0 ? { payloads } : {}),
        },
        packageReceipt: { receiptId: `fmprcpt-${jobId}-0` },
        evidenceRoot: "sha256:merkle-root-placeholder",
        packageHash: "sha256:package-hash-placeholder",
      },
    };
  }

  checkpointCalls(): CheckpointBody[] {
    return this.calls.filter((c) => c.path.endsWith("/evidence/checkpoints")).map((c) => c.body);
  }
  beginCalls(): RecordedCall[] {
    return this.calls.filter((c) => c.path.endsWith("/evidence/begin"));
  }
  finalizeCalls(): RecordedCall[] {
    return this.calls.filter((c) => c.path.endsWith("/evidence/finalize"));
  }
  revealCalls(): Array<{ seq: number; body: any }> {
    return this.calls
      .filter((c) => c.path.endsWith("/reveal"))
      .map((c) => ({ seq: Number(c.path.split("/")[6]), body: c.body }));
  }
}

function flipLastHexNibble(hex: string): string {
  const last = hex[hex.length - 1];
  const flipped = last === "0" ? "1" : "0";
  return hex.slice(0, -1) + flipped;
}

/** Build a wire delegation for a test session keypair (parent sig optional). */
function makeAuth(opts: {
  sessionKeypair: nacl.SignKeyPair;
  jobId: string;
  actions: string[];
  maxSignatures?: number;
  expiresAt?: number;
  principalPrivateKey?: Uint8Array;
  parentAgentId?: string;
}): SessionKeyAuthorization {
  const now = nowSec();
  const sessionId = `evidence-${Math.random().toString(36).slice(2)}`;
  const scope = { allowedActions: opts.actions, contractIds: [opts.jobId], maxSignatures: opts.maxSignatures ?? 100 };
  const expiresAt = opts.expiresAt ?? now + 3600;
  const wire: SessionKeyAuthorization = {
    sessionId,
    parentAgentId: opts.parentAgentId ?? "agent:test-parent",
    publicKey: toHexT(opts.sessionKeypair.publicKey),
    issuedAt: now,
    expiresAt,
    scope,
    parentSignature: "00".repeat(64),
  };
  if (opts.principalPrivateKey) {
    wire.parentSignature = toHexT(nacl.sign.detached(canonicalSessionKeyBytesT(wire), opts.principalPrivateKey));
  }
  return wire;
}

function makeManifest(kernelId = "k-async", maxTTLSeconds = 3600): DigitalKernelManifest {
  return {
    manifestVersion: "1.0.0",
    kernelId,
    name: "Async Test Kernel",
    description: "unit-test kernel",
    builder: { agentId: "agent:test-async" },
    capabilityType: "temperature-converter",
    workflowSteps: [{ stepId: "s1", stepType: "transform", description: "convert", dependsOn: [] }],
    pricing: { currency: "USDC", baseUSD: 0 },
    maxAssuranceTier: 1,
    endpointURL: "https://kernel.example.com/run",
    sessionKeyPolicy: { maxTTLSeconds, allowedActions: ["evidence_submit", "workflow_step_complete"] },
    status: "pending",
  } as unknown as DigitalKernelManifest;
}

// A deferred that a test resolves to unblock a background execute.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── CheckpointClient (STAGE 1) ────────────────────────────────────────────────

describe("CheckpointClient — canonical checkpoint contract", () => {
  it("signs exactly the six-key content; eventsRoot + signature match an independent recompute", async () => {
    const gw = new FakeGateway();
    const kp = nacl.sign.keyPair();
    const auth = makeAuth({ sessionKeypair: kp, jobId: "job-1", actions: ["execution_started"] });
    const client = new CheckpointClient({
      gatewayUrl: "https://gw.test",
      apiKey: "k",
      jobId: "job-1",
      sessionKeyAuthorization: auth,
      sessionPrivateKey: kp.secretKey,
      fetchImpl: gw.fetchImpl,
    });
    await client.begin();

    const events = { z: 1, a: "two", nested: { b: [3, 2, 1] } };
    const receipt = await client.submitCheckpoint({ type: "execution_started", events });

    const posted = gw.checkpointCalls()[0];
    const contentKeys = Object.keys(posted)
      .filter((k) => k !== "signature")
      .sort();
    expect(contentKeys).toEqual(["checkpointType", "createdAt", "eventsRoot", "prevCheckpointHash", "seq", "sessionId"]);
    // genesis: seq 1, prevCheckpointHash explicit null
    expect(posted.seq).toBe(1);
    expect(posted.prevCheckpointHash).toBeNull();
    // eventsRoot: independent node:crypto + shared-canonicalize recompute (NOT the client's code)
    expect(posted.eventsRoot).toBe(canonicalSha256T(events));
    // signature is over canonicalize(content), verifiable against the session public key
    const content = {
      sessionId: posted.sessionId,
      seq: posted.seq,
      createdAt: posted.createdAt,
      prevCheckpointHash: posted.prevCheckpointHash,
      eventsRoot: posted.eventsRoot,
      checkpointType: posted.checkpointType,
    };
    const sigOk = nacl.sign.detached.verify(
      new TextEncoder().encode(canonicalize(content)),
      fromHexT(posted.signature),
      kp.publicKey,
    );
    expect(sigOk).toBe(true);
    // the returned receipt attests our exact checkpoint
    expect(receipt.seq).toBe(1);
    expect(receipt.checkpointHash).toBe(canonicalSha256T(content));
    // chain advanced to the accepted hash
    expect(client.seq).toBe(2);
    expect(client.lastAcceptedHash).toBe(receipt.checkpointHash);
  });
});

describe("CheckpointClient — strictly serial emitter", () => {
  it("submits concurrent checkpoints in strict seq order with a chained prevCheckpointHash", async () => {
    const gw = new FakeGateway();
    const kp = nacl.sign.keyPair();
    const auth = makeAuth({ sessionKeypair: kp, jobId: "job-serial", actions: ["execution_started"] });
    const client = new CheckpointClient({
      gatewayUrl: "https://gw.test",
      apiKey: "k",
      jobId: "job-serial",
      sessionKeyAuthorization: auth,
      sessionPrivateKey: kp.secretKey,
      fetchImpl: gw.fetchImpl,
    });
    await client.begin();

    // Fire five "concurrently" — they must serialize.
    const receipts = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => client.submitCheckpoint({ type: "execution_started", events: { i } })),
    );

    const posts = gw.checkpointCalls();
    expect(posts.map((p) => p.seq)).toEqual([1, 2, 3, 4, 5]);
    // prevCheckpointHash chains: first null, then the prior accepted hash.
    expect(posts[0].prevCheckpointHash).toBeNull();
    for (let i = 1; i < posts.length; i++) {
      expect(posts[i].prevCheckpointHash).toBe(receipts[i - 1].checkpointHash);
    }
    expect(receipts.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("CheckpointClient — receipt verification", () => {
  it("does NOT advance the chain and surfaces the failure on a bad receipt signature", async () => {
    const gw = new FakeGateway();
    gw.corruptNextReceiptSig = true;
    const kp = nacl.sign.keyPair();
    const auth = makeAuth({ sessionKeypair: kp, jobId: "job-badsig", actions: ["execution_started"] });
    const client = new CheckpointClient({
      gatewayUrl: "https://gw.test",
      apiKey: "k",
      jobId: "job-badsig",
      sessionKeyAuthorization: auth,
      sessionPrivateKey: kp.secretKey,
      fetchImpl: gw.fetchImpl,
    });
    await client.begin();

    await expect(client.submitCheckpoint({ type: "execution_started", events: { a: 1 } })).rejects.toMatchObject({
      name: "CheckpointSubmissionError",
      reason: "receipt_signature_invalid",
    });
    // chain did not advance
    expect(client.seq).toBe(1);
    expect(client.lastAcceptedHash).toBeNull();
    // subsequent submits fail fast (stop emitting)
    await expect(client.submitCheckpoint({ type: "execution_started", events: { a: 2 } })).rejects.toBeInstanceOf(
      CheckpointSubmissionError,
    );
  });
});

describe("CheckpointClient — resume after a network blip", () => {
  it("re-begins, resyncs, and resubmits on a 409 seq_gap_or_replay", async () => {
    const gw = new FakeGateway();
    gw.blipCheckpointOnce = true;
    const kp = nacl.sign.keyPair();
    const auth = makeAuth({ sessionKeypair: kp, jobId: "job-resume", actions: ["execution_started"] });
    const client = new CheckpointClient({
      gatewayUrl: "https://gw.test",
      apiKey: "k",
      jobId: "job-resume",
      sessionKeyAuthorization: auth,
      sessionPrivateKey: kp.secretKey,
      fetchImpl: gw.fetchImpl,
    });
    await client.begin();

    const receipt = await client.submitCheckpoint({ type: "execution_started", events: { a: 1 } });
    // one initial begin + one resync begin
    expect(gw.beginCalls()).toHaveLength(2);
    // blip POST + successful POST
    expect(gw.checkpointCalls()).toHaveLength(2);
    expect(receipt.seq).toBe(1);
    expect(client.seq).toBe(2);
    expect(client.lastAcceptedHash).toBe(receipt.checkpointHash);
  });
});

// ── createAsyncKernelHandler (STAGE 2) ─────────────────────────────────────────

describe("createAsyncKernelHandler — ack before execute resolves", () => {
  it("returns {accepted, mode:'async'} before the background execute settles", async () => {
    const gw = new FakeGateway();
    const principal = nacl.sign.keyPair();
    gw.parentPublicKeyHex = toHexT(principal.publicKey);
    const gate = deferred<Record<string, unknown>>();
    let executeResolved = false;
    const settled = deferred<{ status: string }>();

    const handler = createAsyncKernelHandler({
      manifest: makeManifest(),
      principalKey: { agentId: "agent:test-parent" } as unknown as PrincipalKey,
      principalPrivateKey: principal.secretKey,
      gatewayUrl: "https://gw.test",
      apiKey: "k",
      fetchImpl: gw.fetchImpl,
      execute: async () => {
        const out = await gate.promise;
        executeResolved = true;
        return out;
      },
      onSettled: (r) => settled.resolve(r),
    });

    const ack = await handler({ jobId: "job-ack", input: { x: 1 } });
    expect(ack).toMatchObject({ accepted: true, mode: "async", jobId: "job-ack" });
    expect(typeof ack.sessionId).toBe("string");
    expect(executeResolved).toBe(false); // execute has NOT resolved yet

    gate.resolve({ ok: true });
    await settled.promise;
    expect(executeResolved).toBe(true);
    // completion path emitted the terminal claim and finalized.
    const types = gw.checkpointCalls().map((c) => c.checkpointType);
    expect(types).toContain("execution_completed");
    expect(gw.finalizeCalls()).toHaveLength(1);
  });
});

describe("createAsyncKernelHandler — fault path", () => {
  it("emits a fault_report and does NOT finalize when execute rejects", async () => {
    const gw = new FakeGateway();
    const principal = nacl.sign.keyPair();
    gw.parentPublicKeyHex = toHexT(principal.publicKey);
    const settled = deferred<{ status: string; error?: Error }>();

    const handler = createAsyncKernelHandler({
      manifest: makeManifest(),
      principalKey: { agentId: "agent:test-parent" } as unknown as PrincipalKey,
      principalPrivateKey: principal.secretKey,
      gatewayUrl: "https://gw.test",
      apiKey: "k",
      fetchImpl: gw.fetchImpl,
      execute: async () => {
        throw new Error("boom");
      },
      onSettled: (r) => settled.resolve(r),
    });

    const ack = await handler({ jobId: "job-fault", input: {} });
    expect(ack.accepted).toBe(true);
    const result = await settled.promise;
    expect(result.status).toBe("faulted");

    const types = gw.checkpointCalls().map((c) => c.checkpointType);
    expect(types).toContain("fault_report");
    expect(types).not.toContain("execution_completed");
    expect(gw.finalizeCalls()).toHaveLength(0);
  });
});

describe("createAsyncKernelHandler — checkpoints the builder emits verify end-to-end", () => {
  it("accepts builder step checkpoints + the terminal completion, then finalizes with revealed payloads", async () => {
    const gw = new FakeGateway();
    const principal = nacl.sign.keyPair();
    gw.parentPublicKeyHex = toHexT(principal.publicKey);
    const settled = deferred<{ status: string }>();

    const handler = createAsyncKernelHandler({
      manifest: makeManifest(),
      principalKey: { agentId: "agent:test-parent" } as unknown as PrincipalKey,
      principalPrivateKey: principal.secretKey,
      gatewayUrl: "https://gw.test",
      apiKey: "k",
      fetchImpl: gw.fetchImpl,
      execute: async (input, { checkpoint }) => {
        await checkpoint({ type: "execution_started", payload: { input } });
        await checkpoint({ type: "workflow_step_completed", payload: { step: "s1" } });
        return { result: 42 };
      },
      onSettled: (r) => settled.resolve(r),
    });

    const ack = await handler({ jobId: "job-e2e", input: { celsius: 100 } });
    expect(ack.accepted).toBe(true);
    await settled.promise;

    const types = gw.checkpointCalls().map((c) => c.checkpointType);
    expect(types).toEqual(["execution_started", "workflow_step_completed", "execution_completed"]);
    // finalize revealed the kept payloads and the gateway verified every commitment (no 422).
    const fin = gw.finalizeCalls();
    expect(fin).toHaveLength(1);
    // S6-5: the client REVEALS each payload separately (verified against its eventsRoot),
    // then finalizes with NO caller payloads.
    expect(gw.revealCalls().map((c) => c.seq)).toEqual([1, 2, 3]);
    expect((fin[0].body as any).payloads).toBeUndefined();
  });
});

describe("createAsyncKernelHandler — authorizedWindow governs session expiry", () => {
  it("uses min(authorizedWindow.expiresAt, now + maxTTLSeconds)", async () => {
    // Case 1: a window SHORTER than the ceiling wins.
    const gwA = new FakeGateway();
    const principalA = nacl.sign.keyPair();
    const handlerA = createAsyncKernelHandler({
      manifest: makeManifest("k-win-short", 3600),
      principalKey: { agentId: "agent:test-parent" } as unknown as PrincipalKey,
      principalPrivateKey: principalA.secretKey,
      gatewayUrl: "https://gw.test",
      apiKey: "k",
      fetchImpl: gwA.fetchImpl,
      execute: async () => ({}),
    });
    const windowExpiry = nowSec() + 120;
    await handlerA({ jobId: "job-win-a", input: {}, authorizedWindow: { notBefore: nowSec(), expiresAt: windowExpiry } });
    const authA = gwA.beginCalls()[0].body.sessionKeyAuthorization;
    expect(authA.expiresAt).toBe(windowExpiry); // window < ceiling → window wins exactly

    // Case 2: a window LONGER than the ceiling is clamped to now + maxTTLSeconds.
    const gwB = new FakeGateway();
    const principalB = nacl.sign.keyPair();
    const handlerB = createAsyncKernelHandler({
      manifest: makeManifest("k-win-long", 3600),
      principalKey: { agentId: "agent:test-parent" } as unknown as PrincipalKey,
      principalPrivateKey: principalB.secretKey,
      gatewayUrl: "https://gw.test",
      apiKey: "k",
      fetchImpl: gwB.fetchImpl,
      execute: async () => ({}),
    });
    await handlerB({ jobId: "job-win-b", input: {}, authorizedWindow: { notBefore: nowSec(), expiresAt: nowSec() + 100_000 } });
    const authB = gwB.beginCalls()[0].body.sessionKeyAuthorization;
    expect(authB.expiresAt - authB.issuedAt).toBe(3600); // clamped to the operator ceiling
  });
});

describe("createAsyncKernelHandler — mints a delegation the gateway accepts", () => {
  it("scope.allowedActions defaults to the checkpoint lifecycle set and the parent delegation verifies", async () => {
    const gw = new FakeGateway();
    const principal = nacl.sign.keyPair();
    gw.parentPublicKeyHex = toHexT(principal.publicKey); // begin will verify the delegation
    const settled = deferred<{ status: string }>();
    const handler = createAsyncKernelHandler({
      manifest: makeManifest(),
      principalKey: { agentId: "agent:test-parent" } as unknown as PrincipalKey,
      principalPrivateKey: principal.secretKey,
      gatewayUrl: "https://gw.test",
      apiKey: "k",
      fetchImpl: gw.fetchImpl,
      execute: async () => ({ done: true }),
      onSettled: (r) => settled.resolve(r),
    });
    const ack = await handler({ jobId: "job-deleg", input: {} });
    expect(ack.accepted).toBe(true); // begin (with parent-sig verification) returned 2xx
    await settled.promise;
    const auth = gw.beginCalls()[0].body.sessionKeyAuthorization;
    expect(auth.scope.allowedActions).toEqual([...DEFAULT_CHECKPOINT_ACTIONS]);
    expect(auth.scope.contractIds).toEqual(["job-deleg"]);
  });
});

// ── Legacy handler unchanged (byte-identical behavior) ─────────────────────────

describe("createKernelHandler — legacy sync handler still works unchanged", () => {
  it("produces a session-signed evidence bundle for a valid job", async () => {
    const principal = nacl.sign.keyPair();
    const handler = createKernelHandler({
      manifest: makeManifest("k-legacy"),
      principalKey: { agentId: "agent:legacy" } as unknown as PrincipalKey,
      principalPrivateKey: principal.secretKey,
      execute: async (input) => ({ echoed: input }),
    });
    const res = await handler({ jobId: "job-legacy", input: { a: 1 } });
    expect(res.output).toEqual({ echoed: { a: 1 } });
    expect(res.evidenceBundle.jobId).toBe("job-legacy");
    expect(res.evidenceBundle.assuranceTier).toBe(0);
    // the bundle verifies under the kernel's session public key
    const sessionPub = fromHexT(res.kernelSessionPublicKey);
    expect(verifyBundleSignature(res.evidenceBundle, sessionPub)).toBe(true);
  });
});
