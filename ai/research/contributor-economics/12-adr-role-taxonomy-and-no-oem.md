# ADR-12: Contributor Role Taxonomy and No-OEM Design Position

**Status**: PROPOSED  
**Date**: 2026-04-23  
**Author**: arch-roles-charlie  
**Branch**: feat/contributor-economics  
**Implements**: Wave 2 ADR — "adr-roles" + "adr-oem-purge-audit" from 00-plan.md

---

## 1. Current Role Model (StoryRoyaltySplit Audit)

### 1.1 The Five Existing Roles

The current type system (as of this audit) defines roles in three coupled locations:

**`packages/spec/src/types/story.ts` line 43:**
```typescript
role: "designer" | "operator" | "verifier" | "assembler" | "curator";
```

**`packages/contracts/ts/story-defaults.ts` line 31:**
```typescript
role: "designer" | "operator" | "verifier" | "network" | "assembler" | "curator";
```
(Note: `network` appears here but not in `spec`. Drift exists today.)

**`packages/a2a/src/types.ts` line 882** (IPRevenueSplitEntry):
```typescript
role: "designer" | "operator" | "verifier" | "assembler" | "curator";
```

### 1.2 What Each Role Means Today

| Role | Current semantic | Where used |
|------|-----------------|------------|
| `designer` | Author of the CSD (Capability StructureDefinition) | story.ts, story-defaults.ts, a2a types, gateway/ip.ts, mcp-server, dashboard (NegotiationPanel, BuilderPage, SplitEditor, IPDetailPage) |
| `operator` | Runs the physical machine that executes the job | All split profiles; always the largest share (60-75%) |
| `verifier` | Evidence-evaluation node; signs attestations | All split profiles; always present at 5-10% |
| `assembler` | Composed multiple capabilities into a workflow | Declared in enum but not present in any of the 3 pre-built SPLIT_PROFILES in story-defaults.ts |
| `curator` | Organized/audited a collection of contributions | Appears only in the `community` profile at 5% |

### 1.3 Role Usage Across Codebase

Files that directly reference the 5-role enum:

| File | What it does with roles |
|------|------------------------|
| `packages/spec/src/types/story.ts:43` | Canonical type definition for `StoryRoyaltySplit` |
| `packages/contracts/ts/story-defaults.ts:31,86-121` | `SplitEntry` interface + 3 `SPLIT_PROFILES` |
| `packages/a2a/src/types.ts:882` | `IPRevenueSplitEntry` for inter-agent negotiation |
| `packages/gateway/src/routes/ip.ts:62` | Request body schema for `POST /api/ip/splits` |
| `packages/mcp-server/src/index.ts:1039` | `pcc_ip_set_splits` tool input schema |
| `packages/mcp-server/src/cli.ts:295` | CLI help text example with `designer` role |
| `apps/dashboard/src/components/builder/NegotiationPanel.tsx:23-38` | Hardcoded split defaults rendered in UI |
| `apps/dashboard/src/pages/BuilderPage.tsx:15-33` | Duplicate hardcoded split defaults |
| `apps/dashboard/src/pages/NegotiationPage.tsx:15-23` | Duplicate hardcoded split defaults |
| `apps/dashboard/src/components/SplitEditor.tsx:28-37` | Role color mapping for UI display |
| `apps/dashboard/src/pages/IPDetailPage.tsx:81-84` | Mock data with 4-role example |

No database column with a role constraint was found (the DB stores raw JSON for splits, not a typed enum column). No Solidity role enum was found — the on-chain layer only tracks wallet addresses and percentages, not role labels. This makes the migration additive: new role values can be added without a breaking migration on the database or contracts.

### 1.4 Tests With Role Assumptions

No test files were found asserting specific role string values in role-typed split entries. The test at `packages/spec/src/__tests__/story-types.test.ts` (if it exists) should be verified during implementation; role assertions there must be updated.

---

## 2. Proposed New Role Taxonomy

### 2.1 The New Enum

