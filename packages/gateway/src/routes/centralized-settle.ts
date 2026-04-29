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
      const body = (req.body ?? {}) as SettleBody;
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
