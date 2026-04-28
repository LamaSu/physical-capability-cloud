# ADR: LicensingEngine Extension for Contributor Economics

**Status**: Proposed
**Author**: arch-integration-alpha
**Date**: 2026-04-22
**Branch**: feat/contributor-economics

---

## Section 1: Where New Primitives Plug Into Existing Architecture

Each new primitive is additive. Nothing in existing code is removed; where a flat value is
currently stored, the new system adds a schedule lookup that falls back to the flat value when
no schedule is registered, preserving zero-diff backward compatibility.

| New primitive | Extends / sits beside | Decision |
|---|---|---|
| **ContributorNFT** | `StoryIPRegistration` | **Bridge layer, not replacement.** `StoryIPRegistration` stays as-is. `ContributorNFT` is a separate ERC-721 contract that points to an ipId. A contributor can own a ContributorNFT (minted once per "contribution authorship") that is distinct from the capability IP asset. The ipId stored in StoryIPRegistration becomes a reference key. This allows a contributor to hold a portable identity NFT across multiple capabilities they authored. |
| **RateSchedule** | `LicensingTerms.defaultRevShare` + `derivativeDecayRate` | **Replaces with a schedule, keeps flat as constant-template fallback.** `defaultRevShare` is reinterpreted as the initial bps of a `constant` RateSchedule. `derivativeDecayRate` becomes a decay-template parameter. Existing LicensingTerms objects read unchanged; a new `rateSchedules` Map in LicensingEngine maps ipId → RateSchedule, consulted first. |
| **DatasetNFT** | `StoryIPRegistration` (subtype) | **Sibling subtype.** A `DatasetIPRegistration` extends `StoryIPRegistration` with dataset metadata fields (`datasetHash`, `leRobotRef`, `license`, `dataType`). Same ipId/nftTokenId pattern. Registered independently via `POST /api/ip/register-dataset`. |
| **ModelNFT** | `StoryIPRegistration` (subtype) | **Sibling subtype.** A `ModelIPRegistration` extends `StoryIPRegistration` with model metadata (`modelHash`, `architecture`, `parameterCount`, `trainingManifestId`). Registered via `POST /api/ip/register-model`. |
| **TrainingManifest** | `StoryDerivativeLink` (batch analog) | **Parallel type, not a DerivativeLink.** `StoryDerivativeLink` is 1:1 (one parent → one child job). `TrainingManifest` is N:1 (N dataset IPs → one model IP) with weights. Stored in a new `training_manifests` table. The model IP is registered as a *derivative* of each dataset IP via individual `StoryDerivativeLink` entries, but the weight-mapping lives separately. |
| **CompositionManifest** | `LicenseGrant` + `getRoyaltyDistribution` traversal | **Extension of the traversal.** `LicenseGrant` tracks capability derivative chains. `CompositionManifest` adds a second traversal dimension: capability → model IP → dataset IPs. The new `getRoyaltyDistributionRich()` method calls existing `getRoyaltyDistribution()` for the capability chain, then appends dataset-contributor rows by walking the TrainingManifest. |
| **splitPayout** | `MilestoneEscrow.release()` internals | **Option B (off-chain compute + on-chain verification/execution).** See Section 6. The payout map is computed off-chain by LicensingEngine, submitted as a signed struct, and the contract verifies + executes N transfers. `release()` without a signed payout map falls back to existing single-operator behavior. |

**Key design invariant**: every new type lives in its own table/map and is consulted additively.
No existing row is deleted or schema-altered in a breaking way.

---

## Section 2: Role Taxonomy

### Existing roles (StoryRoyaltySplit.role)

| Existing value | Decision | New value | Rationale |
|---|---|---|---|
| `designer` | **Rename to `protocol-author`** | `protocol-author` | "Designer" implied visual/industrial design. The role is really "schema/test-vector/CSD innovator." Rename is semantically accurate. |
| `operator` | **Keep** | `operator` | Unchanged. Machine operator who runs the physical job. |
| `verifier` | **Keep** | `verifier` | Unchanged. Verifier node that attests evidence. |
| `assembler` | **Rename to `integrator`** | `integrator` | "Assembler" implied a factory role. "Integrator" correctly denotes the adapter author who wired the machine type into PCC's interface. |
| `curator` | **Rename to `insurer`** | `insurer` | "Curator" was vague. The actual role this slot funds is risk-underwriting for the job. |

### New roles

| New role | Semantics |
|---|---|
| `model-author` | Author of a ModelNFT used in job execution. Receives a share computed from the model's RateSchedule. |
| `dataset-contributor` | Author of a DatasetNFT included in a model's TrainingManifest. Receives a share proportional to training-mix weight × dataset's RateSchedule. |
| `pilot` | Alias for `dataset-contributor` when the data originated from a human operator's physical task demonstration (teleoperation data). Identical payout mechanics; separate role string for analytics / UI display. |
| `network-treasury` | Optional. Per-network sovereign treasury address. 0 bps is valid. No minimum enforced by protocol. |

### On OEM / hardware-manufacturer royalty: explicit absence

There is no `oem`, `hardware-manufacturer`, `vendor`, or equivalent role in this taxonomy.
This is a load-bearing protocol decision, not an oversight:

