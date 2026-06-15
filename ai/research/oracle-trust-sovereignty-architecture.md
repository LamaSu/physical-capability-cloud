# PCC Oracle Trust & Sovereignty Architecture

**Status:** design + reference implementation, ready for lane pickup
**Date:** 2026-06-14
**Author:** /go (CDP-onramp session, handed off)
**Constraint:** the V2 stack is **LIVE** on capability.network (escrow `0xbC1576…`, live oracle).
This doc is a **design + reference code handoff** — it does **not** modify the live
contracts/oracle/gateway in place. Each change below names the owning lane and whether it
is safe-additive or needs a coordinated redeploy.

---

## The principle

**PCC is the thin protocol/coordination layer. The oracle is the verification + settlement
authority. The escrow contract is custody. The two parties own their job data.** Fee-setting,
attestation, and verification-observability all live OFF the PCC server. Directly serves the
distributed-ownership vision: protocol coordination, not rent-seeking middleman.

Three concerns, each mapped current → target → reference code → phasing.

---

## SOTA (2026)

| Concept | SOTA primitive | Bearing on PCC |
|---|---|---|
| Decentralized verification | **EigenLayer AVS** (>$18B restaked, 1900 operators; Eoracle/RedStone are live restaked oracles) | single-key oracle → m-of-n **staked, slashable** verifier set |
| Oracle-set fee | **EAS resolver contracts** natively "attach payments to attestations"; fee encoded via `SchemaEncoder` | fee rides inside the signed attestation, read by escrow/resolver |
| Private/scoped observability | **Lit Protocol** access-control-condition encryption (no central custodian). **V0 "Datil" sunset 2026-02-25**; V1 "Naga" + "Chipotle" (AI-agent-native) current | encrypt evidence to {buyer, operator, oracle}; PCC stores ciphertext |
| Verification model | **UMA optimistic oracle** (assume-true-unless-disputed) ≈ PCC's challenge window; **ZK process attestation** (arxiv 2603.00179) = prove-tier-without-revealing | optimistic for cost + ZK for privacy (Tier-3 already ZK) |

Sources: EigenLayer AVS (blog.eigencloud.xyz/avs-launch), RedStone restaking oracle,
EAS contracts (github.com/ethereum-attestation-service/eas-contracts), Lit access control
(developer.litprotocol.com/sdk/access-control/intro), UMA OO (blog.uma.xyz), ZK process
attestation (arxiv.org/html/2603.00179).

---

## Concern 1 — Fee from the oracle, not PCC

### Current (the problem)
- `MilestoneEscrowV2.release()` reads `IPCCProtocolV2(protocolRoot).protocolFeeBps()` (`:915`).
- `PCCProtocolV2.protocolFeeBps` is **`onlyGovernor`-settable** via `setProtocolFeeBps()` (`:241`).
  → the fee is a **PCC-governed knob**. The payer can't set it, but PCC governance can.
- `feeRecipient` is immutable (`PCCProtocolV2.sol:45`) — good, keep.
- A hook already exists: **`collectFeeWithAttestation(...)`** (`PCCProtocolV2.sol:305`).

### Target
The oracle computes the fee in its own repo and **signs it into the EAS attestation**; the
escrow reads the fee **from the attestation payload**, not from any PCC contract. Neither the
buyer, the operator, nor PCC governance can change it — it rides inside the signature that
already gates release.

### Reference changes
1. **Schema** (`oracle.evidence.v1`, owned by the oracle repo — see Concern 2): append
   `uint16 feeBps` and `address feeRecipient` to the encoded payload.
2. **`MilestoneEscrowV2.submitAttestation()`** — extend the existing `abi.decode` (`:817`):
   ```solidity
   ( string memory jobId, bytes32 kernelId, bytes32 evidenceBundleHash, string memory ipfsCid,
     uint8 assuranceTier, bool oracleVerified, bytes32 stepId,
     uint16 feeBps, address feeRecipient                       // ← appended
   ) = abi.decode(a.data, (string,bytes32,bytes32,string,uint8,bool,bytes32,uint16,address));
   require(feeBps <= MAX_FEE_BPS, "fee out of range");          // MAX_FEE_BPS sanity cap, immutable
   m.attestedFeeBps = feeBps;                                   // new Milestone fields
   m.attestedFeeRecipient = feeRecipient;
   ```
3. **`MilestoneEscrowV2.release()` / `_distributeLegacy` / `_distributeWithMap`** — replace
   `root.protocolFeeBps()` / `root.feeRecipient()` with `m.attestedFeeBps` / `m.attestedFeeRecipient`.
   Keep `root.collectFee()` purely as an accounting callback (no rate authority).
