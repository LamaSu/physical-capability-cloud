/**
 * Settlement READ routes (#573) — the three routes gen-UI's Surface A renders.
 *
 *   GET /api/settlement/units/:unitId/receipt      -> Result<SettlementReceiptDTO>
 *   GET /api/settlement/units/:unitId/lifecycle    -> Result<LifecycleDTO>
 *   GET /api/settlement/units/:unitId/provenance   -> Result<ProvenanceDTO>
 *
 * Built to gen-UI read-surface contract v1.4 (coord #666) with escrow's DTO
 * mapping (coord #667). Ownership per operator ruling #657/#661: GATEWAY builds
 * the routes, escrow owns money-semantics, composition owns provenance, gen-UI
 * owns the contract + Surface A + review.
 *
 * ── WHY THERE IS A PORT AND NOT A CHAIN CALL ─────────────────────────
 * The V-next escrow is NOT DEPLOYED. Escrow's M-2 has not produced (D) the
 * deployed address, and VCR (#623/#690) is blocked on that same single artifact.
 * So a concrete staticcall reader cannot exist yet and anything claiming to be
 * one would be fiction. Instead the routes bind to `SettlementUnitReader`, a
 * port with exactly the reads escrow enumerated. Until an implementation is
 * registered the routes answer INDEX_NOT_READY (503 + Retry-After) — an honest
 * "ask again later", never an empty or fabricated DTO.
 *
 * ── THE RULES THAT ARE MONEY-CRITICAL, NOT COSMETIC ──────────────────
 *  rule 2   Asserts NOTHING sound. No `verified`/`paid`/`settled:boolean`, no
 *           inline signature. Returns the record + material to verify it.
 *  rule 11  `network` is chainId-derived; `assetReality` is REGISTRY-derived,
 *           NEVER chainId. Deriving it from chainId renders a test-USDC
 *           settlement as a REAL payment.
 *  rule 12  `finalState` keys off the terminal set {8,9}, NEVER off receipt
 *           presence. Enforced in the mapper, not here.
 *  rule 14  Economics come from the RELEASE-VERIFIED record, never the raw
 *           attestation/O5 field.
 *  rule 21  Hybrid provenance: staticcall-authoritative vs LOG-derived, marked
 *           per field so a reorg-exposed value never renders like a confirmed one.
 *  #567     Pull-based ONLY. Never make settlement depend on a synchronous
 *           registry write; a withheld write renders WITHHELD, never blocks.
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
} from "../settlement/unit-state-mapper.js";

// ── The port ──────────────────────────────────────────────────────────

/** Thrown by a reader when the unit does not exist (contract REVERTS UnitNotFound). */
export class UnitNotFoundError extends Error {
  constructor(unitId: string) {
    super(`settlement unit ${unitId} not found`);
    this.name = "UnitNotFoundError";
  }
}

export interface UnitBinding {
  chainId: number;
  escrow: string;
}

export interface EconomicsRecord {
  /** Base units (token decimals), decimal string. From the RELEASE-VERIFIED record (rule 14). */
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
  revision?: number;
  asOfBlock?: bigint;
  leaves?: ProvenanceLeaf[];
  nextCursor?: string | null;
}

/**
 * Everything the three routes need. Deliberately narrow: each method maps to a
 * read escrow already enumerated (#606/#667), so an implementation is a thin
 * binding rather than a design exercise.
 */
export interface SettlementUnitReader {
  binding(): UnitBinding;
  windows(): WindowConstants;
  /** `settlement(bytes32)` + `unitCounters`. MUST throw UnitNotFoundError on revert. */
  readAnchors(unitId: string): Promise<SettlementAnchors>;
  /** Log-derived refund witnesses (rule 21). */
  readRefundWitness(unitId: string): Promise<RefundWitness>;
  /** Block of the dischargeClaim that zeroed remainingClaimCount, if any. */
  readZeroingDischargeBlock(unitId: string): Promise<bigint | undefined>;
  /** Release-verified economics (rule 14). Undefined until an outcome is allocated. */
  readEconomics(unitId: string): Promise<EconomicsRecord | undefined>;
  /** REGISTRY-derived (rule 11) — never inferred from chainId. */
  readAssetReality(token: string): Promise<"REAL" | "TEST" | "UNKNOWN">;
  readProvenance(
    unitId: string,
    opts: { depth?: number; limit?: number; cursor?: string },
  ): Promise<ProvenancePage>;
  /** Tenant that owns this unit, for scoping. */
  readOwnerTenant(unitId: string): Promise<string | null>;
}

