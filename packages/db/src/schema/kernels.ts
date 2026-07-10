import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

/** Shop Kernel — the trust boundary for a physical site */
export const shopKernels = sqliteTable("shop_kernels", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  operatorAddress: text("operator_address").notNull(),
  location: text("location", { mode: "json" }).notNull().$type<{ lat: number; lng: number }>(),
  physicalAddress: text("physical_address").notNull(),
  maxAssuranceTier: integer("max_assurance_tier").notNull(),
  publicKey: text("public_key").notNull(),
  /**
   * The kernel's REAL secp256k1 signing address (checksummed 0x…), proven at
   * registration via an EIP-191 proof-of-possession over a kernelId-bound
   * message. This is the same address that appears as `kernelSignature.signer`
   * on every signed machine-log entry, so the oracle can authenticate
   * kernel-signed logs for settlement (evidence primitive #52).
   *
   * Nullable by design — fail closed: only set when a valid proof is supplied.
   * An unproven/mismatched/absent proof leaves this null (never persist an
   * unproven address; a wrong "registered" signer could clear settlement).
   * Distinct from `publicKey`, which is a legacy random value not used for auth.
   */
  signingAddress: text("signing_address"),
  /**
   * Option C — algorithm tag for the proven signing key: "secp256k1" | "ed25519".
   * secp256k1 → the proven identity is the EVM address in `signingAddress`;
   * ed25519 → the raw 32-byte public key ("0x"+64hex) is in `signingKeyPublicKey`.
   * Null when the kernel has no proven signer (fail closed). This is the tag the
   * oracle #52 verifier branches on; distinct from the legacy random `publicKey`
   * column (not used for auth). Set-once alongside the two key columns.
   */
  signingKeyAlgorithm: text("signing_key_algorithm"),
  /**
   * The proven Ed25519 signing public key ("0x" + 64 lowercase hex, raw 32-byte
   * pubkey) when `signingKeyAlgorithm === "ed25519"`. Null for secp256k1 kernels
   * (whose proven identity is `signingAddress`) and for unproven kernels.
   */
  signingKeyPublicKey: text("signing_key_public_key"),
  reputation: integer("reputation").notNull().default(0),
  totalJobsCompleted: integer("total_jobs_completed").notNull().default(0),
  /** ISO timestamp of the last reputation write (job completion/failure). Used for decay computation. */
  reputationUpdatedAt: text("reputation_updated_at"),
  status: text("status").notNull(), // "online" | "offline" | "maintenance" | "suspended"
  registeredAt: text("registered_at").notNull(),
  lastHeartbeat: text("last_heartbeat").notNull(),
  version: text("version").notNull(),
  /**
   * Soft expiry. ISO timestamp after which this kernel stops appearing in
   * default catalog listings (the sweeper marks it `status="expired"`).
   * Extended on every heartbeat to `now + 24h` (configurable via
   * KERNEL_TTL_HOURS env). Nullable for backward compat — rows without it
   * are treated as never-expiring until the next heartbeat.
   * See docs/kernel-lifecycle.md.
   */
  validUntil: text("valid_until"),
});

/** A device registered within a kernel */
export const kernelDevices = sqliteTable("kernel_devices", {
  id: text("id").primaryKey(),
  kernelId: text("kernel_id").notNull().references(() => shopKernels.id),
  type: text("type").notNull(), // "machine" | "sensor" | "camera" | "robot" | "tee"
  model: text("model").notNull(),
  firmware: text("firmware").notNull(),
  status: text("status").notNull(), // "idle" | "busy" | "error" | "offline" | "maintenance"
  contributesToCapabilities: text("contributes_to_capabilities", { mode: "json" }).notNull().$type<string[]>(),
  lastUpdated: text("last_updated").notNull(),
  // ── Adapter config ─────────────────────────────────────────────────
  /** Adapter type: one of "octoprint" | "modbus" | "opcua" | "sila" | "generic-http", or null for sensors/cameras */
  adapterType: text("adapter_type"),
  /** JSON string containing adapter-specific config (url, apiKey, host, port, etc.) */
  adapterConfig: text("adapter_config"),
  /** JSON string array of capability IDs this device provides */
  capabilities: text("capabilities", { mode: "json" }).$type<string[]>(),
  // ── Health tracking ────────────────────────────────────────────────
  /** Health status of the device */
  healthStatus: text("health_status").notNull().default("unknown"), // "healthy" | "degraded" | "offline" | "unknown"
  /** Unix timestamp of last health check */
  lastHealthCheck: integer("last_health_check"),
  // ── Evidence Emitter Manifest (supply-side declaration) ─────────────
  /**
   * Which evidence primitives this device can EMIT, in the bounded vocabulary
   * (same grammar as CSD refs + via/demonstrated). A MATCHING artifact — it
   * never mints tier; the oracle verifies instances at settlement (constraint
   * D1). Nullable: legacy rows + undeclared devices have none. The structural
   * type mirrors @pcc/spec's EmitterDecl (kept inline to avoid coupling the
   * store package's schema typecheck to the spec build).
   */
  emits: text("emits", { mode: "json" }).$type<
    Array<{
      id: string;
      params?: Record<string, unknown>;
      bind?: string;
      via?: string;
      demonstrated?: boolean;
    }>
  >(),
});