```typescript
export type ContributorRole =
  // Execution — always present
  | "operator"              // runs the physical machine; always receives residual share
  // Trust layer
  | "verifier"              // evaluates evidence, signs attestations; slashable on false attest
  | "insurer"               // underwrites job failure coverage; opt-in per job
  // Contribution layers — all use ContributorNFT + RateSchedule
  | "integrator"            // wrote the machine-type adapter (OctoPrint, Bambu, ROS)
  | "protocol-author"       // authored capability schema + test vectors (replaces "designer" for base/profile/extension CSDs)
  | "model-author"          // trained the AI model used at execution time
  | "dataset-contributor"   // pilot who captured training data; paid recursively via TrainingManifest
  // Coordination
  | "curator"               // (keep unchanged) organizes/audits a collection of contributions
  | "assembler"             // (keep unchanged) composed multiple capabilities into a workflow
  // Network
  | "network-treasury";     // per-network treasury address; set by network operator; 0% allowed
```

### 2.2 Migration Map for Each Existing Role

**`designer` → disambiguation required at migration time:**

The term "designer" was overloaded. Migration rule:

- If the CSD `kind` is `base`, `profile`, or `extension`: migrate to `protocol-author`.
- If the CSD `kind` is `workflow`: migrate to `assembler` (the assembler composed the workflow).
- If the CSD represents an adapter or integration module: migrate to `integrator`.
- If none of the above can be determined from CSD metadata: default to `protocol-author` and flag for operator review.

The `label` field (human-readable) carries forward unchanged — UI consumers rely on `label`, not `role`, for display. This is the safe path that preserves existing rendering.

**`operator` → unchanged.** Semantics, position in splits, and payout share remain identical. No migration needed.

**`verifier` → unchanged.** Semantics, slashing mechanics, and position remain identical. No migration needed.

**`assembler` → unchanged.** Kept as-is. Meaning does not change. Enum membership continues.

**`curator` → unchanged.** Kept as-is. Meaning does not change. Enum membership continues.

**`network` (in story-defaults.ts, not in spec) → replaced by `network-treasury`.** The existing drift between `story-defaults.ts` and `spec/types/story.ts` (where `network` is absent) is resolved by adopting `network-treasury` in both. Existing records storing `"network"` as a role label decode safely: the label field carries the display text, and the string value is not enum-validated on-chain.

### 2.3 What Is New

Three roles have no prior analog and must be added:

- **`integrator`**: Person or team who wrote the adapter code connecting a machine type to PCC (OctoPrint adapter, Bambu Labs adapter, ROS 2 bridge, etc.). Their ContributorNFT is minted at adapter registration, not at job time. They earn on every job that runs through their adapter.

- **`model-author`**: Entity that trained the AI model used to execute or quality-assess the job. Earns on every job where their model is invoked. Rate is specified in the model's `RateSchedule`, not negotiated per job.

- **`dataset-contributor`**: Pilot who collected training demonstrations (physical execution data) that fed a `model-author`'s training run. Payment is recursive: job → model-author share → portion distributed to each DatasetNFT holder weighted by training-manifest contribution fraction. This role never appears directly in a `CompositionManifest`; it is resolved at payment time by traversing the `TrainingManifest`.

- **`insurer`**: Underwrites job failure coverage. Optional per job. The insurer's wallet and premium percentage are specified by the requester at booking time. If no insurer is specified, the field is absent from the manifest.

---

## 3. Why No OEM Role — The Protocol Thesis

**Headline**: OEMs participate as Operators, Integrators, Protocol Authors, or Model Authors on equal terms with every other contributor. No special royalty class exists in this protocol.

### 3.1 The OEM Vendor-Lock Business Model

The legacy OEM model is built on deliberate lock-in: proprietary firmware, incompatible spare-part ecosystems, service contracts tied to calibration monopolies, and data silos that make third-party maintenance expensive or legally prohibited. Revenue from a deployed device fleet is extracted through:

- Mandatory service contracts (the machine literally refuses operation without a fresh service cert)
- Proprietary consumables (no third-party ink, filament, reagent)
- Locked software ecosystems (firmware signed by OEM only; no third-party adapters)
- Per-job "royalty" fees embedded in service agreements

This is rent-seeking on deployed capital. The value is extracted not from doing work, but from having created the conditions where others cannot work without paying.

### 3.2 On-Chain Lifetime Royalties Would Recreate That Rent

If PCC encoded an `oem` role with a 1-5% lifetime per-job royalty, every job ever executed on a given machine type would flow a cut to the machine manufacturer — permanently, regardless of what firmware is running, who maintains the adapter, or how outdated the OEM's involvement has become. This is a regression:

