# PyLabRobot Backend Authors — How to Get Paid for Your Work

**Status**: Phase 1 (on-chain registry + off-chain CLI + aggregator gate). Phase 2 (claim-your-backend dashboard page, ERC-8004 deep integration, Splits.org one-click deploy) ships Q3 2026.

**Scope**: this doc is for the OSS authors who wrote (or maintain) a PLR backend — e.g., `pylabrobot.liquid_handling.backends.hamilton.STAR`, `pylabrobot.plate_reading.clariostar`, `pylabrobot.heating_shaking.inheco.thermoshake`. If a PCC operator drives a physical job through your backend, you can be paid for it.

**Architecture sources**:
- `ai/scoping/plr-backend-author-economics-2026-05-25.md` — full design
- `ai/scoping/plr-answers-validation-2026-05-25.md` — validated decisions

---

## In one paragraph

PCC's adapter layer (`@pcc/adapter-pylabrobot`) talks to a Python sidecar that imports one or more PLR `Backend` subclasses to drive physical instruments. The actual device-driver code that talks to a Hamilton STAR's USB firmware was written by community contributors — until now, those contributors earned nothing from PCC jobs. The new on-chain `PLRBackendRegistry` lets any PLR backend author claim attribution for their module, publish a rate schedule, and earn a per-call basis-points payout out of the protocol fee on every job that runs through their backend. No fork of PLR, no relicensing, no changes to the PLR upstream — this entire system lives on the PCC side and is opt-in for any author.

---

## The economics (TL;DR)

- **Default rate**: 10 bps (0.10%) flat-for-life per job, out of the 2.35% protocol fee.
  - That's ~4.3% of PCC's protocol take, or ~$0.10 on a $100 job, paid to you.
  - This is a PCC-side default, NOT industry standard — comparable OSS-author economics (tea.xyz, Drips, RetroPGF) are all aggregate-emission models, not per-call rates. Spotify's "single-digit % of platform revenue to creator" is the closest analog.
  - REVIEW_AT 2026-11-25: 6-month review. If <10 backends are registered at that point we'll raise the default; if >50, leave as-is.
- **Co-author splits**: up to 8 authors per backend, weighted via `groupBps` (must sum to 10000). One ContributorNFT owner is the "primary maintainer" with kill-switch authority; their wallet (or a Splits.org / Gnosis Safe contract) routes the per-job bps to all co-authors. See "Co-authors" below.
- **You set the rate**: 0-200 bps freely. Three presets are offered in the dashboard onboarding (Phase 2 ships dashboard; Phase 1 is CLI-only):
  - "Just credit me" — `constant 0 bps`. Mint a ContributorNFT, appear in event logs, no money flow.
  - "PCC-suggested default" — `constant 10 bps` (the validated answer).
  - "Adoption-decayed" — `adoption-indexed {scale: 200, floor: 5, cap: 200}` (starts high, decays as the network grows).
- **Payouts are public on-chain**. Every BackendRegistered / BackendEnabledChanged / AuthorshipTransferred event includes the author's wallet address verbatim. This is consistent with every comparable primitive (0xSplits / Drips / Mirror / tea.xyz are all public on-chain).

---

## How it works

```
Operator runs a PCC job through @pcc/adapter-pylabrobot.
       |
       v
@pcc/adapter-pylabrobot (TS proxy)
   1. Resolves the PLR modulePath from the MachineProfile
   2. Calls PLRBackendGate.assertEnabled(modulePath)         <-- registered + enabled?
   3a. If disabled → reject with backend_disabled (503)
   3b. If enabled OR unregistered → forward to Python sidecar
       |
       v
   Python sidecar imports the PLR backend (your code) → drives instrument
       |
       v
   Aggregator composes the CompositionManifest
   - Appends one CompositionEntry per registered backend author
   - bps comes from your published RateSchedule
       |
       v
   MilestoneEscrow.splitPayout() routes the bps to your wallet on-chain
```

Your work earns you bps for every job that runs through your backend on PCC. You never have to touch PCC infrastructure; you just register once.

---

## Registering your backend (Phase 1 CLI flow)

The full self-serve dashboard ships in Phase 2 at `https://capability.network/claim-plr-backend` per the validated outreach order (page first → DM second → forum post third). For Phase 1 you can register directly via the CLI in `@pcc/plr-registry-client`.

### Prerequisites

1. **An EVM wallet** with enough Base ETH for gas (Base mainnet — per validated answer Q2). One register() call is ~$0.01-$0.05.
2. **A published RateSchedule.** The PCC `RateScheduleRegistry` is content-addressed. Use `pcc rate-schedule publish` (Phase 2 dashboard flow) or `forge script script/PublishSchedule.s.sol`.
3. **A ContributorNFT minted with `role=BACKEND_AUTHOR`.** Mint via the existing `MintContributor.s.sol` script with `role=keccak256("backend-author")`. The contract validates the role tag at register-time.
4. **A signed BackendManifest.** Optional in Phase 1 (you can pass an opaque CID); the dashboard automates this in Phase 2.

