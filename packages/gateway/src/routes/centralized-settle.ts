/**
 * Centralized substrate routes — Week 2.
 *
 * The "centralized" path is an alternative to on-chain MilestoneEscrow:
 * the gateway holds the ledger, signs receipts with its own Ed25519 key,
 * and posts a daily Merkle anchor to Anchor.sol. Operators / users get
 * the same evidentiary guarantees (signed receipt + Merkle inclusion
 * proof) without paying per-milestone gas.
 *
 * This module wires the three v1 routes:
 *
 *   POST /api/sessions/:id/settle    Centralized settle: validates state,
 *                                    runs ledger.release(), signs the
 *                                    receipt, appends to the transparency
 *                                    log, returns { signedReceipt,
 *                                    merklePath }.
 *
 *   GET  /api/receipts/:id           Receipt + Merkle path lookup by
 *                                    receipt id (a.k.a. sessionId in v1).
 *
 *   GET  /api/anchor/latest          Most recent Merkle anchor payload.
 *                                    In v1 this is an in-memory snapshot
 *                                    of the most recent appendLeaf. In
 *                                    a later week this becomes the
 *                                    composeAnchor result that was
 *                                    actually published to Anchor.sol.
 *
 * State is held in process-level singletons (this module is the owner).
 * For tests, call resetCentralizedSettleStateForTests() to wipe between
 * test cases.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import {
  MerkleLog,
  signReceipt,
  generateEd25519Keypair,
  ReceiptPayloadSchema,
  type ReceiptPayload,
  type SignedReceipt,
  type SettlementMode,
} from "@pcc/transparency-log";
import {
  EscrowLedger,
  InMemoryLedgerStore,
  EscrowEmptyError,
  type Actor,
} from "@pcc/escrow-ledger";
import {
  publishApprovalRequest,
  awaitApprovalDecision,
  mintApprovalId,
  ApprovalTimeoutError,
  type ApprovalRequestPayload,
} from "./approval-request.js";
import { getChannelIdForSession } from "./subscription.js";
import { streamHub } from "../sse/stream-hub.js";

// ── Singletons (module-level) ─────────────────────────────────────────

interface SettledRecord {
  receiptId: string;
  sessionId: string;
  signedReceipt: SignedReceipt;
  /** Canonical JSON used as the Merkle leaf bytes. */
  leafJson: string;
  /** Index into the transparency-log Merkle tree. */
  leafIndex: number;
  /** Root at the moment of append, for snapshotting. */
  rootAtAppend: string;
  /** ISO-8601 settle timestamp. */
  at: string;
}

interface CentralizedSettleState {
  log: MerkleLog;
  ledger: EscrowLedger;
  /** Sessions known to the centralized substrate. */
  sessions: Map<string, SettleableSession>;
  /** Receipts indexed by receipt id (sessionId in v1). */
  receipts: Map<string, SettledRecord>;
  /** Server signing key. Generated lazily on first settle. */
  serverKey: { privateKey: Uint8Array; publicKey: Uint8Array } | null;
}

/** Minimal session shape the substrate needs to settle. */
export interface SettleableSession {
  id: string;
  /** Lifecycle: only "committed" or "executing" can settle. */
  state: "committed" | "executing" | "settled" | "cancelled" | "disputed";
  user: Actor;
  operator: Actor;
  amountCents: number;
  capability: string;
  /** Hashed user/operator identifiers for receipt actorsHashed. */
  actorsHashed: { user: string; operator: string };
  /**
   * Per-session settlement mode. Defaults to "centralized" when absent
   * (matches the schema-level DEFAULT_SETTLEMENT_MODE). On-chain sessions
   * never reach this route — they go through MilestoneEscrow.sol.
   */
  settlementMode?: SettlementMode;
  /**
   * Operator-facing display name, surfaced into the approval-request
   * payload. Falls back to operator.id when absent.
   */
  operatorName?: string;
  /**
   * Week 6 A2: when true, the centralized-settle route fires an
   * approval-request SSE event and blocks until the user POSTs an
   * approve/reject (or the timeout fires). Default false — preserves
   * the Week 2 settle-immediately contract for sessions that don't
   * need explicit operator confirmation.
   */
  requiresApproval?: boolean;
  /**
   * Week 7 B: per-capability default snapshotted onto the session at
   * creation time from the capability spec's `requiresApproval` field.
   * Used when `session.requiresApproval` is undefined. Allows a
   * capability to declare "always require approval" without every
   * session-creation site having to remember to set the flag.
   */
  capabilityRequiresApproval?: boolean;
  /**
   * Week 7 B: per-capability monetary threshold snapshotted from the
   * capability spec's `approvalThresholdUsd`. When set and the session's
   * `amountCents` meets the threshold (in cents), the gate fires.
   */
  capabilityApprovalThresholdUsd?: number;
}