- It recreates on-chain what blockchain was supposed to disintermediate
- It gives OEMs a revenue floor that is not tied to any contribution they make after initial hardware sale
- It creates a systemic incentive for OEMs to maintain closed interfaces (more jobs, more royalty) rather than open them
- It disadvantages third-party adapter authors who do the actual integration work and get nothing unless they are the OEM
- It would make PCC complicit in the same dynamic that makes Xometry's 30-35% take rate tolerable — platform capture of value that should flow to the people doing the work

The Claros Layer 4 spec previously included "OEM lifetime royalties 1-5% per job, forever." This is removed. See Section 7 for the amendment text.

### 3.3 Meritocratic Earning: The Replacement Model

OEMs earn by making contributions that the market actually values:

**As Operator**: If an OEM runs their own devices through PCC (a factory floor, a fleet of deployed machines that the OEM services directly), they earn the operator share like any other operator. The share is proportional to their actual execution work, not their historical role as manufacturer.

**As Integrator**: If the OEM writes and maintains the best adapter for their machine type, they earn the integrator share on every job that uses that adapter. If they write a poor adapter, a third party writes a better one, and the third party earns the integrator share instead. This is the forcing function: OEM engineering effort must produce the best possible open interface, or revenue goes elsewhere.

**As Protocol Author**: If the OEM authors the canonical Capability StructureDefinition for their machine class (encoding the true parameter space, correct constraints, validated pricing), they earn the protocol-author share on every job using that CSD. This rewards genuine engineering contribution — documenting what the machine actually does — not merely selling it.

**As Model Author**: If the OEM trains the AI model used for quality assessment or autonomous execution on their equipment, they earn the model-author share on relevant jobs. This rewards ongoing R&D investment.

### 3.4 The Forcing Function for Open Interfaces

Under this model, an OEM that maintains closed firmware earns nothing from PCC's royalty system. Their machines may still be onboarded by third-party operators — but the adapter will be written by whoever has the technical access and motivation to do so. That third-party adapter author earns the integrator share indefinitely.

The OEM's path to maximum earnings on PCC is unambiguous: publish the best adapter, publish the best CSD, contribute to training data. Every contribution is rewarded; absence of contribution earns nothing. This aligns OEM economic incentives with the goals that benefit the whole network: open interfaces, accurate documentation, modular components.

### 3.5 Summary of Design Decision

No `oem`, `manufacturer`, `hardware-vendor`, or `device-maker` role exists in the `ContributorRole` enum. Any proposal to add such a role in the future must clear the bar of explaining:
1. What work does this role perform per-job that is not already captured by operator, integrator, protocol-author, or model-author?
2. Why should this role receive payment disconnected from ongoing work contribution?

If those two questions cannot be answered, the proposal fails.

---

## 4. Role Responsibilities and Payout Expectations

| Role | What they do | Typical rate band | Include in manifest when | Dispute effect |
|------|-------------|------------------|--------------------------|----------------|
| `operator` | Executes the physical job; manages the machine | 80-95% residual (after all other roles sum) | Always | Operator bond slashed if evidence fails verification; payout withheld during challenge window |
| `verifier` | Evaluates evidence bundles, signs attestations, answers challenges | 1-5% of job value, or flat fee for low-value jobs | Always | Verifier stake slashed if they signed a proven-false attestation (50% of their stake); no payout for challenged jobs until resolution |
| `insurer` | Underwrites failure risk; pays out if job fails and operator bond is insufficient | 0-3% premium, collected at booking | Requester opts in at booking time | If job fails and insurer cannot cover (undercapitalized), payout from pool; insurer's future access to pool restricted |
| `integrator` | Authored the adapter code connecting machine type to PCC | 0-100 basis points (market-discovered; set in RateSchedule at adapter registration) | Adapter used by executing operator | Disputes do not affect integrator payout unless dispute directly implicates adapter malfunction |
| `protocol-author` | Authored capability schema (CSD) and test vectors | 0-50 basis points | Capability CSD used for this job | No direct payout effect; dispute against CSD itself is separate from job dispute |
| `model-author` | Trained the AI model invoked at execution time | 0-80 basis points | AI model used at execution | No direct payout effect from individual job disputes |
| `dataset-contributor` | Collected training data (physical demonstrations) | Fraction of model-author share, weighted by training-manifest contribution | Resolved recursively at payment time via TrainingManifest; never appears in CompositionManifest directly | No direct payout effect |
| `curator` | Organizes, audits, and surfaces a collection of contributions | Variable flat fee; 0-5% | Opt-in; curator must be listed in manifest by protocol-author | Curator earns regardless of individual job outcomes |
| `assembler` | Composed multiple capabilities into a workflow | 0-50 basis points | Workflow CSD used for this job | No direct payout effect from individual step disputes |
| `network-treasury` | Per-network protocol treasury; funds verification, grants, security | 0-3% (0% allowed; set by network operator at network creation) | Always, per-network default | Treasury share is not slashable; it accumulates regardless of job outcomes |