4. **`PCCProtocolV2`** — deprecate `setProtocolFeeBps` (governor path) for settlement;
   the rate now arrives via the attestation. Route accounting through the existing
   `collectFeeWithAttestation()` hook so the protocol still records fees without setting them.

### Why this is SOTA-correct
EAS resolvers are *designed* to attach payment logic to attestations. Embedding the fee in
the signed payload makes it **immutable per-job, oracle-determined, tamper-proof** — the same
signature that authorizes release authorizes the rate.

### Owning lane / risk
**Contracts lane.** Needs a **redeploy** (it's the live escrow + protocol). Ship as
`MilestoneEscrowV3` (additive new contract) + schema v2; the factory points new escrows at V3.
Existing V2 escrows finish under the old fee path (immutable per-escrow — no migration risk).

---

## Concern 2 — Oracle = independent authority, then decentralized

### Current
- `MilestoneEscrowV2` gates on a **single immutable `authorizedOracle`** (`:802`), set by the
  escrow **deployer (PCC)** at construction (`:365`).
- `ValidationRegistry` has `authorizeValidator`/`revokeValidator` — but **`onlyAdmin`** (`:77`),
  single-validator `attest()`, **no quorum, no stake, no slash**. An admin allowlist.
- The oracle signer key: if generated by a PCC deploy session, it is **PCC-in-a-hat**.

### Target — phased

**Phase A — independence (no consensus change):**
- The oracle **signer key + EAS schema live in the oracle repo** (`C:\Users\globa\pcc-oracle`),
  not PCC. Rename schema `pcc.evidence.v1` → `oracle.evidence.v1`; register it from the oracle
  repo's own deploy script, not `packages/contracts/script/RegisterEASSchema.s.sol`.
- `authorizedOracle` resolves from an **oracle-controlled registry** (or a canonical oracle
  address the oracle entity controls), so PCC isn't choosing the verifier per-deploy.

**Phase B — decentralization (m-of-n, economic security):**
- Evolve `ValidationRegistry` into a **staked verifier set**: add `stake`/`bond` per validator,
  a `quorum` threshold, and `slash` on proven-false attestation. Replace `onlyAdmin`
  authorize with **bond-to-join**.
- The escrow gate becomes **m-of-n**: instead of one `attester == authorizedOracle`, require
  ≥`quorum` distinct EAS attestations over the same `(jobId, stepId, evidenceBundleHash)` from
  registered, staked verifiers. (Aggregate off-chain into one EAS UID via a BLS/threshold sig,
  or submit N UIDs and count.)
- Or **adopt** an external AVS: register PCC verification as an **EigenLayer AVS** (or consume
  **Eoracle**), inheriting restaked crypto-economic security + a slasher, instead of building one.

### Reference (Phase B escrow gate sketch)
```solidity
// replace: require(a.attester == authorizedOracle, "Wrong attester");
require(verifierRegistry.isStakedVerifier(a.attester), "Not a staked verifier");
m.attesters.push(a.attester);                              // dedup distinct attesters
require(distinctCount(m.attesters) >= verifierRegistry.quorum(), "Quorum not met");
```

### SOTA-correct
This is exactly the EigenLayer-AVS trajectory (restaked, slashable, m-of-n). The existing
challenge-window/dispute path is already the **UMA optimistic-oracle** backstop — keep it as
the economic dispute layer over the quorum.

### Owning lane / risk
**Contracts + oracle lanes.** Phase A is mostly oracle-repo + a registry-resolution tweak
(low risk, additive). Phase B is a **redeploy** (V3 escrow + staked registry) — gate behind
the same V2→V3 cutover as Concern 1. Single-oracle is the transitional state; design the
schema/fee so they survive the move to a committee (they do — attester set is additive).

---

## Concern 3 — Observability: oracle-side + participant-scoped

### Current
- **Evidence encryption exists**: `routes/evidence-encrypted.ts` + `createLitEncryptionService()`
  (`services.ts:174`, real/mock via `LIT_PROTOCOL_REAL`). Network is runtime-configurable
  (`litNetwork` logged at `evidence-encrypted.ts:28`).
- **SSE auth exists but defaults OFF**: `SSE_AUTH_REQUIRED` default `false` (`sse-auth.ts:27`);
  when unset, `resolveSSEAuth` returns `{authenticated:true}` with no userId → everyone passes,
  no per-job scoping.
- PCC telemetry (`telemetry.ts`) records everything including `evidence_encrypt`.

### Target
1. **Flip + scope SSE.** Set `SSE_AUTH_REQUIRED=true` in the live gateway env, and extend
   `resolveSSEAuth` so a job stream authorizes **only the job's buyer + operator** (match the
   authenticated identity against the job's two parties), not just "any authenticated user."
   Reference:
   ```ts
   // sse-auth.ts — add per-resource scoping
   export async function authorizeJobStream(auth, jobId) {
     if (!auth.authenticated) return { ok: false, reason: "SSE_AUTH_REQUIRED" };
     const job = await jobs.get(jobId);
     const who = auth.userId?.toLowerCase();
     const ok = who === job.buyer?.toLowerCase() || who === job.operator?.toLowerCase();
     return ok ? { ok: true } : { ok: false, reason: "not a party to this job" };
   }
   ```
2. **Encrypt evidence by default.** Verified: the Lit service **already targets Chipotle**
   (`services.ts:178`, the current AI-agent-native network) — the network migration is
   essentially done. The only `datil` remnant is a **stale status label** at `status.ts:184`
   (`network: "datil-dev"`) to clean up. Remaining work: make evidence encryption the
   **default** (not opt-in) and set the access-control conditions to `{buyer, operator, oracle}`
   so **PCC stores only ciphertext** and cannot read job contents.
3. **Verification observability → the oracle repo's own stack.** The oracle daemon emits its
   own metrics/logs about what it verified; it does **not** report into PCC's `telemetry.ts`.
   PCC keeps only protocol/coordination telemetry (registry, settlement events) — never job
   contents.
4. **Analytics from on-chain outcomes, not contents.** Reputation derives from the EAS
   attestations themselves (pass/fail, tier — already public/aggregate on-chain via
   `ReputationRegistry`), and demand-intel stays opt-in/aggregate. PCC never reads a job to
   score an operator. Endgame: **ZK process attestation** so the oracle proves "tier met"
   without revealing evidence at all.

### Owning lane / risk
**Gateway lane** (SSE flip+scope, Lit network verify/migrate, encrypt-by-default) is the most
**safe-additive** of the three — flags + an additive scoping function, no contract redeploy.
**Oracle lane** owns moving verification telemetry off PCC.

---

## Tensions (decide deliberately)

1. **PCC revenue.** Oracle-set fee **de-rents PCC** (the vision). PCC still needs sustainability:
   (a) take nothing (pure protocol), (b) a tiny **immutable** protocol fee in an unowned
   contract, or (c) the oracle remits a transparent slice. Pick one — don't leave it implicit.
2. **"The oracle" can't be a LamaSu key forever.** A single PCC-affiliated oracle is centralized,
   relabeled. The endgame is the **staked verifier set** (Concern 2 Phase B). Single-oracle is
   transitional; the schema/fee/attester-set design must survive the committee move (it does).
3. **Analytics without surveillance.** PCC loses the job-contents firehose. Reputation from
   on-chain outcomes is enough and *more* credible (verifiable, not self-reported). Demand-intel
   gets coarser — that's the price of not being a panopticon, and it's the right price.

---

## Handoff matrix

| Change | Lane | Safe-additive vs redeploy | Phase |
|---|---|---|---|
| Fee in attestation (schema + escrow decode/release) | contracts | redeploy (V3 escrow + schema v2) | with V2→V3 cutover |
| Deprecate `setProtocolFeeBps` for settlement | contracts | additive (route via `collectFeeWithAttestation`) | with above |
| Oracle owns key + schema; registry-resolved oracle | oracle + contracts | mostly additive (Phase A) | now |
| Staked m-of-n verifier set + quorum gate | contracts | redeploy (Phase B) | after Phase A |
| SSE flip + per-job participant scoping | gateway | **safe-additive** (env flag + scoping fn) | **now** |
| Lit already on Chipotle; clean stale `datil-dev` label + encrypt-by-default + ACL={buyer,operator,oracle} | gateway | safe-additive | **now** |
| Verification telemetry → oracle repo | oracle | additive | now |
| Reputation from on-chain outcomes (+ ZK endgame) | gateway + contracts | additive then redeploy | staged |

**Coordination:** posted to coord for the contracts / oracle / gateway lanes. The two **now /
safe-additive** items (SSE scope, Lit-network) can land without touching the live escrow; the
fee + m-of-n changes ride the next escrow version cutover so the live V2 stack is never edited
in place.

---

## Reinforces the CDP lane

Same principle drove the earlier recommendation: **PCC should custody, set fees, and observe
only what it strictly must.** The CDP `walletMode:"self"` self-sovereign opt-in is the wallet-layer
expression of exactly this sovereignty stance.