- OEM royalty is a rent class with no corresponding protocol contribution. OEMs who write
  adapters earn as `integrator`. OEMs who author training data earn as `dataset-contributor`.
  OEMs who run kernels earn as `operator`. No category exists for earning by virtue of having
  manufactured a machine.
- The Claros Layer 4 notes in prior ADR drafts that referenced "OEM 1-5% lifetime royalty"
  are hereby deprecated. No code in the current codebase implements this; the deprecation is
  documentation-only.

### Migration safety

Old role string values decode forward:

```
designer       → treated as protocol-author at read time (DB view or query alias)
assembler      → treated as integrator at read time
curator        → treated as insurer at read time
```

A migration script (Section 8) updates stored values. Until migration runs, the gateway
reads old values via a translation function before presenting them to clients.

### Full ContributorRole enum

```typescript
export const ContributorRole = z.enum([
  "protocol-author",     // was "designer"
  "operator",
  "verifier",
  "integrator",          // was "assembler"
  "insurer",             // was "curator"
  "model-author",
  "dataset-contributor",
  "pilot",               // subtype of dataset-contributor; human tele-op data
  "network-treasury",
]);
export type ContributorRole = z.infer<typeof ContributorRole>;
```

---

## Section 3: Data Flow at Settlement Time — $100 Job Example

Amounts are illustrative. All bps are checked to sum ≤ 10000 at CompositionManifest creation.

**Setup**
- Job revenue: 100 USDC (= 100_000_000 in 6-decimal representation)
- Capability IP: `cap-ip-001` (FDM 3D printing CSD, authored by Alice)
  - Alice's RateSchedule: `constant, 300 bps` (3%)
  - No derivative chain (root IP)
- Model IP: `model-ip-007` (FDM path-planning model, authored by Bob)
  - Bob's RateSchedule: `step, 500 bps for month 0-6, then 200 bps`
  - Current bps at settlement time (month 2): 500 bps (5%)
- TrainingManifest for model-ip-007:
  - DatasetNFT `ds-001` (Carol, 60% training weight, 100 bps constant)
  - DatasetNFT `ds-002` (Dave, 40% training weight, 50 bps constant)
- Integrator: Eve (adapter author), ContributorProfile for `cap-ip-001`, 150 bps (1.5%)
- Verifier: Frank, 100 bps (1%)
- Network treasury: 0 bps (sovereign network opted out)
- Protocol fee (existing MilestoneEscrow/PCCProtocol): 150 bps (1.5%) → goes to `feeRecipient`
- Operator (residual): everything remaining

**Algorithm**

```
Step 1: MilestoneEscrow.release(milestoneIndex) called after challenge window
        → challenge window passed, m.status = Attested, block.timestamp >= challengeWindowEnd

Step 2: Resolve capability ipId from the job record
        → capabilityId lookup → StoryIPRegistration.ipId = "cap-ip-001"

Step 3: Fetch CompositionManifest for this milestone
        → manifest.entries = [
             { ipId: "cap-ip-001", role: "protocol-author", contributorProfile: Alice },
             { ipId: "cap-ip-001", role: "integrator",      contributorProfile: Eve },
             { ipId: "cap-ip-001", role: "verifier",        contributorProfile: Frank },
             { ipId: "model-ip-007", role: "model-author",  contributorProfile: Bob },
             // dataset entries resolved dynamically from TrainingManifest
           ]

Step 4: evaluateRateSchedule per manifest entry at this moment
        Protocol fee (existing): 150 bps = $1.50  → feeRecipient
        Alice (protocol-author): 300 bps = $3.00
        Eve   (integrator):      150 bps = $1.50
        Frank (verifier):        100 bps = $1.00
        Bob   (model-author):    500 bps = $5.00  [model schedule at month 2]

Step 5: Walk TrainingManifest for model-ip-007
        Total allocated to model-layer: Bob's 500 bps is the MODEL author share.
        Dataset contributors get a SEPARATE allocation from the total:
          ds-001 (Carol): evaluateRateSchedule("ds-001") = 100 bps × 60% weight = 60 bps = $0.60
          ds-002 (Dave):  evaluateRateSchedule("ds-002") = 50 bps  × 40% weight = 20 bps = $0.20

Step 6: Compute residual for operator
        Total allocated bps: 150 + 300 + 150 + 100 + 500 + 60 + 20 = 1280 bps = $12.80
        Operator residual: 10000 - 1280 = 8720 bps = $87.20

Step 7: Build payout map { address → amount }
        feeRecipient  → $1.50
        Alice         → $3.00
        Eve           → $1.50
        Frank         → $1.00
        Bob           → $5.00
        Carol         → $0.60
        Dave          → $0.20
        Operator      → $87.20
        Total         = $100.00 ✓

Step 8: Execute via splitPayout()
        Off-chain: LicensingEngine.getRoyaltyDistributionRich() builds payout map
        Off-chain: gateway signs {milestoneIndex, cwmId, recipients[], amounts[], nonce} via ECDSA
        On-chain:  MilestoneEscrow.releaseSplit(milestoneIndex, signed_payout) verifies + transfers
```

**Edge case handling**