**Residual calculation for operator**: The operator's percentage is whatever remains after summing all other roles. In a standard single-step job: `operator% = 100% - verifier% - protocol-author% - integrator% - network-treasury%`. This means operators and the market price contribution roles against each other naturally: if integrators set high rates, the operator portion shrinks, and operators will prefer lower-rate adapters. Market discipline without protocol intervention.

**Touchstone fees (digital-verifier interaction)**: When the `digital-verifier`
branch lands, its touchstone-fee mechanism (per `poa-digital-verifier.md` —
6 primitives including `touchstone`, `assuranceScore`, `ChallengeService`)
funds out of the `verifier` role's bps share. There is no separate
`touchstone` role in this enum. Verifiers who run higher-assurance touchstone
flows can bid a higher RateSchedule for those jobs; the per-job market clears
naturally. This avoids coupling our role taxonomy to digital-verifier's
internal primitives prematurely — if digital-verifier's design evolves,
only its operators' RateSchedules adjust, not the protocol's role enum.

---

## 5. Codebase Audit — What Changes

The following files require changes to implement the new role taxonomy. Changes are additive where possible; the old role strings remain valid for legacy data decoding.

### Required Changes

| File | Change description | Breaking? |
|------|--------------------|-----------|
| `packages/spec/src/types/story.ts:43` | Extend `role` union in `StoryRoyaltySplit` splits array to include all new roles. Old values remain valid. | No |
| `packages/contracts/ts/story-defaults.ts:31` | Extend `SplitEntry.role` union. Reconcile `"network"` → `"network-treasury"` (keep old string as alias or deprecation comment). Update `SPLIT_PROFILES` to use new role names in defaults; add new profiles for `protocol-author + integrator + model-author` combinations. | No |
| `packages/a2a/src/types.ts:882` | Extend `IPRevenueSplitEntry.role` union to include new roles. | No |
| `packages/gateway/src/routes/ip.ts:62` | Extend inline Zod union for `role` in the `pcc_ip_set_splits` route body schema. | No |
| `packages/mcp-server/src/index.ts:1039` | Extend `pcc_ip_set_splits` tool input schema to include all new role values. Update description text to reference new roles. | No |
| `packages/mcp-server/src/cli.ts:295` | Update help text example to demonstrate `protocol-author` and `integrator` roles. | No |
| `apps/dashboard/src/components/builder/NegotiationPanel.tsx:23-38` | Add new roles to color maps and default split presets. Add new preset template for `protocol-author + integrator + model-author`. | No |
| `apps/dashboard/src/pages/BuilderPage.tsx:15-33` | Same as NegotiationPanel — add new presets, extend color maps. | No |
| `apps/dashboard/src/pages/NegotiationPage.tsx:15-23` | Same as above. | No |
| `apps/dashboard/src/components/SplitEditor.tsx:28-37` | Add color assignments for `integrator`, `protocol-author`, `model-author`, `dataset-contributor`, `insurer`, `network-treasury`. | No |
| `apps/dashboard/src/pages/IPDetailPage.tsx:81-84` | Update mock data to demonstrate new roles. | No |

### No Change Required

| File | Why |
|------|-----|
| `packages/contracts/src/MilestoneEscrow.sol` | On-chain escrow stores addresses and amounts only; role labels are off-chain. `splitPayout()` extension is a separate ADR (ADR-splitpayout). |
| Any `.sol` file | No Solidity enum for contributor roles exists; all role semantics are in TypeScript. |
| Database schema | Splits are stored as JSON blobs; no typed role column exists. New roles decode automatically. |
| `packages/spec/src/__tests__/story-types.test.ts` | Must be verified: if tests assert the exact role union shape, they need updating to include new role values. |

---