let state: CentralizedSettleState = {
  log: new MerkleLog(),
  ledger: new EscrowLedger(new InMemoryLedgerStore()),
  sessions: new Map(),
  receipts: new Map(),
  serverKey: null,
};

/** Test-only: wipe state between cases. */
export function resetCentralizedSettleStateForTests(): void {
  state = {
    log: new MerkleLog(),
    ledger: new EscrowLedger(new InMemoryLedgerStore()),
    sessions: new Map(),
    receipts: new Map(),
    serverKey: null,
  };
}

/** Test-only: register a session as settleable + lock its escrow up-front. */
export function seedSettleableSessionForTests(session: SettleableSession): void {
  state.sessions.set(session.id, session);
  // The ledger requires the user account to have funds before they can be
  // moved into escrow. In a real flow this happens via Stripe webhook /
  // ACH credit; in tests we seed deposit + lock atomically.
  state.ledger.deposit(session.user, session.amountCents);
  state.ledger.lock(session.id, session.user, session.amountCents);
}

/** Test-only: read the current ledger snapshot. */
export function getLedgerSnapshotForTests(): Record<string, number> {
  return state.ledger.getStore().snapshot();
}

/** Test-only: peek at the transparency log size. */
export function getLogSizeForTests(): number {
  return state.log.getTreeSize();
}

function getServerKey(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  if (!state.serverKey) {
    state.serverKey = generateEd25519Keypair();
  }
  return state.serverKey;
}

/** Lowercase-hex of a Uint8Array for receipt fields. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Read-only accessors for the singletons (rare; mostly for diagnostics). */
export function getCentralizedLog(): MerkleLog {
  return state.log;
}

export function getCentralizedLedger(): EscrowLedger {
  return state.ledger;
}

// ── Body schema for settle ────────────────────────────────────────────

interface SettleBody {
  /** SHA-256 of the canonical evidence bundle, hex-encoded. */
  evidenceHash?: string;
  /** ISO-8601 timestamp the kernel finalized evidence at. */
  evidenceTimestamp?: string;
  /** Override settlement mode (defaults to "centralized"). */
  settlementMode?: SettlementMode;
  /**
   * Optional override per call: force this settle through the approval
   * gate even when the session.requiresApproval flag is false. Useful for
   * agent-issued settlements that need a per-call confirmation regardless
   * of the configured policy.
   */
  requireApproval?: boolean;
}

// ── Approval gate helpers ─────────────────────────────────────────────

/**
 * Resolve whether this settle call should fire the approval gate.
 * Override hierarchy, highest priority first (each layer can short-
 * circuit the rest by returning a definite true/false):
 *
 *   1. body.requireApproval === false  → false (explicit per-call opt-out)
 *   2. body.requireApproval === true   → true  (explicit per-call opt-in)
 *   3. session.requiresApproval === true        → true  (W6: per-session)
 *   4. session.capabilityRequiresApproval === true → true  (W7 B: per-capability default)
 *   5. session.capabilityApprovalThresholdUsd     → true if amount meets threshold
 *   6. env APPROVAL_THRESHOLD_USD                 → true if amount meets threshold
 *   7. default                                    → false
 *
 * Note: layer 1 (explicit `false` from caller) wins over EVERYTHING,
 * including a capability that has `requiresApproval: true`. This is
 * intentional — agent-issued settlements with their own authorization
 * out-of-band can suppress the gate. If a capability needs an
 * un-overridable gate, that's a separate policy primitive (W8+).
 */
