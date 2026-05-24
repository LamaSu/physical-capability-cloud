import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Invocation receipts — per-invocation provenance records for indexed-tool
 * calls routed through PCC's aggregator gateway.
 *
 * One row per InvocationReceipt (see @pcc/spec types/invocation-receipt.ts).
 * The full receipt body is stored in `body` (JSON); columns mirrored from the
 * receipt are duplicated for index-friendly query patterns:
 *
 *   - by indexed-tool id (popularity / latest invocations of a tool)
 *   - by caller agent id (who called what)
 *   - by effective DCC class (rank by provenance depth)
 *   - by receipt CID (fast lookup by content-addressed id)
 *
 * Other than column duplication for indexes, no logic lives here — the
 * receipt-signer in @pcc/aggregator owns canonicalization and signing.
 */
export const invocationReceipts = sqliteTable(
  "invocation_receipts",
  {
    id: text("id").primaryKey(),
    /** Content-addressed CID: sha256:<hex>. Indexed for fast lookup. */
    receiptCid: text("receipt_cid").notNull(),
    /** Receipt schema version (currently "1.0"). */
    schemaVersion: text("schema_version").notNull().default("1.0"),

    /** IndexedTool id at call time. */
    indexedToolId: text("indexed_tool_id").notNull(),
    /** IndexedTool CID at call time. */
    toolCid: text("tool_cid").notNull(),
    /** Schema hash bound to this call (drift detection). */
    toolSchemaHashAtCall: text("tool_schema_hash_at_call").notNull(),

    /** DCC class the caller asked for. */
    requestedDccClass: text("requested_dcc_class").notNull(),
    /** DCC class actually achieved (after min-of-three downgrade). */
    effectiveDccClass: text("effective_dcc_class").notNull(),
    /** Human-readable downgrade reason if downgraded. */
    downgradeReason: text("downgrade_reason"),

    /** PCC's signature over the canonical pre-CID body (hex). */
    pccSignature: text("pcc_signature").notNull(),
    pccKeyId: text("pcc_key_id").notNull(),
    /** Upstream signature for DCC2+. */
    upstreamSignature: text("upstream_signature"),
    upstreamKeyId: text("upstream_key_id"),
    /** OCI referrer ref for DCC3 Sigstore bundle. */
    sigstoreBundleRef: text("sigstore_bundle_ref"),
    /** TEE quote for DCC4 (base64). */
    teeQuote: text("tee_quote"),
    /** zkSNARK proof for DCC5 (base64). */
    zkProof: text("zk_proof"),

    callerAgentId: text("caller_agent_id").notNull(),
    callerSessionId: text("caller_session_id").notNull(),

    /** USDC price the caller paid (decimal string). NULL for free. */
    pricePaidUsdc: text("price_paid_usdc"),
    /** On-chain tx hash if x402-billed. */
    paymentTxHash: text("payment_tx_hash"),
    /** PCC's take in bps (100 = 1.0%). */
    pccFeeBps: integer("pcc_fee_bps").notNull().default(0),

    /** Full receipt body as JSON for round-trip + future-proofing. */
    body: text("body", { mode: "json" }).notNull(),

    /** ISO 8601 row creation timestamp. */
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    byCid: index("invocation_receipts_cid_idx").on(t.receiptCid),
    byTool: index("invocation_receipts_tool_idx").on(t.indexedToolId),
    byCaller: index("invocation_receipts_caller_idx").on(t.callerAgentId),
    byDcc: index("invocation_receipts_dcc_idx").on(t.effectiveDccClass),
    byCreated: index("invocation_receipts_created_idx").on(t.createdAt),
  }),
);
