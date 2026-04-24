# Claros Layer 4 Amendment: OEM Role Removed (2026-04-23)

**Amends**: Claros PROPOSAL.md Layer 4 (Economic) — specifically the "OEM lifetime
royalties 1-5% per job, forever" clause from the April 11, 2026 revision.

**Status**: ACCEPTED — 2026-04-23 (user directive during contributor-economics design session)

**Supersedes**: The "Hub-as-Manufacturer pattern" clause that granted OEMs a
per-job royalty stream. The Hub-as-Manufacturer *vision* survives; the
*mechanism* changes fundamentally.

---

## What Was Proposed

The original Layer 4 economic spec (April 11, 2026) included:

> "OEM lifetime royalties 1-5% per job, forever. Converts hardware manufacturing
> into a services business. Hub-as-Manufacturer pattern: a hub designs + builds +
> sells + collects royalties from devices it created."

## What Changes

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

## Replacement

OEMs participate in PCC's contributor economics through the same roles
available to every other contributor:

- **As Operator**: Run your own devices through PCC. Earn the operator share
  (residual after all other roles — typically 80-95% of job value). Revenue
  is proportional to work done.
- **As Integrator**: Write and maintain the best adapter for your machine class.
  Earn `integrator` basis points on every job that uses your adapter. If a
  third party writes a better adapter, they earn instead. The market decides.
- **As Protocol Author**: Author the canonical Capability StructureDefinition
  for your machine type. Encode what the machine actually does. Earn
  `protocol-author` basis points on every job using that CSD.
- **As Model Author**: Train AI models for quality assessment or autonomous
  execution on your equipment. Earn `model-author` basis points on relevant
  jobs.

The forcing function is intentional: OEMs who want revenue from their deployed
fleet must maintain the best open adapter, the best CSD, the best models.
Absence of contribution earns zero. This aligns OEM incentives with open
interfaces and modularity rather than closure.

## Hub-as-Manufacturer Pattern (Preserved — Mechanism Changed)

The Hub-as-Manufacturer vision survives this amendment. A hub that designs,
builds, and deploys devices:

- Earns `integrator` share from the adapter it writes for its devices
- Earns `protocol-author` share from the CSDs it authors
- Earns `operator` share from the machines it runs
- Earns `model-author` share from the models it trains

The difference from the removed OEM-royalty model: earnings are tied to
**ongoing contribution**, not to the historical fact of having manufactured
the hardware. This is meritocratic. It creates durable incentives for
quality and openness rather than lock-in.

## Implementation Notes

See these PCC codebase artifacts for the mechanical implementation:

- `packages/spec/src/types/story.ts` — `ContributorRole` enum extended; no
  `oem` / `manufacturer` / `hardware-vendor` member exists (by design).
- `packages/contracts/src/MilestoneEscrow.sol` — `Payout` struct + `setPayoutMap()`
  + modified `release()` route funds across N contributor recipients based on
  per-milestone payout maps; legacy single-operator path preserved for
  backward compatibility.
- `ai/research/contributor-economics/12-adr-role-taxonomy-and-no-oem.md` —
  full role taxonomy audit + OEM-free codebase verification (14 grep hits
  across the repo, all triaged "LEAVE ALONE" as they use OEM/manufacturer
  in non-royalty contexts: enterprise buyer segment, device-metadata fields,
  security-attestation roots of trust, industry standards context).
- `ai/research/contributor-economics/10-adr-licensing-engine-extension.md` —
  integration plan for the existing `LicensingEngine` + Story Protocol IP
  graph. No OEM role was ever present in `LicensingEngine`; extension is
  purely additive.

## Rule for Future Proposals

Any future proposal to add an `oem` / `manufacturer` / `hardware-vendor` /
`device-maker` role to `ContributorRole` must clear this bar:

1. What work does this role perform *per-job* that is not already captured
   by `operator`, `integrator`, `protocol-author`, `model-author`, or
   `dataset-contributor`?
2. Why should this role receive payment disconnected from ongoing work
   contribution?

If those two questions cannot be answered with concrete per-job value, the
proposal fails.

---

Authored during the `/go thoroughly research each of these topics and then
build all of this and wire it in` session on 2026-04-23 by `arch-roles-charlie`
(taxonomy + rationale) and the orchestrator (this amendment doc). The Claros
external PROPOSAL.md should be updated to cite this amendment in its Layer 4
section revision history.