let reader: SettlementUnitReader | null = null;
/** Register the concrete reader once escrow publishes (D) the deployed address. */
export function setSettlementUnitReader(r: SettlementUnitReader | null): void {
  reader = r;
}

// ── Error union (contract v1.4) ───────────────────────────────────────

const ERRORS = {
  UNKNOWN_UNIT: { status: 404, code: "UNKNOWN_UNIT" },
  TENANT_FORBIDDEN: { status: 404, code: "UNKNOWN_UNIT" }, // see note below
  INVALID_CURSOR: { status: 409, code: "INVALID_CURSOR" },
  EXPIRED_CURSOR: { status: 409, code: "EXPIRED_CURSOR" },
  REVISION_MISMATCH: { status: 409, code: "REVISION_MISMATCH" },
  INDEX_NOT_READY: { status: 503, code: "INDEX_NOT_READY" },
} as const;

/**
 * TENANT_FORBIDDEN is answered as an INDISTINGUISHABLE 404 (contract v1.4 rule 7).
 * A distinct 403 would confirm the unit EXISTS to a caller not entitled to know
 * that — an existence oracle across tenants. The status and body are byte-identical
 * to UNKNOWN_UNIT on purpose; do not "improve" this into a helpful 403.
 */
function fail(reply: FastifyReply, kind: keyof typeof ERRORS, message: string, extra?: Record<string, unknown>) {
  const e = ERRORS[kind];
  if (kind === "INDEX_NOT_READY") reply.header("Retry-After", "5");
  return reply.status(e.status).send({ error: e.code, message, ...extra });
}

const UNIT_ID_RE = /^0x[0-9a-fA-F]{64}$/;

/** Resolve the reader or answer 503. Never fabricates a DTO. */
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

/**
 * Tenant scope. Returns true when the caller may see this unit.
 * Unowned units (null tenant) are visible to any authenticated caller —
 * they carry no tenant to leak.
 */
async function tenantPermits(req: FastifyRequest, r: SettlementUnitReader, unitId: string) {
  const owner = await r.readOwnerTenant(unitId);
  if (owner === null) return true;
  return owner === (req as FastifyRequest & { tenantId?: string | null }).tenantId;
}

function serialiseWindow(v: bigint | null): string | null {
  return v === null ? null : v.toString();
}

function serialiseSourced<T>(s: Sourced<T> | null): { value: unknown; source: string } | null {
  return s === null ? null : { value: typeof s.value === "bigint" ? s.value.toString() : s.value, source: s.source };
}

// ── Routes ────────────────────────────────────────────────────────────