## 6. OEM-Reference Audit Across the Repo

A grep for `oem`, `OEM`, `manufacturer`, `hardware vendor`, `hardware royalt`, and `lifetime royalt` was run across the entire worktree (excluding `node_modules`, `.git`).

### Code-Level Findings (TypeScript, Solidity)

**Result: CONFIRMED OEM-FREE AT CODE LEVEL.**

No TypeScript or Solidity file contains an `oem` or `hardware-royalty` role. No split profile or enum includes any OEM-class role. The codebase is clean at the code layer.

The one near-miss: `packages/kernel/src/__tests__/tier-enforcement.test.ts` lines 60, 76, 91, 106 contain `eventsToEmit` — this is `emit` in the generic TypeScript sense, not OEM. Confirmed false positive.

### Documentation Findings

Each finding is triaged below.

| File | Lines | Content | Triage |
|------|-------|---------|--------|
| `docs/protocol-economics.md:443` | 1 | "Industrial equipment OEMs (want utilization data for warranty/maintenance planning)" | **LEAVE ALONE** — this is a description of a data-licensing buyer segment, not a royalty class. OEM as customer is fine. |
| `docs/protocol-economics.md:570` | 1 | "Target: aerospace, defense, medical device OEMs" | **LEAVE ALONE** — describes enterprise buyer targets (requesters). Correct framing. |
| `ai/research/standards-landscape.md:573` | 1 | "Customer-specific requirements (CSRs) from each OEM" (IATF 16949 context) | **LEAVE ALONE** — this describes an automotive quality standard; OEM is used in its IATF meaning (Original Equipment Manufacturer as the car maker issuing supplier requirements). Not a PCC role. |
| `ai/research/belief-moat/TECHNOECONOMIC-REPORT.md:83` | 1 | "Machine shops typically run 50-60%, absorbing OEM overflow in boom-bust cycles" | **LEAVE ALONE** — macroeconomic context. Factually accurate description of manufacturing market dynamics. |
| `ai/research/contributor-economics/00-plan.md:9,11` | 2 | "OEM royalty is GONE" / "OEMs earn only as Operators, Integrators..." | **LEAVE ALONE** — this IS the design decision documentation. Correct. |
| `ai/research/contributor-economics/01-royalty-nft-standards.md:40` | 1 | "We explicitly forbid platform/OEM rent layers" | **LEAVE ALONE** — research doc recording the design decision. Correct. |
| `ai/research/machine-class-standards.md:53` | 1 | `brand`: `manufacturer name` (in data schema) | **LEAVE ALONE** — `manufacturer` here is a device metadata field (who made the physical machine). Not a contributor role. |
| `ai/research/agent-harness-standards.md:782,787,790,792,904` | 5 | "hardware attestation", "manufacturer-signed attestation key", "manufacturer's root certificate" | **LEAVE ALONE** — security/attestation context. `manufacturer` = device maker providing cryptographic root of trust. Not a PCC contributor role. |
| `docs/whitepaper.md:450` | 1 | "lab equipment manufacturer interested in seeing the protocol proliferate" | **LEAVE ALONE** — describes a secondary-market scenario where a manufacturer buys Royalty Tokens as an investor. This is the correct model: they participate by buying tokens on the secondary market, not by being granted a special royalty class. |
| `apps/dashboard/src/pages/DeviceBuilderPage.tsx:118-123` | 6 | `manufacturer` form field | **LEAVE ALONE** — device metadata field (brand name of the physical device). Required for device registration, not a contributor role. |
| `apps/dashboard/src/pages/onboard/Step1_MachineIdentity.tsx:39-44` | 2 | `manufacturer` form field | **LEAVE ALONE** — same as above. Onboarding UI device metadata. |
| `apps/dashboard/public/whitepaper.md:458` | 1 | Same as `docs/whitepaper.md:450` | **LEAVE ALONE** — same reasoning. |
| `ai/supervisor/status.json:37` | 1 | "OEM royalty is GONE (user directive)" | **LEAVE ALONE** — status log entry recording the decision. |

**Summary**: Zero hits require changes. The codebase and documentation are either already aligned with the no-OEM position, or use "OEM" / "manufacturer" in entirely different contexts (buyer segment, device metadata, security attestation, industry standards). No purge needed at the code or main documentation level.

---

## 7. Claros Layer 4 Amendment

