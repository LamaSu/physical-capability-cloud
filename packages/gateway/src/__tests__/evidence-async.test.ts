/**
 * Async evidence-signing endpoints (§8.5 step 6) — HTTP-level tests for
 * `routes/evidence-async.ts` (begin / checkpoints / finalize). Real Ed25519
 * throughout: a principal key stands in as the kernel's REGISTERED signer, a
 * SessionKeyService-issued delegation is scoped to the job, and checkpoints are
 * signed with the session private key over the byte-identical canonical content the
 * route recomputes. Backed by a real @pcc/store (:memory:).
 *
 * Covers §6: begin (wrong-key→403, window⊄terms→422, happy nextSeq/pubkey, second
 * different delegation→409, idempotent re-begin→200); checkpoint (happy accept +
 * receipt verifies, bad-sig/expired/revoked/action fail closed, expiry judged at
 * receivedAt via injected clock, skew flag never gates, three reachable
 * SequenceRejectReasons→409, exact-retry→200 idempotent, equivocation→409); finalize
 * (happy evidenceRoot+packageHash + claim-free, deadline→422, payload mismatch→422,
 * idempotent re-finalize→200, post-finalize checkpoint→409).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import { canonicalize } from "@pcc/spec";
import { SessionKeyService, merkleRoot } from "@pcc/verifier";
import { schema } from "@pcc/store";
import { evidenceAsyncRoutes } from "../routes/evidence-async.js";
import { initStore, closeStore, getStore } from "../db.js";
import { sessionSequenceStore } from "../services/session-sequence-store.js";
import { sessionRevocationStore } from "../services/session-revocation-store.js";
import { getDefaultGatewayReceiptSigner } from "../services/gateway-receipt-signer.js";

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const ACTIONS = ["execution_started", "workflow_step_completed", "execution_completed"];

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  const app = Fastify({ logger: false });
  await app.register(evidenceAsyncRoutes);
  await app.ready();
  return app;
}

/** Issue a job-scoped delegation from a given principal (the registered signer). */
function issueDelegation(
  principal: nacl.SignKeyPair,
  jobId: string,
  opts?: { ttlSeconds?: number; allowedActions?: string[]; maxSignatures?: number },
) {
  const { sessionKey, sessionPrivateKey } = new SessionKeyService().issueSessionKey({
    principal: {
      agentId: "eip155:84532:0x0000000000000000000000000000000000000001",
      walletAddress: "0x0000000000000000000000000000000000000001",
      publicKey: principal.publicKey,
    } as never,
    principalPrivateKey: principal.secretKey,
    scope: {
      allowedActions: (opts?.allowedActions ?? ACTIONS) as never,
      contractIds: [jobId],
      maxSignatures: opts?.maxSignatures ?? 100,
    },
    ttlSeconds: opts?.ttlSeconds ?? 300,
  });
  return { sessionKey, sessionPrivateKey, authorization: toAuthorization(sessionKey) };
}

/** SessionKey (Uint8Array fields) → the hex-field wire SessionKeyAuthorization. */
function toAuthorization(sk: {
  sessionId: string;
  parentAgentId: string;
  publicKey: Uint8Array;
  issuedAt: number;
  expiresAt: number;
  scope: { allowedActions: readonly string[]; contractIds: readonly string[]; maxSignatures: number };
  parentSignature: Uint8Array;
  derivationPath?: string;
}) {
  return {
    sessionId: sk.sessionId,
    parentAgentId: sk.parentAgentId,
    publicKey: `0x${toHex(sk.publicKey)}`,
    issuedAt: sk.issuedAt,
    expiresAt: sk.expiresAt,
    scope: {
      allowedActions: [...sk.scope.allowedActions],
      contractIds: [...sk.scope.contractIds],
      maxSignatures: sk.scope.maxSignatures,
    },
    parentSignature: `0x${toHex(sk.parentSignature)}`,
    ...(sk.derivationPath ? { derivationPath: sk.derivationPath } : {}),
  };
}