- **No contributors registered**: `releaseSplit()` without a signed payout → falls back to
  `release()` (single operator transfer, existing behavior). Zero-diff for unconfigured capabilities.

- **Circular references in derivative graph**: LicensingEngine tracks visited ipIds in a Set
  during `getRoyaltyDistributionRich()`. If an ipId is encountered a second time, it is skipped
  with a log warning. Maximum traversal depth capped at 10 hops. Graph cycles cannot form via
  legitimate registration (a parent must exist before a child is registered), but malformed
  off-chain manifests are defended against.

- **Rate sum > 10000 bps at composition time**: `CompositionManifest` creation is rejected with
  error `RATE_SUM_EXCEEDS_10000`. Validation runs the full `evaluateRateSchedule()` call for
  every entry at creation time using the current moment as the evaluation context. Manifests are
  re-validated at settlement time; if a schedule has changed (only decreases allowed), the sum
  is re-checked and any freed bps flow to the operator residual.

- **Multi-token escrows**: `MilestoneEscrow.tokenForMilestone(milestoneIndex)` already returns
  the token address per milestone. `releaseSplit()` uses this selector: all amounts in the payout
  map are denominated in that token. The off-chain engine works in token-agnostic bigint arithmetic;
  the Solidity side uses whichever IERC20 `tokenForMilestone()` returns.

---

## Section 4: Proposed Extensions to @pcc/spec

These are additive type definitions. No existing exported type is modified.

```typescript
// packages/spec/src/types/contributor.ts

import { z } from "zod";

// ── ContributorRole ───────────────────────────────────────────────────────────

export const ContributorRoleSchema = z.enum([
  "protocol-author",    // CSD schema / test-vector innovator (was "designer")
  "operator",           // Machine operator running the physical job
  "verifier",           // Attestation node
  "integrator",         // Adapter/connector author (was "assembler")
  "insurer",            // Risk underwriter (was "curator")
  "model-author",       // ModelNFT author
  "dataset-contributor",// DatasetNFT author
  "pilot",              // Human teleoperation data contributor
  "network-treasury",   // Optional network treasury
]);
export type ContributorRole = z.infer<typeof ContributorRoleSchema>;

// ── RateSchedule ─────────────────────────────────────────────────────────────

export const RateScheduleTemplateSchema = z.enum([
  "constant",           // Fixed bps forever
  "step",               // Step function: [ {untilTimestamp, bps}, ... ], last entry is forever
  "time-decay",         // bps(t) = initialBps × decayFactor^(months_since_mint)
  "adoption-indexed",   // bps(jobs_per_day) = clamp(floor(k / sqrt(jobs_per_day)), min, max)
  "piecewise-value",    // 0 bps below valueThreshold, rateBps above (job value conditional)
  "composite",          // max or min of two sub-schedules
]);
export type RateScheduleTemplate = z.infer<typeof RateScheduleTemplateSchema>;

export const RateScheduleParamsSchema = z.discriminatedUnion("template", [
  z.object({
    template: z.literal("constant"),
    bps: z.number().int().min(0).max(10000),
  }),
  z.object({
    template: z.literal("step"),
    // Sorted ascending by untilTimestamp. Last entry's untilTimestamp = null means "forever".
    steps: z.array(z.object({
      untilTimestamp: z.string().nullable(), // ISO 8601 or null
      bps: z.number().int().min(0).max(10000),
    })).min(1),
  }),
  z.object({
    template: z.literal("time-decay"),
    initialBps: z.number().int().min(0).max(10000),
    /** Rate at which bps decay per month (e.g., 0.9 = 10% decay/month) */
    monthlyDecayFactor: z.number().min(0).max(1),
    /** Minimum bps floor (schedule never goes below this) */
    floorBps: z.number().int().min(0).max(10000),
    /** ISO 8601 timestamp: when the schedule starts (usually mint time) */
    startTimestamp: z.string(),
  }),
  z.object({
    template: z.literal("adoption-indexed"),
    /** k in bps(j) = k / sqrt(j), j = jobs_per_day */
    k: z.number().int().min(0),
    minBps: z.number().int().min(0).max(10000),
    maxBps: z.number().int().min(0).max(10000),
  }),
  z.object({
    template: z.literal("piecewise-value"),
    /** Job value threshold in token-units (bigint as string) */
    valueThresholdTokenUnits: z.string(),
    belowBps: z.number().int().min(0).max(10000),
    aboveBps: z.number().int().min(0).max(10000),
  }),
  z.object({
    template: z.literal("composite"),
    operator: z.enum(["max", "min"]),
    left: z.lazy(() => RateScheduleParamsSchema),
    right: z.lazy(() => RateScheduleParamsSchema),
  }),
]);
export type RateScheduleParams = z.infer<typeof RateScheduleParamsSchema>;

export const RateScheduleSchema = z.object({
  id: z.string().uuid(),
  /** IP Asset this schedule belongs to */
  ipId: z.string().min(1),
  params: RateScheduleParamsSchema,
  /** Committed at creation. Can be superseded by a new schedule with lower ceiling only. */
  ceilingBps: z.number().int().min(0).max(10000),
  /** Whether this schedule has been committed (immutable once true) */
  committed: z.boolean().default(false),
  createdAt: z.string(),
});
export type RateSchedule = z.infer<typeof RateScheduleSchema>;

// ── ContributorProfile ────────────────────────────────────────────────────────

export const ContributorProfileSchema = z.object({
  ipId: z.string().min(1),
  role: ContributorRoleSchema,
  /** Preferred payout wallet address */
  payoutAddress: z.string().min(1),
  /** Public RateSchedule id for this role at this IP */
  rateScheduleId: z.string().uuid(),
  /** Optional ContributorNFT token address */
  contributorNftAddress: z.string().optional(),
  /** Optional ContributorNFT token ID */
  contributorNftTokenId: z.string().optional(),
  createdAt: z.string(),
});
export type ContributorProfile = z.infer<typeof ContributorProfileSchema>;

// ── TrainingManifest ──────────────────────────────────────────────────────────

export const DatasetWeightSchema = z.object({
  datasetIpId: z.string().min(1),
  /** Weight in basis points (all weights must sum to 10000) */
  weightBps: z.number().int().min(1).max(10000),
});
export type DatasetWeight = z.infer<typeof DatasetWeightSchema>;

export const TrainingManifestSchema = z.object({
  id: z.string().uuid(),
  /** Model IP Asset this manifest belongs to */
  modelIpId: z.string().min(1),
  /** Base model this was fine-tuned from (if any) */
  baseModelIpId: z.string().optional(),
  /** Dataset weights — must sum to 10000 bps */
  datasetWeights: z.array(DatasetWeightSchema).min(1),
  /** Optional: IPFS CID of the full training run metadata */
  trainingRunCid: z.string().optional(),
  /** Optional: attestation hash proving training used these datasets (zkML or TEE) */
  trainingAttestationHash: z.string().optional(),
  createdAt: z.string(),
}).refine(
  (m) => m.datasetWeights.reduce((s, d) => s + d.weightBps, 0) === 10000,
  { message: "datasetWeights must sum to 10000 bps" },
);
export type TrainingManifest = z.infer<typeof TrainingManifestSchema>;

// ── CompositionManifest ───────────────────────────────────────────────────────

export const CompositionEntrySchema = z.object({
  ipId: z.string().min(1),
  role: ContributorRoleSchema,
  contributorProfile: ContributorProfileSchema,
});
export type CompositionEntry = z.infer<typeof CompositionEntrySchema>;

export const CompositionManifestSchema = z.object({
  id: z.string().uuid(),
  /** CWM / job milestone this manifest applies to */
  milestoneId: z.string().min(1),
  /** Ordered list of contributor entries — protocol-fee comes from PCCProtocol, not here */
  entries: z.array(CompositionEntrySchema),
  /** Cached total allocated bps at manifest creation time (must be <= 10000) */
  totalAllocatedBps: z.number().int().min(0).max(10000),
  createdAt: z.string(),
});
export type CompositionManifest = z.infer<typeof CompositionManifestSchema>;

// ── SplitPayoutResult ─────────────────────────────────────────────────────────

export const PayoutLineSchema = z.object({
  recipientAddress: z.string().min(1),
  ipId: z.string().optional(),
  role: ContributorRoleSchema.optional(),
  bpsApplied: z.number().int().min(0).max(10000),
  /** Amount in token-units (bigint as string) */
  amount: z.string(),
});
export type PayoutLine = z.infer<typeof PayoutLineSchema>;

export const SplitPayoutResultSchema = z.object({
  milestoneId: z.string().min(1),
  totalRevenue: z.string(),
  tokenAddress: z.string(),
  lines: z.array(PayoutLineSchema),
  operatorResidualBps: z.number().int().min(0).max(10000),
  /** ISO 8601 timestamp of evaluation */
  evaluatedAt: z.string(),
});
export type SplitPayoutResult = z.infer<typeof SplitPayoutResultSchema>;
```

