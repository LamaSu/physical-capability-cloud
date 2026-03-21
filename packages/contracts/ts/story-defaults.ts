/**
 * story-defaults.ts — Default revenue split configuration for PCC × Story Protocol.
 *
 * Provides:
 *   - RevenueSplitProfile  — interface for a named split configuration
 *   - SPLIT_PROFILES       — 3 pre-built profiles (singleStep, multiStep, community)
 *   - buildSplitsForJob()  — map a profile's roles to concrete wallet addresses
 *   - calculateDistribution() — compute per-address amounts for a given payment
 *
 * Usage:
 *   import { SPLIT_PROFILES, buildSplitsForJob, calculateDistribution } from "@pcc/contracts";
 *
 *   const splits = buildSplitsForJob(SPLIT_PROFILES.singleStep, {
 *     designer:  "0xDesignerWallet",
 *     operator:  "0xOperatorWallet",
 *     verifier:  "0xVerifierWallet",
 *     network:   "0xTreasuryWallet",
 *   });
 *
 *   const distribution = calculateDistribution("1000000", splits);
 *   // → [{ address: "0xDesigner...", amount: "100000" }, ...]
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single revenue split entry within a profile. */
export interface SplitEntry {
  /** Semantic role of the recipient. */
  role: "designer" | "operator" | "verifier" | "network" | "assembler" | "curator";
  /** Percentage of total revenue (1–100). All splits in a profile must sum to 100. */
  percentage: number;
  /** Human-readable label shown in UIs and reports. */
  label: string;
}

/** A named revenue split profile. */
export interface RevenueSplitProfile {
  /** Short identifier name. */
  name: string;
  /** Human-readable description of when to use this profile. */
  description: string;
  /** Ordered list of split entries. Must sum to 100. */
  splits: SplitEntry[];
}

/** A resolved split entry with a concrete wallet address. */
export interface ResolvedSplit {
  address: string;
  role: string;
  percentage: number;
  label: string;
}

/** A distribution entry: how much a specific address receives. */
export interface DistributionEntry {
  address: string;
  amount: string;
}

// ---------------------------------------------------------------------------
// Pre-built split profiles
// ---------------------------------------------------------------------------

/**
 * SPLIT_PROFILES — three canonical revenue split configurations.
 *
 * singleStep:  Standard single-capability job (10/70/10/10)
 * multiStep:   Workflow spanning multiple operators (5/75/10/10)
 * community:   Open-source CSD with community curator (20/60/5/5/10)
 */
export const SPLIT_PROFILES: Record<
  "singleStep" | "multiStep" | "community",
  RevenueSplitProfile
> = {
  /**
   * Single-Step Job
   * Use for: single-capability bookings where one operator runs one machine.
   * Designer earns 10% of every job that uses their CSD — even if they're not present.
   */
  singleStep: {
    name: "Single-Step Job",
    description: "Standard split for single-capability jobs",
    splits: [
      { role: "designer",  percentage: 10, label: "CSD Author" },
      { role: "operator",  percentage: 70, label: "Machine Operator" },
      { role: "verifier",  percentage: 10, label: "Evidence Verifier" },
      { role: "network",   percentage: 10, label: "Protocol Treasury" },
    ],
  },

  /**
   * Multi-Step Workflow
   * Use for: workflows with multiple operators across capability steps.
   * The 75% operator share is divided equally among step operators off-chain.
   */
  multiStep: {
    name: "Multi-Step Workflow",
    description: "Split for workflows with multiple operators",
    splits: [
      { role: "designer",  percentage: 5,  label: "Workflow Designer" },
      { role: "operator",  percentage: 75, label: "Step Operators (divided equally)" },
      { role: "verifier",  percentage: 10, label: "Evidence Verifiers" },
      { role: "network",   percentage: 10, label: "Protocol Treasury" },
    ],
  },

  /**
   * Community Contribution
   * Use for: open-source CSDs with high community usage and a curator role.
   * Higher designer share (20%) rewards widely-forked community work.
   */
  community: {
    name: "Community Contribution",
    description: "For open-source CSDs with high community usage",
    splits: [
      { role: "designer",  percentage: 20, label: "CSD Author" },
      { role: "operator",  percentage: 60, label: "Machine Operator" },
      { role: "curator",   percentage:  5, label: "Community Curator" },
      { role: "verifier",  percentage:  5, label: "Evidence Verifier" },
      { role: "network",   percentage: 10, label: "Protocol Treasury" },
    ],
  },
};