/** Seed a kernel (with `principal` as its REGISTERED ed25519 signer) + job + negotiation. */
function seedJob(
  jobId: string,
  registeredPublicKey: Uint8Array,
  opts?: { status?: string; contractTerms?: Record<string, unknown> },
) {
  const { db } = getStore();
  const kernelId = `kernel-${jobId}`;
  const nowIso = new Date().toISOString();
  db.insert(schema.shopKernels)
    .values({
      id: kernelId,
      name: "Test Kernel",
      operatorAddress: "op@test",
      location: { lat: 0, lng: 0 },
      physicalAddress: "test",
      maxAssuranceTier: 3,
      publicKey: "legacy-random",
      signingKeyAlgorithm: "ed25519",
      signingKeyPublicKey: `0x${toHex(registeredPublicKey)}`,
      reputation: 0,
      totalJobsCompleted: 0,
      status: "online",
      registeredAt: nowIso,
      lastHeartbeat: nowIso,
      version: "1.0.0",
    })
    .run();
  db.insert(schema.jobs)
    .values({
      id: jobId,
      stepId: "step-1",
      cwmId: "cwm-1",
      capabilityId: "cap-1",
      kernelId,
      status: opts?.status ?? "executing",
      assignedDevices: [],
      progress: 0,
    })
    .run();
  db.insert(schema.negotiationSessions)
    .values({
      id: `neg-${jobId}`,
      status: "committed",
      userAgentId: "user-1",
      kernelId,
      capabilityType: "test",
      selections: {},
      operatorConstraints: {},
      contractTerms:
        opts?.contractTerms ?? {
          executionWindowSeconds: 3600,
          evidenceDeadlineSeconds: 86400,
          assuranceTier: 1,
        },
      jobId,
      transitions: [],
      createdAt: nowIso,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })
    .run();
  return { kernelId };
}

/** Sign a checkpoint over the byte-identical canonical content the route recomputes. */
function signCheckpoint(params: {
  sessionId: string;
  seq: number;
  createdAt: number;
  prevCheckpointHash: string | null;
  events: unknown[];
  checkpointType: string;
  sessionPrivateKey: Uint8Array;
}) {
  const eventsRoot = `sha256:${createHash("sha256")
    .update(canonicalize(params.events))
    .digest("hex")}`;
  const content = {
    sessionId: params.sessionId,
    seq: params.seq,
    createdAt: params.createdAt,
    prevCheckpointHash: params.prevCheckpointHash,
    eventsRoot,
    checkpointType: params.checkpointType,
  };
  const canonical = canonicalize(content);
  const signature = toHex(
    nacl.sign.detached(new TextEncoder().encode(canonical), params.sessionPrivateKey),
  );
  const checkpointHash = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  return {
    eventsRoot,
    checkpointHash,
    body: {
      sessionId: params.sessionId,
      seq: params.seq,
      createdAt: params.createdAt,
      prevCheckpointHash: params.prevCheckpointHash,
      eventsRoot,
      checkpointType: params.checkpointType,
      signature,
    },
  };
}

let jobCounter = 0;
function freshJobId(): string {
  return `job-async-${++jobCounter}`;
}

