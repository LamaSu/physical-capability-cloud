/**
 * Settlement READ routes (#573) — the three routes gen-UI's Surface A renders.
 *
 *   GET /api/settlement/units/:unitId/receipt      -> SettlementReceiptDTO
 *   GET /api/settlement/units/:unitId/lifecycle    -> LifecycleDTO
 *   GET /api/settlement/units/:unitId/provenance   -> ProvenanceDTO
 *
 * Built to gen-UI read-surface contract **v1.5** (coord #666 -> #712 -> #733)
 * with escrow's DTO mapping (#667). Ownership per operator ruling #657/#661.
 *
 * ── WHY THERE IS A PORT AND NOT A CHAIN CALL ─────────────────────────
 * The V-next escrow is NOT DEPLOYED — escrow's M-2 has not produced artifact
 * (D), the deployed address, and VCR (#623/#690) is blocked on the same one. So
 * a concrete staticcall reader cannot exist yet and anything claiming to be one
 * would be fiction. The routes bind to `SettlementUnitReader`; until an
 * implementation is registered they answer INDEX_NOT_READY (503 + Retry-After)
 * — an honest "ask again later", never an empty or fabricated DTO.
 *
 * ── MONEY-CRITICAL RULES (not cosmetic) ──────────────────────────────
 *  rule 2   Asserts NOTHING sound. No verified/paid/settled boolean.
 *  rule 11  `network` is chainId-derived; `assetReality` is REGISTRY-derived.
 *  rule 12  `finalState` keys off the terminal set {8,9}, NEVER receipt presence.
 *  rule 14  Economics come from the RELEASE-VERIFIED record.
 *  rule 16  ONE pinned block per response — no torn reads.
 *  rule 21  Hybrid: staticcall-authoritative vs LOG-derived, marked per field.
 *  rule 22  Pin to the FINALIZED head, BY HASH. Base has unsafe/safe/finalized
 *           L2 heads; a money display must read `finalized`, and a non-finalized
 *           read is marked non-final or refused — never rendered as confirmed.
 *  rule 23  ABSENCE IS NOT EVIDENCE. A log-derived field is trustworthy only if
 *           the indexer is complete through the pinned block. Lagging indexer =>
 *           UNKNOWN, never an absence-based inference.
 *  rule 24  CROSS-ROUTE SNAPSHOT. Per-route pinning is NOT enough: Surface A
 *           stitches all three, and three independently-`latest` responses
 *           combine three blocks into a view that never existed. Routes accept
 *           `?asOf=<finalizedBlockHash>` and every DTO echoes {asOfBlock,
 *           asOfBlockHash}; a mismatch is 409, never a silent stitch.
 *  rule 25  Off-chain registries pin SEPARATELY; source envelope is enriched.
 *  rule 26  assetReality attests IDENTITY, not LIVENESS.
 *  #567     Pull-based only; WITHHELD renders, never blocks.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  toLifecycleView,
  deriveRefundReason,
  deriveFinalizedBlock,
  UnreachableUnitStateError,
  type Sourced,
  type RefundReason,
  type SettlementAnchors,
  type WindowConstants,
  type RefundWitness,
  type LifecycleView,
  type Finality,
  type Completeness,
} from "../settlement/unit-state-mapper.js";

// ── The port ──────────────────────────────────────────────────────────

export class UnitNotFoundError extends Error {
  constructor(unitId: string) {
    super(`settlement unit ${unitId} not found`);
    this.name = "UnitNotFoundError";
  }
}

/** Raised when a caller-supplied `?asOf` cannot be honoured (rule 24). */
export class SnapshotMismatchError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SnapshotMismatchError";
  }
}

/**
 * One pinned view of the chain. EVERY read in a single response must come from
 * this snapshot — that is the whole torn-read guarantee (rule 16). Without it a
 * RELEASE_ALLOCATED state could be joined to a `remainingClaimCount == 0` that
 * never coexisted at any block.
 */
export interface ChainSnapshot {
  asOfBlock: bigint;
  asOfBlockHash: string;
  /** rule 22 — money display requires "finalized". */
  finality: Finality;
  /** rule 23 — is the log index complete through this block, same canonical chain? */
  logCompleteness: Completeness;
}

export interface UnitBinding {
  chainId: number;
  escrow: string;
}

export interface EconomicsRecord {
  amount: string;
  feeAmount: string;
  recipient: string;
  token: string;
  assuranceTier: number;
}

export type ProvenanceAvailability = "AVAILABLE" | "WITHHELD" | "UNANCHORED";

export interface ProvenanceLeaf {
  kind: string;
  value: string;
}