// ---------------------------------------------------------------------------
// buildSplitsForJob
// ---------------------------------------------------------------------------

/**
 * Apply a split profile to a concrete set of wallet addresses.
 *
 * Maps each role in the profile to the corresponding address in `addresses`.
 * Roles with no matching address are omitted from the output — the caller is
 * responsible for ensuring all required roles are supplied.
 *
 * @param profile   - A RevenueSplitProfile (use SPLIT_PROFILES or a custom one)
 * @param addresses - Map of role → wallet address (e.g. { designer: "0x...", operator: "0x..." })
 * @returns Array of resolved splits, one per matched role, in profile order.
 *
 * @example
 *   const splits = buildSplitsForJob(SPLIT_PROFILES.singleStep, {
 *     designer: "0xAlice",
 *     operator: "0xBob",
 *     verifier: "0xCarol",
 *     network:  "0xTreasury",
 *   });
 *   // → 4 entries, percentages 10/70/10/10
 */
export function buildSplitsForJob(
  profile: RevenueSplitProfile,
  addresses: Record<string, string>,
): ResolvedSplit[] {
  const result: ResolvedSplit[] = [];

  for (const entry of profile.splits) {
    const address = addresses[entry.role];
    if (address != null && address !== "") {
      result.push({
        address,
        role: entry.role,
        percentage: entry.percentage,
        label: entry.label,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// calculateDistribution
// ---------------------------------------------------------------------------

/**
 * Calculate per-address amounts for a given payment total.
 *
 * Amounts are computed using integer arithmetic (BigInt) to avoid floating-
 * point rounding errors. All values are treated as the smallest indivisible
 * unit of the currency (e.g. wei, micro-USDC).
 *
 * Note: If percentages don't sum to exactly 100, rounding losses are absorbed
 * proportionally. The function does not throw — it returns whatever each
 * address is owed based on their percentage.
 *
 * @param amount  - Total payment amount as a decimal string (e.g. "1000000")
 * @param splits  - Array of { address, percentage } entries
 * @returns Array of { address, amount } where amount is a decimal string
 *
 * @example
 *   calculateDistribution("1000", [
 *     { address: "0xAlice", percentage: 10 },
 *     { address: "0xBob",   percentage: 90 },
 *   ]);
 *   // → [{ address: "0xAlice", amount: "100" }, { address: "0xBob", amount: "900" }]
 */
export function calculateDistribution(
  amount: string,
  splits: Array<{ address: string; percentage: number }>,
): DistributionEntry[] {
  if (!splits || splits.length === 0) {
    return [];
  }

  // Parse as BigInt so we avoid floating-point errors
  let total: bigint;
  try {
    total = BigInt(amount);
  } catch {
    // Non-numeric amount — return zeros for all
    return splits.map((s) => ({ address: s.address, amount: "0" }));
  }

  if (total === 0n) {
    return splits.map((s) => ({ address: s.address, amount: "0" }));
  }

  return splits.map((s) => {
    const percentage = Math.max(0, Math.min(100, s.percentage));
    const share = (total * BigInt(percentage)) / 100n;
    return {
      address: s.address,
      amount: share.toString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Validation helper (useful for tests and gateway validation)
// ---------------------------------------------------------------------------

/**
 * Validate that a profile's splits sum to exactly 100.
 * Returns the sum so the caller can include it in error messages.
 */
export function validateSplitTotal(profile: RevenueSplitProfile): {
  valid: boolean;
  total: number;
} {
  const total = profile.splits.reduce((acc, s) => acc + s.percentage, 0);
  return { valid: total === 100, total };
}