The Claros PROPOSAL.md (maintained externally, reference in user memory from April 7-11, 2026) contains "OEM lifetime royalties 1-5% per job, forever" as part of Layer 4 (Economic). This clause is removed.

The following amendment block is drafted for insertion into the Claros PROPOSAL.md. It will be written to `docs/claros-layer4-amendment.md` in Wave 4.

```markdown
## Layer 4 Amendment: OEM Role Removed (2026-04-23)

### What Was Proposed

The original Layer 4 economic spec (April 11, 2026) included:

> "OEM lifetime royalties 1-5% per job, forever. Converts hardware manufacturing
> into a services business. Hub-as-Manufacturer pattern: a hub designs + builds +
> sells + collects royalties from devices it created."

### What Changes

The OEM lifetime royalty class is **REMOVED** from Layer 4.

This is not a compromise position. It is a design decision about what the
Physical Capability Cloud protocol is for.

The legacy OEM business model — proprietary firmware, spare-part monopolies,
service-contract lock-in, mandatory calibration fees — extracts rent from
deployed capital rather than from ongoing work. Encoding a 1-5% per-job
lifetime royalty on-chain would recreate that rent structure in an immutable
form. Every job on a Bambu printer would flow a cut to Bambu Labs forever,
regardless of whether Bambu's engineers contributed anything to that job's
execution, evidence quality, or capability definition.

That is not a manufacturing renaissance. It is the Xometry model with better
cryptography.

### Replacement

OEMs participate in PCC's contributor economics through the same roles
available to every other contributor:

- **As Operator**: Run your own devices through PCC. Earn the operator share
  (80-95% of job value after other roles). Revenue is proportional to work done.
- **As Integrator**: Write and maintain the best adapter for your machine class.
  Earn integrator basis points on every job that uses your adapter. If a
  third party writes a better adapter, they earn instead. The market decides.
- **As Protocol Author**: Author the canonical CSD for your machine type.
  Encode what the machine actually does. Earn protocol-author basis points
  on every job using that CSD.
- **As Model Author**: Train AI models for quality assessment or autonomous
  execution on your equipment. Earn model-author basis points on relevant jobs.

The forcing function is intentional: OEMs who want revenue from their deployed
fleet must maintain the best open adapter, the best CSD, the best models.
Absence of contribution earns zero. This aligns OEM incentives with open
interfaces and modularity rather than closure.

### Hub-as-Manufacturer Pattern (Preserved)

The Hub-as-Manufacturer vision survives this amendment. A hub that designs,
builds, and deploys devices:

- Earns integrator share from the adapter it writes for its devices
- Earns protocol-author share from the CSDs it authors
- Earns operator share from the machines it runs
- Earns model-author share from the models it trains

The difference from the removed OEM-royalty model: earnings are tied to
ongoing contribution, not to the historical fact of having manufactured
the hardware. This is meritocratic. It creates durable incentives for
quality and openness rather than lock-in.
```

---

## 8. Acceptance Criteria

- [x] New role enum defined and proposed for `packages/spec/src/types/story.ts`
- [x] Every existing role has a documented migration target (Section 2.2)
- [x] No OEM/manufacturer role exists anywhere in the proposal
- [x] Rationale for no-OEM is explicit and publishable (Section 3)
- [x] Audit of the whole worktree complete; all OEM hits triaged with LEAVE ALONE / CHANGE verdicts (Section 6)
- [x] Claros amendment draft text written (Section 7)

---

## Implementation Sequencing

This ADR feeds Wave 3 implementation in the following order:

1. **First**: Update `packages/spec/src/types/story.ts` — this is the single source of truth.
2. **Second**: Update `packages/contracts/ts/story-defaults.ts` — derives from spec.
3. **Third**: Update `packages/a2a/src/types.ts` — derives from spec.
4. **Fourth**: Update gateway + MCP server schemas — derives from a2a types.
5. **Fifth**: Update dashboard UI components — derives from contracts defaults.
6. **Parallel with 2-5**: Write `docs/claros-layer4-amendment.md` (Wave 4 item, no code dependency).

Old role strings (`designer`, `assembler`, `curator`, `operator`, `verifier`, `network`) remain valid in all systems for backward compatibility. The migration from `designer` to `protocol-author` / `integrator` / `assembler` is a data migration task, not a breaking type change, and is deferred to a separate migration plan document.