describe("evidence-async endpoints (§8.5 step 6)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    // Reset the process-wide singletons the route composes (fresh DB per test too).
    sessionSequenceStore.clear();
    sessionRevocationStore.clear();
    app = await buildApp();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
    closeStore();
  });

  // ─── begin ───────────────────────────────────────────────────────────────
  describe("POST /begin", () => {
    it("happy: 201 with correct sessionId/nextSeq/pubkey/paths", async () => {
      const jobId = freshJobId();
      const principal = nacl.sign.keyPair();
      seedJob(jobId, principal.publicKey);
      const { authorization } = issueDelegation(principal, jobId);

      const res = await app.inject({
        method: "POST",
        url: `/api/jobs/${jobId}/evidence/begin`,
        payload: { sessionKeyAuthorization: authorization },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.sessionId).toBe(`evs-${jobId}-0`);
      expect(body.nextSeq).toBe(1);
      expect(body.lastAcceptedHash).toBeNull();
      expect(body.maxSignatures).toBe(100);
      expect(body.gatewayReceiptPublicKey).toBe(getDefaultGatewayReceiptSigner().publicKeyHex);
      expect(body.checkpointPath).toBe(`/api/jobs/${jobId}/evidence/checkpoints`);
      expect(body.finalizePath).toBe(`/api/jobs/${jobId}/evidence/finalize`);
      expect(body.window.evidenceSubmissionDeadline).toBeGreaterThan(body.window.expiresAt);
    });

    it("wrong-key delegation → 403 delegation_invalid", async () => {
      const jobId = freshJobId();
      const registered = nacl.sign.keyPair();
      const attacker = nacl.sign.keyPair();
      seedJob(jobId, registered.publicKey); // kernel registers `registered`...
      const { authorization } = issueDelegation(attacker, jobId); // ...but delegation signed by `attacker`

      const res = await app.inject({
        method: "POST",
        url: `/api/jobs/${jobId}/evidence/begin`,
        payload: { sessionKeyAuthorization: authorization },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("delegation_invalid");
      expect(res.json().reason).toBe("parent_signature_invalid");
    });

    it("delegation window ⊄ terms → 422 delegation_outside_window", async () => {
      const jobId = freshJobId();
      const principal = nacl.sign.keyPair();
      // terms authorize only a 5s execution window; the 300s delegation exceeds it.
      seedJob(jobId, principal.publicKey, {
        contractTerms: { executionWindowSeconds: 5, evidenceDeadlineSeconds: 5 },
      });
      const { authorization } = issueDelegation(principal, jobId, { ttlSeconds: 300 });

      const res = await app.inject({
        method: "POST",
        url: `/api/jobs/${jobId}/evidence/begin`,
        payload: { sessionKeyAuthorization: authorization },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("delegation_outside_window");
    });

    it("job not found → 404; terminal job → 409", async () => {
      const missing = await app.inject({
        method: "POST",
        url: `/api/jobs/nope/evidence/begin`,
        payload: { sessionKeyAuthorization: {} },
      });
      expect(missing.statusCode).toBe(404);

      const jobId = freshJobId();
      const principal = nacl.sign.keyPair();
      seedJob(jobId, principal.publicKey, { status: "settled" });
      const { authorization } = issueDelegation(principal, jobId);
      const terminal = await app.inject({
        method: "POST",
        url: `/api/jobs/${jobId}/evidence/begin`,
        payload: { sessionKeyAuthorization: authorization },
      });
      expect(terminal.statusCode).toBe(409);
      expect(terminal.json().error).toBe("job_not_evidence_collectable");
    });

    it("idempotent re-begin (same delegation) → 200 {idempotent:true}; a different one → 409", async () => {
      const jobId = freshJobId();
      const principal = nacl.sign.keyPair();
      seedJob(jobId, principal.publicKey);
      const d1 = issueDelegation(principal, jobId);
      const url = `/api/jobs/${jobId}/evidence/begin`;

      const first = await app.inject({ method: "POST", url, payload: { sessionKeyAuthorization: d1.authorization } });
      expect(first.statusCode).toBe(201);

      const again = await app.inject({ method: "POST", url, payload: { sessionKeyAuthorization: d1.authorization } });
      expect(again.statusCode).toBe(200);
      expect(again.json().idempotent).toBe(true);

      // A DIFFERENT delegation (same registered signer) while one is open → 409.
      const d2 = issueDelegation(principal, jobId);
      const conflict = await app.inject({ method: "POST", url, payload: { sessionKeyAuthorization: d2.authorization } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error).toBe("session_already_open");
    });
  });

  // ─── checkpoints ───────────────────────────────────────────────────────────
  describe("POST /checkpoints", () => {
    /** begin a session and return its context. */
    async function begin(opts?: { maxSignatures?: number; ttlSeconds?: number }) {
      const jobId = freshJobId();
      const principal = nacl.sign.keyPair();
      seedJob(jobId, principal.publicKey);
      const del = issueDelegation(principal, jobId, opts);
      const res = await app.inject({
        method: "POST",
        url: `/api/jobs/${jobId}/evidence/begin`,
        payload: { sessionKeyAuthorization: del.authorization },
      });
      expect(res.statusCode).toBe(201);
      const sessionId: string = res.json().sessionId;
      return { jobId, principal, del, sessionId };
    }

    it("happy accept → 201 + receipt verifies against the published pubkey", async () => {
      const { jobId, del, sessionId } = await begin();
      const cp = signCheckpoint({
        sessionId,
        seq: 1,
        createdAt: Math.floor(Date.now() / 1000),
        prevCheckpointHash: null,
        events: [{ step: "start" }],
        checkpointType: "execution_started",
        sessionPrivateKey: del.sessionPrivateKey,
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/jobs/${jobId}/evidence/checkpoints`,
        payload: cp.body,
      });
      expect(res.statusCode).toBe(201);
      const receipt = res.json().receipt;
      expect(receipt.seq).toBe(1);
      expect(receipt.checkpointHash).toBe(cp.checkpointHash); // server-computed
      expect(receipt.previousAcceptedHash).toBeNull();
      // The receipt signature verifies against the gateway's published key.
      const { signature, ...content } = receipt;
      expect(getDefaultGatewayReceiptSigner().verify(content, signature)).toBe(true);
      expect(res.json().skewWithinPolicy).toBe(true);
    });

    it("bad signature → 403 (session_signature_invalid)", async () => {
      const { jobId, del, sessionId } = await begin();
      const cp = signCheckpoint({
        sessionId, seq: 1, createdAt: Math.floor(Date.now() / 1000), prevCheckpointHash: null,
        events: [{ a: 1 }], checkpointType: "execution_started", sessionPrivateKey: del.sessionPrivateKey,
      });
      const tampered = { ...cp.body, signature: `${"00"}${cp.body.signature.slice(2)}` };
      const res = await app.inject({
        method: "POST",
        url: `/api/jobs/${jobId}/evidence/checkpoints`,
        payload: tampered,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("checkpoint_verification_failed");
      expect(res.json().reason).toBe("session_signature_invalid");
    });

    it("checkpointType not in scope.allowedActions → 403 (action_not_allowed)", async () => {
      const { jobId, del, sessionId } = await begin();
      const cp = signCheckpoint({
        sessionId, seq: 1, createdAt: Math.floor(Date.now() / 1000), prevCheckpointHash: null,
        events: [{ a: 1 }], checkpointType: "not_a_permitted_action", sessionPrivateKey: del.sessionPrivateKey,
      });
      const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/checkpoints`, payload: cp.body });
      expect(res.statusCode).toBe(403);
      expect(res.json().reason).toBe("action_not_allowed");
    });

    it("expiry is judged at receivedAt (injected clock) → 403 session_expired", async () => {
      const { jobId, del, sessionId } = await begin({ ttlSeconds: 300 });
      const createdAt = Math.floor(Date.now() / 1000);
      const cp = signCheckpoint({
        sessionId, seq: 1, createdAt, prevCheckpointHash: null, events: [{ a: 1 }],
        checkpointType: "execution_started", sessionPrivateKey: del.sessionPrivateKey,
      });
      // Move the gateway clock far past the delegation expiry; expiry tracks receivedAt.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime((del.sessionKey.expiresAt + 100_000) * 1000);
      const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/checkpoints`, payload: cp.body });
      vi.useRealTimers();
      expect(res.statusCode).toBe(403);
      expect(res.json().reason).toBe("session_expired");
    });

    it("revoked before receivedAt → 403 session_revoked", async () => {
      const { jobId, del, sessionId } = await begin();
      // Revoke the DELEGATION's session id, effective before now (route receivedAt).
      sessionRevocationStore.revoke(del.sessionKey.sessionId, Math.floor(Date.now() / 1000) - 100);
      const cp = signCheckpoint({
        sessionId, seq: 1, createdAt: Math.floor(Date.now() / 1000), prevCheckpointHash: null,
        events: [{ a: 1 }], checkpointType: "execution_started", sessionPrivateKey: del.sessionPrivateKey,
      });
      const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/checkpoints`, payload: cp.body });
      expect(res.statusCode).toBe(403);
      expect(res.json().reason).toBe("session_revoked");
    });

    it("skew flag is computed but NEVER gates (large skew still 201)", async () => {
      const { jobId, del, sessionId } = await begin();
      const cp = signCheckpoint({
        sessionId, seq: 1,
        createdAt: Math.floor(Date.now() / 1000) - 100_000, // wildly skewed device clock
        prevCheckpointHash: null, events: [{ a: 1 }],
        checkpointType: "execution_started", sessionPrivateKey: del.sessionPrivateKey,
      });
      const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/checkpoints`, payload: cp.body });
      expect(res.statusCode).toBe(201); // flag only, never a gate
      expect(res.json().skewWithinPolicy).toBe(false);
      expect(res.json().skewSeconds).toBeGreaterThan(300);
    });

    it("SequenceRejectReasons surface as 409: seq gap, chain broken, max signatures", async () => {
      // seq gap: first submission is seq 5 (expects 1).
      {
        const { jobId, del, sessionId } = await begin();
        const gap = signCheckpoint({
          sessionId, seq: 5, createdAt: Math.floor(Date.now() / 1000), prevCheckpointHash: null,
          events: [{ a: 1 }], checkpointType: "execution_started", sessionPrivateKey: del.sessionPrivateKey,
        });
        const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/checkpoints`, payload: gap.body });
        expect(res.statusCode).toBe(409);
        expect(res.json().reason).toBe("seq_gap_or_replay");
      }
      // chain broken: seq 2 with the wrong prevCheckpointHash after accepting seq 1.
      {
        const { jobId, del, sessionId } = await begin();
        const now = Math.floor(Date.now() / 1000);
        const c1 = signCheckpoint({ sessionId, seq: 1, createdAt: now, prevCheckpointHash: null, events: [{ a: 1 }], checkpointType: "execution_started", sessionPrivateKey: del.sessionPrivateKey });
        expect((await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/checkpoints`, payload: c1.body })).statusCode).toBe(201);
        const c2 = signCheckpoint({ sessionId, seq: 2, createdAt: now, prevCheckpointHash: `sha256:${"00".repeat(32)}`, events: [{ b: 2 }], checkpointType: "workflow_step_completed", sessionPrivateKey: del.sessionPrivateKey });
        const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/checkpoints`, payload: c2.body });
        expect(res.statusCode).toBe(409);
        expect(res.json().reason).toBe("chain_broken");
      }
      // max signatures: delegation caps maxSignatures at 1; seq 2 exceeds it.
      {
        const { jobId, del, sessionId } = await begin({ maxSignatures: 1 });
        const now = Math.floor(Date.now() / 1000);
        const c1 = signCheckpoint({ sessionId, seq: 1, createdAt: now, prevCheckpointHash: null, events: [{ a: 1 }], checkpointType: "execution_started", sessionPrivateKey: del.sessionPrivateKey });
        expect((await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/checkpoints`, payload: c1.body })).statusCode).toBe(201);
        const c2 = signCheckpoint({ sessionId, seq: 2, createdAt: now, prevCheckpointHash: c1.checkpointHash, events: [{ b: 2 }], checkpointType: "workflow_step_completed", sessionPrivateKey: del.sessionPrivateKey });
        const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/checkpoints`, payload: c2.body });
        expect(res.statusCode).toBe(409);
        expect(res.json().reason).toBe("max_signatures_exceeded");
      }
    });

    it("exact resubmit → 200 idempotent (no 2nd receipt); different hash at same seq → 409 equivocation", async () => {
      const { jobId, del, sessionId } = await begin();
      const now = Math.floor(Date.now() / 1000);
      const c1 = signCheckpoint({ sessionId, seq: 1, createdAt: now, prevCheckpointHash: null, events: [{ a: 1 }], checkpointType: "execution_started", sessionPrivateKey: del.sessionPrivateKey });
      const url = `/api/jobs/${jobId}/evidence/checkpoints`;
      expect((await app.inject({ method: "POST", url, payload: c1.body })).statusCode).toBe(201);

      const retry = await app.inject({ method: "POST", url, payload: c1.body });
      expect(retry.statusCode).toBe(200);
      expect(retry.json().idempotent).toBe(true);
      // No second receipt row was written.
      expect(getStore().repos.gatewayReceipts.findAllBySession(sessionId)).toHaveLength(1);

      // A DIFFERENT checkpoint at the committed seq 1 (different createdAt → different hash) → equivocation.
      const fork = signCheckpoint({ sessionId, seq: 1, createdAt: now + 1, prevCheckpointHash: null, events: [{ a: 1 }], checkpointType: "execution_started", sessionPrivateKey: del.sessionPrivateKey });
      const equiv = await app.inject({ method: "POST", url, payload: fork.body });
      expect(equiv.statusCode).toBe(409);
      expect(equiv.json().error).toBe("equivocation");
    });

    it("checkpoint on an unknown session → 404; on a mismatched job → 404", async () => {
      const { jobId, del, sessionId } = await begin();
      const cp = signCheckpoint({ sessionId, seq: 1, createdAt: Math.floor(Date.now() / 1000), prevCheckpointHash: null, events: [{ a: 1 }], checkpointType: "execution_started", sessionPrivateKey: del.sessionPrivateKey });
      // wrong jobId in the path (session belongs to `jobId`).
      const res = await app.inject({ method: "POST", url: `/api/jobs/other-job/evidence/checkpoints`, payload: cp.body });
      expect(res.statusCode).toBe(404);
    });
  });

  // ─── finalize ────────────────────────────────────────────────────────────
  describe("POST /finalize", () => {
    /** begin + accept N checkpoints; returns their hashes + context. */
    async function beginAndAccept(
      count: number,
      opts?: { events?: unknown[][]; contractTerms?: Record<string, unknown> },
    ) {
      const jobId = freshJobId();
      const principal = nacl.sign.keyPair();
      seedJob(jobId, principal.publicKey, opts?.contractTerms ? { contractTerms: opts.contractTerms } : undefined);
      const del = issueDelegation(principal, jobId);
      const beginRes = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/begin`, payload: { sessionKeyAuthorization: del.authorization } });
      expect(beginRes.statusCode).toBe(201);
      const sessionId: string = beginRes.json().sessionId;
      const now = Math.floor(Date.now() / 1000);
      const hashes: string[] = [];
      let prev: string | null = null;
      for (let i = 0; i < count; i++) {
        const events = opts?.events?.[i] ?? [{ i }];
        const cp = signCheckpoint({ sessionId, seq: i + 1, createdAt: now, prevCheckpointHash: prev, events, checkpointType: ACTIONS[i % ACTIONS.length], sessionPrivateKey: del.sessionPrivateKey });
        const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/checkpoints`, payload: cp.body });
        expect(res.statusCode).toBe(201);
        prev = cp.checkpointHash;
        hashes.push(cp.checkpointHash);
      }
      return { jobId, sessionId, del, hashes };
    }

    it("happy: 201 with evidenceRoot=merkleRoot + packageHash, and a CLAIM-FREE package", async () => {
      const { jobId, hashes } = await beginAndAccept(3);
      const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/finalize`, payload: {} });
      expect(res.statusCode).toBe(201);
      const b = res.json();
      expect(b.evidenceRoot).toBe(merkleRoot(hashes));
      expect(b.packageHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(b.package.acceptedCheckpointHashes).toEqual(hashes);
      // Claim-free: no tier / oracleVerified / success / outcome anywhere in the package.
      expect(b.package).not.toHaveProperty("assuranceTier");
      expect(b.package).not.toHaveProperty("oracleVerified");
      expect(b.package).not.toHaveProperty("success");
      expect(b.package).not.toHaveProperty("outcome");
      // Job flipped to evidence_finalized (route owns job vocab).
      expect(getStore().repos.jobs.findById(jobId)?.status).toBe("evidence_finalized");
    });

    it("finalize past the deadline → 422 (injected clock)", async () => {
      // exec window 3600 lets begin pass with a 300s delegation; deadline = beginNow + 3600.
      const { jobId } = await beginAndAccept(1, {
        contractTerms: { executionWindowSeconds: 3600, evidenceDeadlineSeconds: 3600 },
      });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime((Math.floor(Date.now() / 1000) + 100_000) * 1000);
      const res = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/finalize`, payload: {} });
      vi.useRealTimers();
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("evidence_deadline_passed");
    });

    it("revealed payload that does not match the receipted eventsRoot → 422", async () => {
      const { jobId } = await beginAndAccept(1, { events: [[{ real: 1 }]] });
      const res = await app.inject({
        method: "POST",
        url: `/api/jobs/${jobId}/evidence/finalize`,
        payload: { payloads: [{ seq: 1, events: [{ tampered: true }] }] },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("payload_commitment_mismatch");
    });

    it("idempotent re-finalize → 200; and a post-finalize checkpoint → 409", async () => {
      const { jobId, sessionId, del } = await beginAndAccept(2);
      const first = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/finalize`, payload: {} });
      expect(first.statusCode).toBe(201);
      const second = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/finalize`, payload: {} });
      expect(second.statusCode).toBe(200);
      expect(second.json().idempotent).toBe(true);
      expect(second.json().packageHash).toBe(first.json().packageHash);

      // A checkpoint after finalize: the session is no longer `open` → 409.
      const cp = signCheckpoint({ sessionId, seq: 3, createdAt: Math.floor(Date.now() / 1000), prevCheckpointHash: null, events: [{ x: 1 }], checkpointType: "execution_completed", sessionPrivateKey: del.sessionPrivateKey });
      const post = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/evidence/checkpoints`, payload: cp.body });
      expect(post.statusCode).toBe(409);
      expect(post.json().error).toBe("session_not_open");
    });

    it("finalize with no session → 404", async () => {
      const res = await app.inject({ method: "POST", url: `/api/jobs/no-such-job/evidence/finalize`, payload: {} });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("session_not_found");
    });
  });
});