export async function settlementReadRoutes(app: FastifyInstance) {
  /**
   * Shared prelude: validate the id, resolve the reader, scope the tenant, and
   * read anchors. Returns null when it has already answered.
   */
  async function prelude(req: FastifyRequest, reply: FastifyReply, unitId: string) {
    if (!UNIT_ID_RE.test(unitId)) {
      fail(reply, "UNKNOWN_UNIT", "unitId must be a 0x-prefixed 32-byte hex string");
      return null;
    }
    const r = requireReader(reply);
    if (!r) return null;

    let anchors: SettlementAnchors;
    try {
      anchors = await r.readAnchors(unitId);
    } catch (e) {
      // The contract REVERTS UnitNotFound for a non-existent unit (F-5). That
      // revert is the real signal — it is NOT a state-0 "awaiting funding".
      if (e instanceof UnitNotFoundError) {
        fail(reply, "UNKNOWN_UNIT", "No such settlement unit");
        return null;
      }
      throw e;
    }

    if (!(await tenantPermits(req, r, unitId))) {
      // Deliberately identical to UNKNOWN_UNIT — see fail() note.
      fail(reply, "TENANT_FORBIDDEN", "No such settlement unit");
      return null;
    }

    let lifecycle: LifecycleView;
    try {
      lifecycle = toLifecycleView(anchors, r.windows());
    } catch (e) {
      if (e instanceof UnreachableUnitStateError) {
        // Fail closed and loudly: an unreachable state means the READ is wrong,
        // not that the unit is awaiting funding.
        req.log?.error({ err: e, unitId }, "unreachable unit state from settlement read");
        fail(reply, "INDEX_NOT_READY", "Settlement state could not be interpreted; read may be stale or misbound");
        return null;
      }
      throw e;
    }
    return { r, anchors, lifecycle };
  }

  // ── GET /lifecycle ──────────────────────────────────────────────────
  app.get<{ Params: { unitId: string } }>(
    "/api/settlement/units/:unitId/lifecycle",
    async (req, reply) => {
      const ctx = await prelude(req, reply, req.params.unitId);
      if (!ctx) return;
      const { r, lifecycle } = ctx;
      const { chainId, escrow } = r.binding();

      return reply.send({
        chainId,
        escrow,
        unitId: req.params.unitId,
        unitState: lifecycle.unitState,
        phase: lifecycle.phase,
        // rule 12 — terminal set only.
        finalState: lifecycle.finalState,
        isTerminal: lifecycle.isTerminal,
        isAllocated: lifecycle.isAllocated,
        windowEndsAt: serialiseWindow(lifecycle.windowEndsAt),
      });
    },
  );

  // ── GET /receipt ────────────────────────────────────────────────────
  app.get<{ Params: { unitId: string } }>(
    "/api/settlement/units/:unitId/receipt",
    async (req, reply) => {
      const ctx = await prelude(req, reply, req.params.unitId);
      if (!ctx) return;
      const { r, lifecycle } = ctx;
      const unitId = req.params.unitId;
      const { chainId, escrow } = r.binding();

      // rule 21 — both of these are LOG-derived and reorg-exposed.
      let refundReason: Sourced<RefundReason> | null = null;
      if (lifecycle.finalState === "SETTLED_REFUNDED" || lifecycle.unitState === 7) {
        refundReason = deriveRefundReason(await r.readRefundWitness(unitId));
      }
      const finalizedBlock = deriveFinalizedBlock(await r.readZeroingDischargeBlock(unitId));

      // rule 14 — economics from the release-verified record only.
      const economics = await r.readEconomics(unitId);
      // rule 11 — assetReality is REGISTRY-derived, never chainId.
      const assetReality = economics ? await r.readAssetReality(economics.token) : "UNKNOWN";

      return reply.send({
        chainId,
        escrow,
        unitId,
        // No `settled: boolean` and no `verified` — rule 2. Callers key off finalState.
        finalState: lifecycle.finalState,
        phase: lifecycle.phase,
        isAllocated: lifecycle.isAllocated,
        network: { chainId }, // rule 11: chainId-derived
        assetReality, // rule 11: REGISTRY-derived
        economics: economics ?? null,
        refundReason: serialiseSourced(refundReason),
        finalizedBlock: serialiseSourced(finalizedBlock),
      });
    },
  );

  // ── GET /provenance ─────────────────────────────────────────────────
  app.get<{
    Params: { unitId: string };
    Querystring: { depth?: string; limit?: string; cursor?: string };
  }>("/api/settlement/units/:unitId/provenance", async (req, reply) => {
    const ctx = await prelude(req, reply, req.params.unitId);
    if (!ctx) return;
    const { r } = ctx;
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
      page = await r.readProvenance(unitId, { depth, limit, cursor: req.query.cursor });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/expired cursor/i.test(msg)) return fail(reply, "EXPIRED_CURSOR", "Cursor has expired; restart pagination");
      if (/invalid cursor/i.test(msg)) return fail(reply, "INVALID_CURSOR", "Cursor is not valid for this unit");
      if (/revision/i.test(msg)) return fail(reply, "REVISION_MISMATCH", "Provenance revised mid-pagination; restart");
      throw e;
    }

    // DA_UNAVAILABLE is NOT an error: it is a 200 carrying WITHHELD. A withheld
    // or failed registry write must render as unavailable, never block (#567).
    // The union is real — do NOT fabricate empty roots/proofs for WITHHELD or
    // UNANCHORED, because an empty root is indistinguishable from a real one.
    if (page.availability !== "AVAILABLE") {
      return reply.send({
        chainId,
        escrow,
        unitId,
        provenanceAvailability: page.availability,
      });
    }

    return reply.send({
      chainId,
      escrow,
      unitId,
      provenanceAvailability: "AVAILABLE",
      compositionRoot: page.compositionRoot,
      revision: page.revision,
      asOfBlock: page.asOfBlock?.toString(),
      leaves: page.leaves ?? [],
      // Opaque cursor bound to {compositionRoot, revision, asOfBlock}; `depth`
      // is a graph-walk bound, NOT a page-size bound.
      nextCursor: page.nextCursor ?? null,
    });
  });
}
