import { asc, desc, eq } from "drizzle-orm";
import { gatewayReceipts } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type {
  GatewayReceiptInsert,
  GatewayReceiptRow,
  GatewayReceiptSessionSnapshot,
  IGatewayReceiptRepository,
} from "../interfaces/IGatewayReceiptRepository.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function capLimit(limit?: number): number {
  if (!limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

/**
 * The load-bearing receipt fields duplicated across BOTH the JSON `body` column
 * and the scalar columns (§8.3). A persisted GatewayReceipt is a signed artifact;
 * the signature covers the receipt content, so if the stored `body` and the
 * scalar columns disagree on any of these, the row is corrupt and must never be
 * served — `assertRowIntegrity` fails closed on ANY divergence. These are exactly
 * the fields `record()` writes into both places (gateway-receipt-store.ts: the
 * receipt is `{ ...content, signature }`, and the columns duplicate them).
 */
const INTEGRITY_FIELDS: ReadonlyArray<keyof GatewayReceiptRow> = [
  "receiptId",
  "gatewayKeyId",
  "jobId",
  "sessionId",
  "seq",
  "checkpointHash",
  "previousAcceptedHash",
  "sessionStateVersion",
  "acceptedAt",
  "signature",
];

/**
 * Persistence for gateway receipts (§8.3). Pure data access — canonicalization,
 * signing, and the transactional-acceptance ordering live in the gateway's
 * step-5 module services/gateway-receipt-store.ts (unit-proven, NOT yet wired
 * into a live route — step 6 wires it). This class only reads and writes rows.
 *
 * `insert` uses `.returning().get()` so the write path can construct the
 * returned receipt FROM the persisted row (the §8.3 "construct receipt FROM
 * PERSISTED VALUES" step).
 *
 * INTEGRITY ON READ (§8.3, step-5 hardening): every full-row read routes through
 * `assertRowIntegrity`, which throws if the JSON `body` diverges from the scalar
 * columns on any load-bearing field. A body/column drift is corruption of a
 * signed artifact — it fails closed rather than being silently served. `insert`
 * is deliberately NOT asserted (it is the write path; it must be able to persist
 * whatever it is given, and construct-from-persisted reads the body it just
 * wrote). `lastAcceptedForSession` returns a column projection with no `body`, so
 * there is nothing to reconcile — it is not asserted (see its comment).
 */
export class GatewayReceiptRepository implements IGatewayReceiptRepository {
  constructor(private db: StoreDB) {}

  /**
   * Assert the JSON `body` equals the scalar columns for every load-bearing
   * field, then return the row unchanged. Prefers assert-on-read over
   * reconstructing the row from columns: a mismatch is a real integrity fault
   * and must surface, not be papered over. Throws a clear Error naming the first
   * diverging field. Fails closed if `body` is not valid JSON / not an object.
   */
  private assertRowIntegrity(row: GatewayReceiptRow): GatewayReceiptRow {
    let body: unknown;
    try {
      body = typeof row.body === "string" ? JSON.parse(row.body) : row.body;
    } catch {
      throw new Error(
        `gateway_receipts integrity violation (receiptId=${String(row.receiptId)}): body is not valid JSON`,
      );
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new Error(
        `gateway_receipts integrity violation (receiptId=${String(row.receiptId)}): body is not a JSON object`,
      );
    }
    const bodyRecord = body as Record<string, unknown>;
    const rowRecord = row as unknown as Record<string, unknown>;
    for (const field of INTEGRITY_FIELDS) {
      const bodyVal = bodyRecord[field];
      const colVal = rowRecord[field];
      if (bodyVal !== colVal) {
        throw new Error(
          `gateway_receipts integrity violation (receiptId=${String(row.receiptId)}): ` +
            `body.${field}=${JSON.stringify(bodyVal)} != column ${field}=${JSON.stringify(colVal)}`,
        );
      }
    }
    return row;
  }

  insert(record: GatewayReceiptInsert) {
    return this.db
      .insert(gatewayReceipts)
      .values(record)
      .returning()
      .get();
  }

  findById(receiptId: string) {
    const row = this.db
      .select()
      .from(gatewayReceipts)
      .where(eq(gatewayReceipts.receiptId, receiptId))
      .get();
    return row ? this.assertRowIntegrity(row) : row;
  }

  findByJob(jobId: string, limit?: number) {
    return this.db
      .select()
      .from(gatewayReceipts)
      .where(eq(gatewayReceipts.jobId, jobId))
      .orderBy(asc(gatewayReceipts.createdAt))
      .limit(capLimit(limit))
      .all()
      .map((row) => this.assertRowIntegrity(row));
  }

  findBySession(sessionId: string, limit?: number) {
    // seq-ascending: a session's receipts ARE its accepted chain, in order.
    // CAPPED (DEFAULT_LIMIT / MAX_LIMIT) — fine for UI, WRONG for protocol chain
    // reconstruction / evidenceRoot: a >MAX_LIMIT chain silently truncates → a
    // forked root. Those paths MUST use findAllBySession (uncapped) instead.
    return this.db
      .select()
      .from(gatewayReceipts)
      .where(eq(gatewayReceipts.sessionId, sessionId))
      .orderBy(asc(gatewayReceipts.seq))
      .limit(capLimit(limit))
      .all()
      .map((row) => this.assertRowIntegrity(row));
  }

  findAllBySession(sessionId: string) {
    // The FULL session chain, seq-ascending, with NO limit. evidenceRoot /
    // chain-reconstruction / recovery paths MUST use this, never the capped
    // findBySession — a truncated chain would compute a forked evidence root.
    return this.db
      .select()
      .from(gatewayReceipts)
      .where(eq(gatewayReceipts.sessionId, sessionId))
      .orderBy(asc(gatewayReceipts.seq))
      .all()
      .map((row) => this.assertRowIntegrity(row));
  }

  findByCheckpointHash(checkpointHash: string) {
    return this.db
      .select()
      .from(gatewayReceipts)
      .where(eq(gatewayReceipts.checkpointHash, checkpointHash))
      .orderBy(asc(gatewayReceipts.createdAt))
      .all()
      .map((row) => this.assertRowIntegrity(row));
  }

  lastAcceptedForSession(
    sessionId: string,
  ): GatewayReceiptSessionSnapshot | undefined {
    // Column projection (no `body`) — there is no body to reconcile against the
    // columns, so this is intentionally NOT routed through assertRowIntegrity
    // (which would have nothing to assert and could not fabricate a body).
    const row = this.db
      .select({
        seq: gatewayReceipts.seq,
        checkpointHash: gatewayReceipts.checkpointHash,
        receiptId: gatewayReceipts.receiptId,
      })
      .from(gatewayReceipts)
      .where(eq(gatewayReceipts.sessionId, sessionId))
      .orderBy(desc(gatewayReceipts.seq))
      .limit(1)
      .get();
    if (!row) return undefined;
    return {
      lastSeq: row.seq,
      lastHash: row.checkpointHash,
      lastReceiptId: row.receiptId,
    };
  }
}