---

## Section 5: Proposed Extensions to LicensingEngine

These method signatures integrate cleanly with the existing class. Existing methods are unchanged.

```typescript
// packages/contracts/ts/licensing-engine.ts — additions only

/** Context passed to rate-aware methods */
export interface EvaluationContext {
  /** Unix timestamp of evaluation (ms) — defaults to Date.now() */
  now?: number;
  /** Job value in token-units (for piecewise-value schedules) */
  jobValueTokenUnits?: bigint;
  /** Rolling 24-hour job count across the network (for adoption-indexed schedules) */
  jobsPerDay?: number;
}

export class LicensingEngine {
  // ── (all existing methods unchanged) ─────────────────────────────────

  // ── New: RateSchedule registry ───────────────────────────────────────

  /**
   * Commit an immutable rate schedule for an IP Asset.
   * Once committed = true, the schedule cannot be replaced with one
   * whose ceilingBps is higher. Only a lower-ceiling replacement is accepted.
   */
  setRateSchedule(ipId: string, schedule: RateSchedule): void;

  /**
   * Evaluate the current effective bps for an IP Asset's rate schedule
   * given an evaluation context. Returns the flat defaultRevShare * 100 as
   * bps if no schedule is registered (backward compatibility).
   */
  evaluateRateSchedule(ipId: string, context: EvaluationContext): number; // bps

  // ── New: Training manifest registry ──────────────────────────────────

  /**
   * Link a model IP to its training manifest (N dataset IPs with weights).
   * Validates that datasetWeights sum to 10000.
   */
  linkModel(modelIpId: string, manifest: TrainingManifest): void;

  getTrainingManifest(modelIpId: string): TrainingManifest | undefined;

  // ── New: Composition manifest registry ───────────────────────────────

  /**
   * Store a composition manifest for a milestone.
   * Validates that sum of evaluateRateSchedule() across all entries <= 10000 bps.
   * Throws RATE_SUM_EXCEEDS_10000 if validation fails.
   */
  setCompositionManifest(milestoneId: string, manifest: CompositionManifest): void;

  getCompositionManifest(milestoneId: string): CompositionManifest | undefined;

  // ── New: Rich royalty distribution ───────────────────────────────────

  /**
   * Walk both the existing derivative tree AND the training manifest DAG.
   *
   * Algorithm:
   *   1. Walk CompositionManifest entries → evaluate each RateSchedule
   *   2. For each entry with role="model-author", also walk its TrainingManifest
   *      → for each dataset: bps = evaluateRateSchedule(datasetIpId) × (weightBps / 10000)
   *   3. Return all RoyaltyDistribution rows with role populated
   *   4. Compute operator residual as 10000 - sum(all bps)
   *
   * Falls back to getRoyaltyDistribution() (existing) when no CompositionManifest
   * is registered for this milestone.
   */
  getRoyaltyDistributionRich(
    childIpId: string,
    milestoneId: string,
    jobRevenue: bigint,
    context: EvaluationContext,
  ): RoyaltyDistribution[];  // existing type, augmented with optional role field

  // ── Existing methods unchanged ────────────────────────────────────────
  // setTerms(), getTerms(), evaluateLicense(), grantLicense(),
  // calculateEffectiveRevShare(), getRoyaltyDistribution(),
  // getGrant(), getChildren() — all untouched.
}
```