### CLI commands

```bash
# Set up env (defaults to Base mainnet)
export PLR_BACKEND_REGISTRY_ADDRESS=0x...           # (deployed address, see deploy log)
export PLR_BACKEND_REGISTRY_CHAIN=base              # or base-sepolia for staging
export DEPLOYER_PRIVATE_KEY=0x...                   # your maintainer wallet

# Register
pcc-plr-register \
  --module pylabrobot.liquid_handling.backends.opentrons.OT2 \
  --token-id 142 \
  --schedule-hash 0xab12...cdef \
  --manifest ./my-backend-manifest.json

# Flip the kill switch (forward-only: doesn't refund in-flight escrow)
pcc-plr-toggle --module pylabrobot.liquid_handling.backends.opentrons.OT2 --disable

# Check current status
pcc-plr-status --module pylabrobot.liquid_handling.backends.opentrons.OT2
```

---

## The kill switch

You can disable your backend at any time from your wallet OR from a delegated agent address. Mechanics:

- `setEnabled(modulePathKey, false)` — blocks NEW jobs via the aggregator's gate.
- In-flight escrow is NOT cancelled (forward-only per validated answer Q7). Already-funded jobs settle under existing rules. If you've identified a critical safety bug in-flight, use `MilestoneEscrow.fileDispute()`, not the kill switch.
- 60-second `MIN_TOGGLE_INTERVAL` prevents grief loops (an attacker who briefly controls your wallet can't oscillate enabled to grief operators).
- A 5-minute aggregator-side TTL cache means there's some propagation delay after you flip the bit — operators will see the new state within 5 minutes max.

Delegated agent: pass `--delegated-agent <evm-address>` at register-time to authorize a second address to flip the kill switch on your behalf. Useful if you want to delegate operational control to an org or an automated security responder. Phase 1 stores an EVM address; Phase 2 (Q3 2026) swaps to an ERC-8004 tokenId in the same field shape (no migration needed).

---

## Co-authors

If your backend has multiple maintainers (e.g., 3 people on `pylabrobot.liquid_handling.backends.tecan.evo`), two patterns:

### Pattern A: Multi-entry off-chain

Each author appears in `BackendManifest.authors[]` with their own `groupBps`. Sum must equal 10000. The aggregator emits one `CompositionEntry` per author at quote time, all under the `backend-author` role. The on-chain `author` field is the ContributorNFT owner (primary maintainer) — they hold the kill switch and the transferAuthorship key.

Drawback: each author counts toward the MAX_PAYOUTS=16 cap. If the job already has 12 other contributors and your backend has 5 co-authors, you blow the cap. Use Pattern B for >3 co-authors.

### Pattern B: Splits.org / Gnosis Safe

`BackendManifest.authors[]` has exactly 1 entry whose `address` field is a deployed [Splits.org](https://splits.org/docs) split contract (or a Gnosis Safe). The split routes the bps to all co-authors internally. One on-chain `CompositionEntry`, one Payout, then the Splits contract handles the routing in a follow-up tx.

Phase 1 doesn't ship an inline Splits.org deploy helper per validated answer Q4 — the linkout above is the recommended path. If 3+ authors specifically ask for one-click Splits deployment, we'll build it; meanwhile their docs are excellent and the contracts are battle-tested.

---

## Authorship transfer (14-day timelock)

For routine "I'm handing maintainership of this backend to someone else" flows:

1. Mint a new BACKEND_AUTHOR ContributorNFT for the receiving address (or have them mint one and send it to you).
2. Call `proposeAuthorshipTransfer(modulePathKey, newTokenId)` from your current wallet.
3. Wait 14 days (`AUTHORSHIP_TRANSFER_TIMELOCK_SECONDS = 14 * 24 * 3600`).
4. Anyone can call `executeAuthorshipTransfer(modulePathKey)` — the contract reads `ContributorNFT.ownerOf(newTokenId)` at that moment to determine the new author.

**Why 14 days?** Per validated answer Q5 — authorship transfer is a unilateral non-quorum operation. The cost of waiting an extra week for a legitimate transfer is trivial; the cost of letting a stolen key complete a transfer in 7 days is permanent loss of future income. 14 days gives you a recovery window if your key gets compromised.

You can cancel a pending transfer at any time with `proposeAuthorshipTransfer(modulePathKey, 0)`.

---

## Lost-wallet recovery (governance multisig, 30-day window)

If you lose your wallet and don't have a Gnosis Safe / Splits contract as the ContributorNFT owner (and thus no social recovery), the registry has a governance-gated recovery hook:

1. Post a public attestation off-chain (GitHub commit signed with your prior key, PGP key, ENS, prior on-chain identity, etc.).
2. PCC governance multisig reviews the attestation.
3. If convinced, governance calls `recoverAuthorship(modulePathKey, newTokenId)` — this proposes a recovery to a new ContributorNFT under the multisig's control.
4. 30-day attestation window (`RECOVERY_ATTESTATION_WINDOW_SECONDS = 30 * 24 * 3600`) gives the original author maximum time to surface if alive.
5. After 30 days, anyone can call `claimRecovery(modulePathKey)` and the new ContributorNFT owner becomes the author.

**Phase 1 scope**: just the contract hook (`recoverAuthorship` is callable only by the `governanceMultisig` address; if that address is `0x0` the recovery path is disabled entirely). The actual multisig deployment + attestation collection flow lives off-chain and is documented in this section for later — Phase 1 ships the hook so the path exists; full process automation is Phase 2+.

**Recommended**: don't rely on governance recovery. Use a Gnosis Safe with social recovery as the ContributorNFT owner from day one. Governance recovery is the last-resort fallback.

---

## Discovery / outreach (sequence matters)

Per validated answer Q9, the outreach order is:

1. **Self-serve claim page first** (Phase 2): `https://capability.network/claim-plr-backend` will list every PLR backend currently in PLR main with NO registry entry, with "Estimated unclaimed earnings" pulled from real recent jobs. Authors see money on the table → claim.
2. **GitHub auto-discovery DM second** (Phase 2): scan `PyLabRobot/pylabrobot/backends/` for committers, send personalized invites at one author per backend per week max. Frame: "we set aside attribution for your work; here's a one-click claim flow." No spam.
3. **Forum post on `discuss.pylabrobot.org` third** (Phase 2): after the claim flow is live and has 3-5 reference claimants. Don't ship the forum post first or you drive interest to a dead page.

Phase 1 ships none of these surfaces; the CLI is the only path. Phase 2 builds them in the order above.

This sequence is informed by tea.xyz / Drips / RetroPGF, all of whom converged on self-serve > cold outreach.

---

## Forward-compatibility notes

- **delegatedAgentId is bytes32**. Phase 1 stores an EVM address (left-padded). Phase 2 (Q3 2026) swaps to ERC-8004 tokenId — same field shape, no schema change. Your code calling `setDelegatedAgent` continues to work; the encoding helper in `@pcc/spec/util/plr-backend-manifest` will swap from `addressToDelegatedAgentBytes32` to `tokenIdToDelegatedAgentBytes32` under the hood.
- **ipId derivation is stable**. The on-chain `deriveIpId(modulePath, majorVersion)` formula will not change. Off-chain, use `deriveBackendIpId` from `@pcc/spec`.
- **ContributorNFT contract is unchanged**. We added one new role tag (`BACKEND_AUTHOR`) to the codegen list; the on-chain NFT contract itself accepts arbitrary bytes32 role tags and didn't need code changes.

---

## Phase 1 deferred items

- "Claim your backend" web page on capability.network (Phase 2)
- Auto-discovery DM bot scanning PLR commits (Phase 2)
- Splits.org one-click deploy UI (Phase 2 — current path: linkout to splits.org/docs)
- Subgraph for event-driven cache invalidation (Phase 1 uses 5-min TTL cache)
- Dashboard pages for per-author earnings (Phase 2)
- Story Protocol IP overlay (Phase 2 optional — `ipId` field forward-compatible)
- ContributorNFT minting flow automation (Phase 1: mint separately, then call `register`)
- ERC-8004 deep integration (Phase 2 — `delegatedAgentId` field is forward-compatible)

---

## Operator-side: when a backend is disabled

When you `pcc-plr-toggle --disable` your backend, the aggregator returns a structured `BackendDisabledError`:

```json
{
  "error": "backend_disabled",
  "details": {
    "modulePath": "pylabrobot.liquid_handling.backends.hamilton.STAR",
    "lastEnabledChange": 1716700000,
    "author": "0xAbCdEf...0001",
    "manifestCid": "0xbafy..."
  },
  "httpStatus": 503
}
```

Operators using your backend should handle this as a graceful "backend currently unavailable" — surface a clear message to the requester, optionally check the manifest's `notes` field for a migration hint (e.g., "use `pylabrobot.liquid_handling.backends.hamilton.STAR_v2` instead").

---

## Reference

- Architecture: `ai/scoping/plr-backend-author-economics-2026-05-25.md`
- Validated decisions: `ai/scoping/plr-answers-validation-2026-05-25.md`
- Contract: `packages/contracts/src/PLRBackendRegistry.sol`
- Off-chain types: `packages/spec/src/types/plr-backend-registry.ts`
- Helpers: `packages/spec/src/util/plr-backend-manifest.ts`
- Client + CLI: `packages/plr-registry-client/`
- Aggregator gate: `packages/aggregator/src/plr-backend-gate.ts`
- Existing contributor economics: `docs/CONTRIBUTOR_ECONOMICS.md`
- Sister doc (PCC adapter authors): `docs/ADAPTER_BOUNTIES.md`
- Splits.org docs: https://splits.org/docs