export interface ProvenancePage {
  availability: ProvenanceAvailability;
  compositionRoot?: string;
  /** rule 25 — the provenance registry revises independently of the chain block. */
  revision?: number;
  leaves?: ProvenanceLeaf[];
  nextCursor?: string | null;
}

/**
 * Everything the three routes need. Every read takes the SNAPSHOT so all values
 * in one response come from one pinned block (rule 16/24).
 */
export interface SettlementUnitReader {
  binding(): UnitBinding;
  windows(): WindowConstants;
  /**
   * Pin the snapshot for this response.
   * - No `asOf` -> pin the current FINALIZED head (rule 22).
   * - With `asOf` (a finalized block HASH) -> pin exactly that, or throw
   *   SnapshotMismatchError if it is unknown/reorged-out (rule 24).
   */
  pinSnapshot(asOf?: string): Promise<ChainSnapshot>;
  readAnchors(unitId: string, snap: ChainSnapshot): Promise<SettlementAnchors>;
  readRefundWitness(unitId: string, snap: ChainSnapshot): Promise<RefundWitness>;
  readZeroingDischargeBlock(unitId: string, snap: ChainSnapshot): Promise<bigint | undefined>;
  readEconomics(unitId: string, snap: ChainSnapshot): Promise<EconomicsRecord | undefined>;
  /**
   * rule 11 + 25 + 26 — REGISTRY-derived, pinned separately from the chain block,
   * and it attests IDENTITY ("this IS canonical USDC at an approved deployment"),
   * NOT liveness. Circle USDC is upgradeable/pausable/blacklistable, so a
   * correctly-pinned "real" asset may still be unable to move.
   */
  readAssetIdentity(
    token: string,
  ): Promise<{ assetReality: "real" | "test" | "unknown"; registryId: string; revision?: number }>;
  readProvenance(
    unitId: string,
    snap: ChainSnapshot,
    opts: { depth?: number; limit?: number; cursor?: string },
  ): Promise<ProvenancePage>;
  readOwnerTenant(unitId: string): Promise<string | null>;
}

let reader: SettlementUnitReader | null = null;
export function setSettlementUnitReader(r: SettlementUnitReader | null): void {
  reader = r;
}

// ── Error union (contract v1.5) ───────────────────────────────────────

const ERRORS = {
  UNKNOWN_UNIT: { status: 404, code: "UNKNOWN_UNIT" },
  TENANT_FORBIDDEN: { status: 404, code: "UNKNOWN_UNIT" },
  INVALID_CURSOR: { status: 409, code: "INVALID_CURSOR" },
  EXPIRED_CURSOR: { status: 409, code: "EXPIRED_CURSOR" },
  REVISION_MISMATCH: { status: 409, code: "REVISION_MISMATCH" },
  INDEX_NOT_READY: { status: 503, code: "INDEX_NOT_READY" },
} as const;

/**
 * TENANT_FORBIDDEN is answered as an INDISTINGUISHABLE 404 (rule 7). A distinct
 * 403 would confirm the unit EXISTS to a caller not entitled to know that — an
 * existence oracle across tenants. Do not "improve" this into a helpful 403.
 */
function fail(
  reply: FastifyReply,
  kind: keyof typeof ERRORS,
  message: string,
  extra?: Record<string, unknown>,
) {
  const e = ERRORS[kind];
  if (kind === "INDEX_NOT_READY") reply.header("Retry-After", "5");
  return reply.status(e.status).send({ error: e.code, message, ...extra });
}

const UNIT_ID_RE = /^0x[0-9a-fA-F]{64}$/;
const BLOCK_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function requireReader(reply: FastifyReply): SettlementUnitReader | null {
  if (reader) return reader;
  fail(
    reply,
    "INDEX_NOT_READY",
    "The settlement read plane is not bound yet: the V-next escrow address is " +
      "not published (escrow M-2 / artifact D). Retry once deployment lands.",
  );
  return null;
}

async function tenantPermits(req: FastifyRequest, r: SettlementUnitReader, unitId: string) {
  const owner = await r.readOwnerTenant(unitId);
  if (owner === null) return true;
  return owner === (req as FastifyRequest & { tenantId?: string | null }).tenantId;
}

const str = (v: bigint | null | undefined): string | null =>
  v === null || v === undefined ? null : v.toString();

function serialiseSourced<T>(s: Sourced<T> | null): Record<string, unknown> | null {
  if (s === null) return null;
  return {
    ...s,
    value: typeof s.value === "bigint" ? s.value.toString() : s.value,
    blockNumber: str(s.blockNumber),
  };
}

