/**
 * DisputeResolver — Primitive 6 of RFC-001-work-primitives.
 *
 * Generalized escalation path when a VerificationProgram returns `fail` or
 * hits `onTimeout: arbitrate | escalate-to-human`. Today
 * `MilestoneEscrow.dispute()` exists but the arbiter is hardcoded to the
 * PCC oracle. This primitive lets each Capability designate its own
 * arbiter — single wallet, multisig, DAO vote, external court, or an
 * oracle cascade.
 *
 * Type-only for now; behavior wires in via MilestoneEscrow extension in
 * a subsequent phase.
 */

import { z } from "zod";

const HEX_HASH = /^0x[a-f0-9]{64}$/i;
const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

// ---------------------------------------------------------------------------
// Per-kind config
// ---------------------------------------------------------------------------

const SingleWalletSchema = z.object({
  kind: z.literal("single-wallet"),
  arbiterAddress: z.string().regex(ETH_ADDRESS),
});

const MultisigSchema = z.object({
  kind: z.literal("multisig"),
  arbiterAddresses: z.array(z.string().regex(ETH_ADDRESS)).min(2),
  threshold: z.object({
    m: z.number().int().min(1),
    n: z.number().int().min(1),
  }),
});

const DaoVoteSchema = z.object({
  kind: z.literal("dao-vote"),
  governance: z.object({
    contract: z.string().regex(ETH_ADDRESS),
    /** Minimum proposal-window seconds before a vote can settle. */
    minVoteSeconds: z.number().int().min(0),
  }),
});

const ExternalCourtSchema = z.object({
  kind: z.literal("external-court"),
  externalCourt: z.object({
    /** Jurisdiction code, e.g. "US-FDA-21CFR11", "DE-LG-Berlin". */
    jurisdictionCode: z.string().min(1),
    /** IPFS CID of the contract clause governing the dispute. */
    clauseCid: z.string().min(1),
  }),
});

const OracleCascadeSchema = z.object({
  kind: z.literal("oracle-cascade"),
  cascade: z.object({
    /** Ordered list of fallback oracles. */
    oracles: z.array(z.string().regex(ETH_ADDRESS)).min(1),
    /** Required positive votes per cascade step before falling through. */
    quorumPerStep: z.number().int().min(1),
  }),
});

// ---------------------------------------------------------------------------
// DisputeResolver (whole)
// ---------------------------------------------------------------------------

export const DisputeResolverSchema = z.object({
  /** Unique identifier, e.g. "kleros.court-7", "pcc-default-arbiter". */
  resolverId: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9.\-]*$/, "lowercase, dot/dash-segmented"),
  /** Human-readable summary. */
  description: z.string().max(500),
  /** Max time arbiter has to rule before the next escalation step. */
  rulingWindowSeconds: z.number().int().min(0),
  /** Cost paid by losing party (bps of dispute amount). */
  costBps: z.number().int().min(0).max(10000),
  /** The kind-specific resolution configuration. */
  config: z.discriminatedUnion("kind", [
    SingleWalletSchema,
    MultisigSchema,
    DaoVoteSchema,
    ExternalCourtSchema,
    OracleCascadeSchema,
  ]),
});
export type DisputeResolver = z.infer<typeof DisputeResolverSchema>;

/**
 * The default PCC dispute resolver. Used when a JobSpec doesn't specify
 * one. Single-wallet kind with the PCC oracle as arbiter — same behavior
 * as today's `MilestoneEscrow.dispute()`. New Capabilities can override.
 *
 * The actual address is set per-deployment via env var; this constant is
 * the canonical id.
 */
export const PCC_DEFAULT_RESOLVER_ID = "pcc-default-arbiter" as const;

// Re-export hex-hash regex for downstream (e.g., JobSpec) use.
export { HEX_HASH as DISPUTE_RESOLVER_HEX_HASH };