function shouldGateOnApproval(
  session: SettleableSession,
  body: SettleBody,
): boolean {
  // 1+2: explicit per-call override wins.
  if (body.requireApproval === true) return true;
  if (body.requireApproval === false) return false;
  // 3: per-session flag (W6).
  if (session.requiresApproval === true) return true;
  // 4: per-capability default (W7 B).
  if (session.capabilityRequiresApproval === true) return true;
  // 5: per-capability threshold (W7 B).
  const capCutoffUsd = session.capabilityApprovalThresholdUsd;
  if (typeof capCutoffUsd === "number" && capCutoffUsd >= 0) {
    const capCutoffCents = Math.floor(capCutoffUsd * 100);
    if (session.amountCents >= capCutoffCents) return true;
  }
  // 6: env threshold fallback (W6 hint).
  const raw = process.env.APPROVAL_THRESHOLD_USD;
  if (raw) {
    const cents = Math.floor(parseFloat(raw) * 100);
    if (Number.isFinite(cents) && cents > 0 && session.amountCents >= cents) {
      return true;
    }
  }
  // 7: default.
  return false;
}

// ── Routes ────────────────────────────────────────────────────────────

export async function centralizedSettleRoutes(app: FastifyInstance) {
  /**
   * POST /api/sessions/:id/settle — centralized settle path.
   *
   * Validates that the session exists and is in a settleable state,
   * releases the escrow balance to the operator, composes a signed
   * receipt, appends it to the transparency log, and returns the
   * signed receipt + Merkle inclusion proof.
   */
  app.post<{ Params: { id: string }; Body: SettleBody }>(
    "/api/sessions/:id/settle",
    async (req, reply: FastifyReply) => {
      const sessionId = req.params.id;
      const session = state.sessions.get(sessionId);
      if (!session) {
        return reply.status(404).send({
          error: "session_not_found",
          message: `Session "${sessionId}" not registered with centralized substrate`,
        });
      }

      // Reject double-settle: only "committed" or "executing" sessions
      // can transition to "settled". Anything else is a misuse.
      if (session.state !== "committed" && session.state !== "executing") {
        return reply.status(409).send({
          error: "invalid_state",
          message: `Session "${sessionId}" cannot settle from state "${session.state}"`,
          state: session.state,
        });
      }

      const body = (req.body ?? {}) as SettleBody;

      // ── Week 6 A2: optional approval gate ────────────────────────────
      //
      // When the session/body/env says this settle needs operator
      // confirmation, fire an approval-request SSE event AND block until
      // the user POSTs an approve/reject (or the timeout fires).
      //
      // Behavior contract:
      //   - approve   → continues to the regular settle path
      //   - reject    → returns 403 settle_rejected, NO ledger changes
      //   - timeout   → returns 408 approval_timeout, NO ledger changes
      //   - no SSE subscriber → returns 503 with `error: no_subscriber`
      //     so the caller can surface a helpful UI prompt
      if (shouldGateOnApproval(session, body)) {
        // W6 A3: subscribers may be on EITHER the session-id topic
        // (W5 token-as-channel-id mobiles) OR the per-session channel-id
        // topic (W6 subscribe-mobiles). Count both.
        const sessionTopic = { type: "approval" as const, id: sessionId };
        const channelId = getChannelIdForSession(sessionId);
        const channelTopic = channelId
          ? { type: "approval" as const, id: channelId }
          : null;
        const subscriberCount =
          streamHub.getSubscriberCount(sessionTopic) +
          (channelTopic ? streamHub.getSubscriberCount(channelTopic) : 0);
        if (subscriberCount === 0) {
          return reply.status(503).send({
            error: "no_subscriber",
            message:
              "Settlement requires operator approval but no SSE subscriber is connected. Open the mobile app and retry.",
          });
        }
        const approvalId = mintApprovalId();
        const requestedAt = new Date().toISOString();
        const payload: ApprovalRequestPayload = {
          id: sessionId,
          capability: session.capability,
          amountUsd: session.amountCents / 100,
          operatorName: session.operatorName ?? session.operator.id,
          evidenceHash: body.evidenceHash ?? "00".repeat(32),
          requestedAt,
          approvalId,
        };
        publishApprovalRequest(payload, {
          apiKeyId: null,
          operatorId: null,
        });
        try {
          const decision = await awaitApprovalDecision(sessionId, {
            approvalId,
          });
          if (decision.decision === "reject") {
            return reply.status(403).send({
              error: "settle_rejected",
              message: "Operator rejected the settlement",
              ...(decision.reason ? { reason: decision.reason } : {}),
            });
          }
          // Approved — fall through to the regular settle path below.
        } catch (err) {
          if (err instanceof ApprovalTimeoutError) {
            return reply.status(408).send({
              error: "approval_timeout",
              message: `User did not approve within the timeout window for session ${sessionId}`,
            });
          }
          throw err;
        }
      }

      // 1. Release the escrow balance to the operator. Throws
      //    EscrowEmptyError if there's nothing to release.
      try {
        state.ledger.release(sessionId, session.operator);
      } catch (err) {
        if (err instanceof EscrowEmptyError) {
          return reply.status(409).send({
            error: "escrow_empty",
            message: err.message,
          });
        }
        throw err;
      }

      // 2. Compose the receipt payload.
      const evidenceHash =
        body.evidenceHash ??
        // Fallback for v1: deterministic placeholder when no evidence
        // hash is supplied. A future iteration should require it.
        "00".repeat(32);
      const timestamp = body.evidenceTimestamp ?? new Date().toISOString();
      const payload: ReceiptPayload = ReceiptPayloadSchema.parse({
        milestoneId: sessionId,
        capability: session.capability,
        actorsHashed: session.actorsHashed,
        amountCents: session.amountCents,
        evidenceHash,
        timestamp,
        settlementMode: body.settlementMode ?? "centralized",
      });

      // 3. Sign with the server key.
      const { privateKey, publicKey } = getServerKey();
      const signed: SignedReceipt = signReceipt(payload, privateKey);

      // 4. Append to the transparency log. The leaf is the canonical
      //    JSON of the signed receipt, so verifiers can re-derive the
      //    leaf hash from { payload, signature, signerPublicKey }.
      const leafJson = JSON.stringify(signed);
      const leafBytes = new TextEncoder().encode(leafJson);
      const { index } = state.log.appendLeaf(leafBytes);
      const proof = state.log.getProof(index);

      // 5. Mark the session as settled and stash the record.
      session.state = "settled";
      const record: SettledRecord = {
        receiptId: sessionId,
        sessionId,
        signedReceipt: signed,
        leafJson,
        leafIndex: index,
        rootAtAppend: proof.root,
        at: new Date().toISOString(),
      };
      state.receipts.set(sessionId, record);

      return {
        signedReceipt: signed,
        merklePath: proof,
        // Canonical leaf bytes that hashed into the Merkle tree.
        // Verifiers re-encode { payload, signature, signerPublicKey }
        // exactly the same way to reproduce the leaf hash.
        leafJson,
        serverPublicKey: toHex(publicKey),
        leafIndex: index,
      };
    },
  );

  /**
   * GET /api/receipts/:id — receipt + Merkle path lookup.
   *
   * Returns the signed receipt, a Merkle inclusion proof regenerated
   * against the current root, plus the server public key.
   */
  app.get<{ Params: { id: string } }>(
    "/api/receipts/:id",
    async (req, reply: FastifyReply) => {
      const receiptId = req.params.id;
      const record = state.receipts.get(receiptId);
      if (!record) {
        return reply.status(404).send({
          error: "receipt_not_found",
          message: `Receipt "${receiptId}" does not exist`,
        });
      }
      // Re-prove against the *current* tree, not the snapshot at append.
      // The proof is wider but verifies under today's root, which is
      // what an external verifier compares against the latest anchor.
      const proof = state.log.getProof(record.leafIndex);
      const { publicKey } = getServerKey();
      return {
        signedReceipt: record.signedReceipt,
        merklePath: proof,
        leafJson: record.leafJson,
        serverPublicKey: toHex(publicKey),
        leafIndex: record.leafIndex,
        settledAt: record.at,
      };
    },
  );

  /**
   * GET /api/anchor/latest — most recent published anchor (in-memory
   * stub for v1).
   *
   * Returns the current Merkle log root + tree size. In a later
   * iteration this becomes the composeAnchor() payload that was
   * actually written to Anchor.sol.
   */
  app.get("/api/anchor/latest", async () => {
    const treeSize = state.log.getTreeSize();
    if (treeSize === 0) {
      return {
        root: null,
        treeSize: 0,
        message: "no entries in transparency log yet",
      };
    }
    const { publicKey } = getServerKey();
    return {
      root: state.log.getRoot(),
      treeSize,
      serverPublicKey: toHex(publicKey),
      // ISO-8601 of the latest settled record, if any. v1 stub.
      latestSettledAt: lastSettledTimestamp(),
    };
  });
}

function lastSettledTimestamp(): string | null {
  let latest: string | null = null;
  for (const r of state.receipts.values()) {
    if (latest === null || r.at > latest) latest = r.at;
  }
  return latest;
}