**Migration for existing call sites**

- `engine.getRoyaltyDistribution(childIpId, jobRevenue)` — unchanged, still works. Routes to
  the legacy ancestor-chain traversal only.
- `engine.getRoyaltyDistributionRich(childIpId, milestoneId, jobRevenue, context)` — new
  entrypoint for capabilities that have a CompositionManifest. If none, delegates to the
  existing method.
- `POST /api/ip/settle-royalties` — currently calls `getRoyaltyDistribution`. After Wave 3,
  it will prefer `getRoyaltyDistributionRich` when a milestoneId is provided, falling back
  to the legacy path.

---

## Section 6: MilestoneEscrow splitPayout Wiring

### Decision: Option B — Off-chain compute, on-chain signed execution

**Rejected: Option A (fully on-chain)** — requires the contract to call an external
CompositionManifest registry and RateSchedule evaluator. This adds cross-contract call risk,
oracle dependency at settlement time, and makes the gas cost of `release()` unbounded (depends
on DAG size). Gas estimate for a 7-recipient payout with on-chain traversal: 350-600k gas on
Base, unacceptable.

**Rejected: Option C (payout map stored at funding)** — rate schedules are time-varying.
Storing the map at funding time (before the job runs) would use the wrong bps if the schedule
steps over the job duration. Settlement-time evaluation is required.

**Accepted: Option B** — LicensingEngine computes the payout map off-chain, the gateway signs
it with a trusted key (GATEWAY_SIGNER_KEY), and `releaseSplit()` verifies the signature +
executes N transfers. Gas estimate for a 7-recipient signed payout: ~120-180k gas on Base.

### Solidity interface additions

```solidity
// In MilestoneEscrow.sol — additions only

// ── Storage additions ──────────────────────────────────────────────────

/// @notice Address authorized to sign payout maps (set at construction or by payer).
address public payoutSigner;

/// @notice Nonces per milestone to prevent payout replay.
mapping(uint256 => uint256) public payoutNonces;

// ── Events ────────────────────────────────────────────────────────────

event MilestoneReleasedSplit(
    uint256 indexed milestoneIndex,
    uint256 recipientCount,
    uint256 totalAmount
);

// ── Functions ────────────────────────────────────────────────────────

/**
 * @notice Release milestone funds to multiple recipients via a gateway-signed payout map.
 *
 * The gateway (off-chain LicensingEngine) computes the payout map and signs:
 *   keccak256(abi.encode(address(this), milestoneIndex, nonce, recipients, amounts))
 *
 * Backward compatibility: if no payoutSigner is set (address(0)), this function
 * reverts with "no payout signer; use release()". The existing release() function
 * remains unchanged for unconfigured milestones.
 *
 * @param milestoneIndex  Which milestone to release
 * @param recipients      Payout recipient addresses (index-aligned with amounts)
 * @param amounts         Token amounts per recipient (sum must equal milestone.amount)
 * @param signature       ECDSA signature over the payout map hash
 */
function releaseSplit(
    uint256 milestoneIndex,
    address[] calldata recipients,
    uint256[] calldata amounts,
    bytes calldata signature
) external nonReentrant milestoneExists(milestoneIndex);

/**
 * @notice Set the authorized payout signer. Only callable by payer.
 * @param signer  Address of the off-chain gateway signer. address(0) disables split payouts.
 */
function setPayoutSigner(address signer) external onlyPayer;

/**
 * @notice Existing release() is unchanged. Falls back to single-operator payout.
 *         Still works for milestones without a registered CompositionManifest.
 */
// function release(uint256 milestoneIndex) — unchanged
```