/** rule 24 — the snapshot echo every DTO carries so Surface A can assert equality. */
function snapshotEcho(snap: ChainSnapshot) {
  return {
    asOfBlock: snap.asOfBlock.toString(),
    asOfBlockHash: snap.asOfBlockHash,
    finality: snap.finality,
    logCompleteness: snap.logCompleteness,
  };
}

// ── Routes ────────────────────────────────────────────────────────────

export async function settlementReadRoutes(app: FastifyInstance) {
  async function prelude(
    req: FastifyRequest,
    reply: FastifyReply,
    unitId: string,
    asOf?: string,
  ) {
    if (!UNIT_ID_RE.test(unitId)) {
      fail(reply, "UNKNOWN_UNIT", "unitId must be a 0x-prefixed 32-byte hex string");
      return null;
    }
    if (asOf !== undefined && !BLOCK_HASH_RE.test(asOf)) {
      // rule 24: asOf is a finalized block HASH, not a number. Accepting a bare
      // number would let two routes pin different blocks with the same label.
      fail(reply, "REVISION_MISMATCH", "asOf must be a 0x-prefixed 32-byte finalized block hash");
      return null;
    }
    const r = requireReader(reply);
    if (!r) return null;

    let snap: ChainSnapshot;
    try {
      snap = await r.pinSnapshot(asOf);
    } catch (e) {
      if (e instanceof SnapshotMismatchError) {
        fail(reply, "REVISION_MISMATCH", e.message);
        return null;
      }
      throw e;
    }

    // rule 22 — a non-finalized read must never render as confirmed. Refusing is
    // the honest answer for a money display; the caller can retry.
    if (snap.finality !== "finalized") {
      fail(
        reply,
        "INDEX_NOT_READY",
        `Read plane is pinned to a ${snap.finality} head; a money-display read requires a finalized head.`,
        snapshotEcho(snap),
      );
      return null;
    }

    let anchors: SettlementAnchors;
    try {
      anchors = await r.readAnchors(unitId, snap);
    } catch (e) {
      if (e instanceof UnitNotFoundError) {
        fail(reply, "UNKNOWN_UNIT", "No such settlement unit");
        return null;
      }
      throw e;
    }

    if (!(await tenantPermits(req, r, unitId))) {
      fail(reply, "TENANT_FORBIDDEN", "No such settlement unit");
      return null;
    }

    let lifecycle: LifecycleView;
    try {
      lifecycle = toLifecycleView(anchors, r.windows());
    } catch (e) {
      if (e instanceof UnreachableUnitStateError) {
        req.log?.error({ err: e, unitId }, "unreachable unit state from settlement read");
        fail(reply, "INDEX_NOT_READY", "Settlement state could not be interpreted; read may be stale or misbound");
        return null;
      }
      throw e;
    }
    return { r, anchors, lifecycle, snap };
  }

  // ── GET /lifecycle ──────────────────────────────────────────────────
  app.get<{ Params: { unitId: string }; Querystring: { asOf?: string } }>(
    "/api/settlement/units/:unitId/lifecycle",
    async (req, reply) => {
      const ctx = await prelude(req, reply, req.params.unitId, req.query.asOf);
      if (!ctx) return;
      const { r, lifecycle, snap } = ctx;
      const { chainId, escrow } = r.binding();

      return reply.send({
        chainId,
        escrow,
        unitId: req.params.unitId,
        ...snapshotEcho(snap),
        unitState: lifecycle.unitState,
        phase: lifecycle.phase,
        finalState: lifecycle.finalState,
        isTerminal: lifecycle.isTerminal,
        isAllocated: lifecycle.isAllocated,
        windowEndsAt: str(lifecycle.windowEndsAt),
      });
    },
  );

  // ── GET /receipt ────────────────────────────────────────────────────
  app.get<{ Params: { unitId: string }; Querystring: { asOf?: string } }>(
    "/api/settlement/units/:unitId/receipt",
    async (req, reply) => {
      const ctx = await prelude(req, reply, req.params.unitId, req.query.asOf);
      if (!ctx) return;
      const { r, lifecycle, snap } = ctx;
      const unitId = req.params.unitId;
      const { chainId, escrow } = r.binding();
      const chainCtx = {
        chain: `eip155:${chainId}`,
        contractOrRegistryId: escrow,
        blockNumber: snap.asOfBlock,
        blockHash: snap.asOfBlockHash,
        finality: snap.finality,
      };

      // rule 23 — ABSENCE IS NOT EVIDENCE. If the log index is not complete
      // through the pinned block, a missing witness means UNKNOWN, not "no
      // refund cause therefore released" and not DEADLINE_RECLAIM by elimination.
      const indexComplete = snap.logCompleteness === "complete";
      const isRefundPath =
        lifecycle.finalState === "SETTLED_REFUNDED" || lifecycle.unitState === 7;

      let refundReason: Sourced<RefundReason> | null = null;
      let refundReasonUnknown = false;
      if (isRefundPath) {
        const witness = await r.readRefundWitness(unitId, snap);
        const derived = deriveRefundReason(witness);
        if (derived) {
          refundReason = { ...derived, ...chainCtx, completeness: snap.logCompleteness };
        } else if (!indexComplete) {
          refundReasonUnknown = true;
        }
      }

      const zeroing = await r.readZeroingDischargeBlock(unitId, snap);
      const fb = deriveFinalizedBlock(zeroing);
      const finalizedBlock = fb ? { ...fb, ...chainCtx, completeness: snap.logCompleteness } : null;
      // Same rule-23 logic: terminal but no discharge block found while the index
      // is behind is UNKNOWN, not "no discharge happened".
      const finalizedBlockUnknown = lifecycle.isTerminal && !fb && !indexComplete;

      const economics = await r.readEconomics(unitId, snap);

      // rule 25/26 — registry pins SEPARATELY from the chain block, and attests
      // identity only.
      let assetIdentity: Record<string, unknown> | null = null;
      if (economics) {
        const a = await r.readAssetIdentity(economics.token);
        assetIdentity = {
          value: a.assetReality,
          source: "registry",
          contractOrRegistryId: a.registryId,
          revision: a.revision,
          attests: "identity-not-liveness",
        };
      }

      return reply.send({
        chainId,
        escrow,
        unitId,
        ...snapshotEcho(snap),
        // rule 2 — no settled/verified/paid boolean. Callers key off finalState.
        finalState: lifecycle.finalState,
        phase: lifecycle.phase,
        isAllocated: lifecycle.isAllocated,
        network: { chainId },
        assetReality: assetIdentity,
        economics: economics ?? null,
        refundReason: refundReasonUnknown ? "UNKNOWN" : serialiseSourced(refundReason),
        finalizedBlock: finalizedBlockUnknown ? "UNKNOWN" : serialiseSourced(finalizedBlock),
      });
    },
  );

  // ── GET /provenance ─────────────────────────────────────────────────
  app.get<{
    Params: { unitId: string };
    Querystring: { depth?: string; limit?: string; cursor?: string; asOf?: string };
  }>("/api/settlement/units/:unitId/provenance", async (req, reply) => {
    const ctx = await prelude(req, reply, req.params.unitId, req.query.asOf);
    if (!ctx) return;
    const { r, snap } = ctx;
    const unitId = req.params.unitId;
    const { chainId, escrow } = r.binding();

    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
      return fail(reply, "INVALID_CURSOR", "limit must be an integer in [1,500]");
    }
    const depth = req.query.depth ? Number(req.query.depth) : undefined;
    if (depth !== undefined && (!Number.isInteger(depth) || depth < 0)) {
      return fail(reply, "INVALID_CURSOR", "depth must be a non-negative integer");
    }

    let page: ProvenancePage;
    try {
      page = await r.readProvenance(unitId, snap, { depth, limit, cursor: req.query.cursor });
    } catch (e) {
      if (e instanceof SnapshotMismatchError) {
        return fail(reply, "REVISION_MISMATCH", e.message);
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (/expired cursor/i.test(msg)) return fail(reply, "EXPIRED_CURSOR", "Cursor has expired; restart pagination");
      if (/invalid cursor/i.test(msg)) return fail(reply, "INVALID_CURSOR", "Cursor is not valid for this unit");
      if (/revision/i.test(msg)) return fail(reply, "REVISION_MISMATCH", "Provenance revised mid-pagination; restart");
      throw e;
    }

    // DA_UNAVAILABLE is NOT an error: 200 carrying WITHHELD. Do NOT fabricate
    // roots/proofs — an empty root is indistinguishable from a real one (#567).
    if (page.availability !== "AVAILABLE") {
      return reply.send({
        chainId,
        escrow,
        unitId,
        ...snapshotEcho(snap),
        provenanceAvailability: page.availability,
      });
    }

    return reply.send({
      chainId,
      escrow,
      unitId,
      ...snapshotEcho(snap),
      provenanceAvailability: "AVAILABLE",
      compositionRoot: page.compositionRoot,
      revision: page.revision,
      leaves: page.leaves ?? [],
      // rule 25 — the cursor binds the COMPLETE snapshot (chain block + every
      // off-chain revision), not asOfBlock alone. `depth` is a graph-walk bound,
      // NOT a page-size bound.
      nextCursor: page.nextCursor ?? null,
    });
  });
}