**Gas estimates (Base Sepolia, 1 gwei)**
- `release()` unchanged: ~50-70k gas
- `releaseSplit()` with 3 recipients: ~90k gas
- `releaseSplit()` with 8 recipients: ~160k gas
- ECDSA verify cost: ~3k gas (fixed overhead)
- Each additional ERC-20 transfer: ~20-25k gas

**tokenForMilestone() compatibility**: `releaseSplit()` uses the same token-per-milestone
selector as the existing codebase. The amounts array is denominated in that token. If a
milestone was funded in USDC, all payout amounts are USDC. No cross-token logic added.

**Backward compatibility guarantee**: `release()` (without signature) is untouched and
continues to work exactly as before. Operators who do not configure a payoutSigner receive
the full milestone.amount − protocolFee as before.

---

## Section 7: Database Schema Extensions

New tables to add in `packages/db/src/schema/story.ts`:

```typescript
// packages/db/src/schema/story.ts — additions

/** Rate schedules committed by contributors for their IP Assets. */
export const rateSchedules = sqliteTable("rate_schedules", {
  id: text("id").primaryKey(),
  ipId: text("ip_id").notNull(),
  /** JSON-encoded RateScheduleParams */
  params: text("params").notNull(),
  ceilingBps: integer("ceiling_bps").notNull(),
  committed: integer("committed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});

/** Contributor profiles linking roles to IP Assets. */
export const contributorProfiles = sqliteTable("contributor_profiles", {
  id: text("id").primaryKey(),
  ipId: text("ip_id").notNull(),
  role: text("role").notNull(),
  payoutAddress: text("payout_address").notNull(),
  rateScheduleId: text("rate_schedule_id").notNull(),
  contributorNftAddress: text("contributor_nft_address"),
  contributorNftTokenId: text("contributor_nft_token_id"),
  createdAt: text("created_at").notNull(),
});

/** Training manifests linking model IPs to dataset IPs with weights. */
export const trainingManifests = sqliteTable("training_manifests", {
  id: text("id").primaryKey(),
  modelIpId: text("model_ip_id").notNull(),
  baseModelIpId: text("base_model_ip_id"),
  /** JSON array of {datasetIpId, weightBps} — weights must sum to 10000 */
  datasetWeights: text("dataset_weights").notNull(),
  trainingRunCid: text("training_run_cid"),
  trainingAttestationHash: text("training_attestation_hash"),
  createdAt: text("created_at").notNull(),
});

/** Composition manifests — cached payout routing per milestone. */
export const compositionManifests = sqliteTable("composition_manifests", {
  id: text("id").primaryKey(),
  milestoneId: text("milestone_id").notNull(),
  /** JSON array of CompositionEntry */
  entries: text("entries").notNull(),
  totalAllocatedBps: integer("total_allocated_bps").notNull(),
  createdAt: text("created_at").notNull(),
});

/** Payout execution log — one row per releaseSplit() call. */
export const splitPayoutLogs = sqliteTable("split_payout_logs", {
  id: text("id").primaryKey(),
  milestoneId: text("milestone_id").notNull(),
  txHash: text("tx_hash").notNull(),
  totalRevenue: text("total_revenue").notNull(),
  tokenAddress: text("token_address").notNull(),
  /** JSON array of PayoutLine */
  lines: text("lines").notNull(),
  executedAt: text("executed_at").notNull(),
});
```

**Migration plan for existing data**

Existing tables (`story_ip_registrations`, `story_derivative_links`, `story_royalty_splits`,
`story_revenue_claims`) require no structural change. New tables are purely additive.

The `storyRoyaltySplits.role` column currently stores raw string values. A migration updates
old values to new canonical strings (see Section 8).

---

## Section 8: Migration Story

### Role string renaming

```typescript
// packages/db/src/migrate.ts — migration entry

export const migration_004_rename_contributor_roles = `
  UPDATE story_royalty_splits
  SET role = CASE role
    WHEN 'designer'  THEN 'protocol-author'
    WHEN 'assembler' THEN 'integrator'
    WHEN 'curator'   THEN 'insurer'
    ELSE role
  END
  WHERE role IN ('designer', 'assembler', 'curator');
`;
```

Until migration runs, the gateway's `getContributorRole()` helper translates:
```typescript
const ROLE_ALIASES: Record<string, ContributorRole> = {
  designer:  "protocol-author",
  assembler: "integrator",
  curator:   "insurer",
};
function normalizeRole(raw: string): ContributorRole {
  return (ROLE_ALIASES[raw] ?? raw) as ContributorRole;
}
```

### Existing LicensingTerms flat rev-share → constant RateSchedule

No migration needed at the data layer. When `evaluateRateSchedule(ipId)` is called and no
schedule exists in the `rateSchedules` map, it falls back to:

```typescript
const terms = this.getTerms(ipId);
if (!terms) return 0; // no terms = open use
const bps = Math.round(terms.defaultRevShare * 100); // convert percent to bps
return Math.min(bps, 10000);
```

This is the backward-compatible constant schedule for every existing IP asset.

### Claros Layer 4 OEM royalty deprecation

Any document (whitepaper, PROPOSAL.md, Layer 4 spec) referencing "OEM 1-5% lifetime royalty"
or similar is deprecated by this ADR. The deprecation note for each such document:

> **DEPRECATED (ADR-010, 2026-04-22)**: OEM royalty as a distinct class is removed from the
> protocol. Hardware manufacturers earn through the standard contributor roles (integrator,
> operator, dataset-contributor) based on actual protocol contributions, not by virtue of
> hardware ownership. See ADR-010 Section 2.

No code changes needed. The PCC codebase has no OEM role in its current implementation.

---

## Section 9: Open Questions

These depend on scout outputs and are explicitly deferred. Wave 3 implementers must resolve
each before building the corresponding component.

| Question | Depends on | Impact |
|---|---|---|
| **Which curve DSL for on-chain storage?** `scout-schedules-bravo` found Sablier LockupTranched as the step-function reference. Decision: store as packed struct array in the `ContributorNFT` contract (sections array), evaluated with a binary search. Still open: should composite schedules be stored inline (recursive JSON in storage) or linked (two IDs)? | scout-schedules-bravo (partially landed — sec 1-2 complete, sec 3-15 pending) | Affects `RateSchedule` Solidity storage encoding |
| **Which cross-chain NFT standard for ContributorNFT?** Base Sepolia for payments; Story Protocol for IP graph. Does ContributorNFT mint on Story as an IPAsset, or on Base as a standalone ERC-721 that references a Story ipId? | scout-networks-delta (not yet started) | Affects ContributorNFT contract deployment chain |
| **zkML verification or trust-only for TrainingManifest?** `scout-provenance-charlie` found Ocean C2D (TEE-attested training) as an option. zkML (EIP-7007) is an alternative. Cost/latency tradeoff not yet evaluated. | scout-provenance-charlie (sections 1-3a complete, 3b-10 pending) | Affects `trainingAttestationHash` semantics and whether on-chain verification is feasible |
| **Adoption counter data source for adoption-indexed schedules?** If `jobsPerDay` comes from a Chainlink oracle, it's trustworthy but adds latency and cost. If it comes from the gateway (off-chain), it's cheap but trust-relies on the gateway signer. | cross-cutting (no scout assigned) | Affects adoption-indexed schedule evaluation in `releaseSplit()` |

---

## Section 10: Wave 3 Implementation — Ordered File Plan

Wave 3 implementers receive this ADR as the source-of-truth contract. Build in this order:

**Step 1 — @pcc/spec types (no breaking changes)**
- `packages/spec/src/types/contributor.ts` — new file, all types from Section 4
- `packages/spec/src/index.ts` — export `ContributorRole`, `RateSchedule`, `RateScheduleParams`,
  `ContributorProfile`, `TrainingManifest`, `CompositionManifest`, `SplitPayoutResult`

**Step 2 — DB schema**
- `packages/db/src/schema/story.ts` — add 5 new tables from Section 7
- `packages/db/src/migrate.ts` — add `migration_004_rename_contributor_roles` + 5 CREATE TABLE
  migrations for new tables

**Step 3 — LicensingEngine extensions**
- `packages/contracts/ts/licensing-engine.ts` — add:
  - `private readonly rateSchedules = new Map<string, RateSchedule>()`
  - `private readonly trainingManifests = new Map<string, TrainingManifest>()`
  - `private readonly compositionManifests = new Map<string, CompositionManifest>()`
  - Implement `setRateSchedule()`, `evaluateRateSchedule()` with all 6 template types
  - Implement `linkModel()`, `getTrainingManifest()`
  - Implement `setCompositionManifest()`, `getCompositionManifest()`
  - Implement `getRoyaltyDistributionRich()` — delegate to `getRoyaltyDistribution()` as fallback

**Step 4 — MilestoneEscrow extension**
- `packages/contracts/src/MilestoneEscrow.sol` — add:
  - `address public payoutSigner` storage variable
  - `mapping(uint256 => uint256) public payoutNonces`
  - `setPayoutSigner(address)` function (onlyPayer)
  - `releaseSplit(uint256, address[], uint256[], bytes)` function with ECDSA verify
  - `MilestoneReleasedSplit` event
- `packages/contracts/test/MilestoneEscrow.splitPayout.t.sol` — new Forge test file covering:
  - Happy path: 3-recipient split payout
  - Replay protection: same nonce fails
  - Sum validation: amounts != milestone.amount reverts
  - Wrong signer: invalid signature reverts
  - Backward compat: `release()` still works without payoutSigner

**Step 5 — Gateway routes**
- `packages/gateway/src/routes/ip.ts` — add:
  - `POST /api/ip/rate-schedule` — register a RateSchedule for an ipId
  - `GET  /api/ip/:ipId/rate-schedule` — get current schedule + evaluate at now
  - `POST /api/ip/contributor-profile` — register ContributorProfile
  - `GET  /api/ip/:ipId/contributor-profiles` — list profiles for an IP
  - `POST /api/ip/training-manifest` — register TrainingManifest for a modelIpId
  - `GET  /api/ip/:modelIpId/training-manifest` — get manifest
  - `POST /api/ip/composition-manifest` — register CompositionManifest (validates bps sum)
  - `GET  /api/ip/milestone/:milestoneId/payout-preview` — compute SplitPayoutResult without executing
  - Modify `POST /api/ip/settle-royalties` — prefer `getRoyaltyDistributionRich()` when
    milestoneId provided

**Step 6 — Observability**
- Every `releaseSplit()` on-chain transaction emits `MilestoneReleasedSplit` event
- Gateway logs `SplitPayoutResult` to `split_payout_logs` table after successful `releaseSplit()`
- Add `/api/ip/milestone/:milestoneId/payout-log` GET route for audit trail
- OpenTelemetry span: `contributor.payout.split` with attributes {recipient_count, total_bps_allocated, operator_residual_bps}

---

## Reconciliation Amendment (2026-04-24)

This ADR was authored by `arch-integration-alpha` in parallel with ADR-11
(`arch-splitpayout-bravo`) and ADR-12 (`arch-roles-charlie`). Two of this ADR's
proposals were **superseded** during implementation by the paired ADRs. The
text above is preserved for the historical record of the alternative; the
sections below state what was actually built.

### Supersession 1: splitPayout mechanism

This ADR's Section 1 + Section 6 proposed **Option B** (off-chain compute +
on-chain ECDSA-verified `releaseSplit()` taking `Payout[] calldata + bytes
signature`).

**ADR-11 chose Option A** (on-chain payout map: `setPayoutMap()` called by
payer pre-fund; `release()` reads the stored map and executes N transfers in
one tx). Option A was implemented in `MilestoneEscrow.sol` (commits `dedd057`,
`9cd43a0`, `708fbf8`) with a 14-case Forge test suite (commit `ab8b3b4`,
all 32 tests pass: 18 existing + 14 new).

**Why Option A won**: trust-less by construction (no signing authority needed),
matches existing PCC code patterns (every other state mutation in
`MilestoneEscrow.sol` is direct-write, no off-chain quorum dependency), and
honors the user directive of "publicly-visible immutable schedules" — the
schedule's bps are evaluated at fund time, written on-chain in the payout map,
and any contributor can `getPayoutMap()` to verify their entry before the job
runs. Option B would have required a signing authority = centralization the
user explicitly rejected.

The off-chain `LicensingEngine.evaluateRateSchedule()` + `buildPayoutMap()`
work as designed in this ADR — they just produce inputs for `setPayoutMap()`
instead of an EIP-712 signature.

### Supersession 2: Role taxonomy

This ADR's Section 2 proposed:
- `designer` → `protocol-author` (rename, single mapping)
- `assembler` → `integrator` (rename, collapse)
- `curator` → `insurer` (rename, repurpose)

**ADR-12 chose a different migration** that preserves more semantic precision:
- `designer` → disambiguates by CSD kind: `protocol-author` (for base/profile/extension)
  OR `assembler` (for workflow CSDs) OR `integrator` (for adapter modules)
- `assembler` → **kept unchanged** (compositional workflow author, distinct from integrator)
- `curator` → **kept unchanged** (collection organizer, distinct from insurer)
- `insurer` → **net-new role** (failure-coverage underwriter, opt-in per job)

ADR-12's taxonomy was implemented in commits `f3c15d2` (spec), `d2407db`
(contracts), `a1083f6` (a2a), plus dashboard UI updates. All 5 dashboard files
have ADR-12 colors + presets; legacy `designer` and `network` strings still
decode for backward compat.

**Why ADR-12 won**: it was based on a full codebase audit (every file using
the role enum was inventoried) and it preserves data-decoding compatibility
for existing records that have `assembler` or `curator` roles assigned. ADR-10
would have required a destructive migration of those records.

### What from this ADR was kept

- **Section 1 primitive mapping** for ContributorNFT, RateSchedule, DatasetNFT,
  ModelNFT, TrainingManifest, CompositionManifest — all implemented as proposed.
- **Section 5 LicensingEngine extension methods** — `setRateSchedule()`,
  `evaluateRateSchedule()`, `linkModel()`, `getRoyaltyDistributionRich()` all
  shipped in commit `9bab2ef`.
- **Section 7 schema extensions** for `rate_schedules`, `training_manifests`,
  `composition_manifests`, `contributor_profiles` — types in `@pcc/spec` shipped
  via commits `fa08b9a`, `85f0a58`, `06c18f9`. Database tables deferred to a
  follow-up migration (the off-chain logic is type-complete; persistence pending).
- **Section 4-5 type signatures** for `RateSchedule`, `RateScheduleParams`,
  `ContributorRole`, `TrainingManifest`, `CompositionManifest`, `SplitPayoutResult`
  — all shipped in `packages/spec/src/types/`.

### Net result

This ADR plus ADR-11 plus ADR-12 collectively define the contributor-economics
design. Where they conflicted, the more thorough / less destructive proposal
won (ADR-11 over ADR-10 §6, ADR-12 over ADR-10 §2). The remaining 80% of this
ADR is the canonical record of what was built.
