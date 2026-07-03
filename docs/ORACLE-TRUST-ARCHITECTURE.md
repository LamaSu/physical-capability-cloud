# PCC Oracle Trust Architecture & Staging Isolation

**Status:** 2026-07-03 · globa/V3-lane session · companion to `ai/research/v3-mode-b-cutover-runbook.md`

## TL;DR

- The **oracle** (the EAS-attester signing key) is PCC's **trust root**. Whoever holds it can mint settlement verdicts *and* set protocol fees. **Only the oracle owner should ever hold it.**
- The **gateway** is the (ideally open-source, anyone-can-run) app. It holds its *own* operational wallet + an API token to *call* the oracle. **It must never hold the oracle signing key.**
- **Decision (2026-07-03, owner):** staging Mode-B uses a **fresh, throwaway oracle identity + a staging-only V3 factory bound to it**, so the production oracle trust root is **never replicated** into staging infra. This is **Option A — PROVEN on-chain** (§3).
- **Future (Option B):** move the oracle onto infrastructure the owner controls, *separate from* any PCC gateway deployment (§5).

---

## 1. Trust model

| Actor | Key / identity | Power | Who holds it |
|---|---|---|---|
| **Oracle** (EAS attester) | `ORACLE_PRIVATE_KEY` | Signs `pcc.evidence.v2` attestations → authorizes milestone release **and** sets `feeBps`/`feeRecipient`. **The trust root.** | **Oracle owner ONLY** |
| **Gateway** | `PCC_GATEWAY_PRIVATE_KEY` (operational wallet) + `PCC_ORACLE_KEY` (API token to call the oracle) | Creates escrows, submits txs. **Cannot forge attestations.** | Anyone running a gateway (their own) |
| **Deployer** | `DEPLOYER_PRIVATE_KEY` | Deploys contracts | Whoever deploys |
| **Treasury** | `ORACLE_FEE_RECIPIENT` (an address, not a role) | *Receives* fees. Never signs anything. | Owner (a Safe, ideally) |

**Why this matters:** the whole PCC value prop is "anyone can host a gateway; only the oracle owner attests reality." If the oracle key ever co-locates with the open-source gateway, that separation collapses. The gateway↔oracle split must be real at the infrastructure boundary, not just the code boundary.

---

## 2. Current on-chain + infra state (2026-07-03)

**Production (untouched, do not disturb):**
- Prod oracle (trust root) `0x3e9cf724f848908fC172a075F3219746126cD319` — lives in Railway project `diplomatic-compassion` / **staging+production** envs / **`pcc-oracle`** service. Mints the current prod schema `0x5acb07db…`. **Prod is UN-MOCKED** (`MOCK_SETTLEMENT=false`) — it settles for real. **DO NOT flip the prod oracle to v2** (global switch; would change prod minting).
- Prod V3 factory `0x786E85B17B288115E2F9230868e0BC94cBff5534` (immutable `authorizedOracle = 0x3e9cf724`).
- v2 EAS schema (9-field, fee-carrying) `0xe8ab02ed505e16fd6c89cc11e9f541ed1448e9c7dead1c6c3df2bb89033b799d` — registered on Base Sepolia.
- mockUSDC (base-sepolia, chain-config) `0x18bef3dee9f4f97f7cec16db0c4a0a930f478470` (symbol `mUSDC`; **does NOT emit ERC20 Transfer events** — use `balanceOf` as ground truth).

**The co-location smell (what Option B fixes):** `pcc-oracle` and `pcc-gateway` are separate *services* but share one Railway *project* (`diplomatic-compassion`). One project = one access boundary. The trust root shouldn't share a boundary with the anyone-can-run gateway.

---

## 3. Option A — staging with an isolated oracle (PROVEN)

The prod V3 factory hardcodes `authorizedOracle = 0x3e9cf724`, so any escrow it mints only accepts *prod-oracle* attestations. To get Mode-B on staging **without** replicating the prod key, we deployed a **staging-only factory bound to a fresh oracle key**.

**Deployed for staging (2026-07-03):**
- **Fresh staging oracle** `0x1Fe087A578F0F315F5af2cCF3B6D4b214E69c9Ab` — throwaway testnet identity. Key file: `C:\Users\globa\.pcc-staging-oracle\staging-oracle.key` (raw 0x key, restrict access; never checked into git).
- **Staging V3 factory** `0x71b9E1AbF447574F6df52B4468BC12a45692AD2a` — immutable `authorizedOracle = 0x1Fe087…`. Deployed via `DeployProtocolV3.s.sol` with `EAS_ORACLE_ADDRESS=0x1Fe087…`, `PCC_EVIDENCE_V2_SCHEMA_UID=0xe8ab…799d`.
- **Treasury (fee recipient)** `0xC582a2E56F8F3f569bDe5E9a8b9EdF8F379c7702` — fresh EOA, **no protocol role**. Key file: `C:\Users\globa\.pcc-treasury\treasury-eoa.key`. Migrate to a Safe for mainnet-scale (it's a changeable oracle env var).

**Proof (release tx `0x045c6b8e2824ee628be1a135c482e3d6da30583b5dbc5f31c7e6f5ff1a681801`):** `createEscrowV3 → addMilestone → fund → submitEvidence → fresh oracle mints 9-field attestation → submitAttestation → release`. Operator paid `976,500` (amount−fee); **treasury paid `23,500` (exact 2.35% fee)**. The prod key `0x3e9cf724` was **not used**. Reproduce with `scripts/v3-settlement-smoke.ts` (see §6 for the smoke-script fixes needed).

### Remaining for the full A *service* path (gateway → oracle, not just the script)

1. **Gateway factory-override (small code change / PR).** `getContractAddress(network, "milestoneEscrowFactoryV3")` (`packages/contracts/ts/chain-config.ts:266`) has **no per-env override**, and staging+prod are both `base-sepolia` → same factory. Add an env override, e.g. in `paid-job-flow.ts` where it resolves the V3 factory:
   ```ts
   const factoryAddrV3 = (process.env.MILESTONE_ESCROW_FACTORY_V3 as Address)
     ?? getContractAddress(network, "milestoneEscrowFactoryV3");
   ```
   Then staging sets `MILESTONE_ESCROW_FACTORY_V3=0x71b9E1…`. (Clean, testable, useful beyond staging.)
2. **Stand up the staging `pcc-oracle` service.** Currently **undeployed** (`railway deployment list -e staging -s pcc-oracle` → "No deployments found"). Configure its source (`LamaSu/pcc-oracle@master`, which has the v2 mint via PR #5 / `f5efa16`) + set `ORACLE_PRIVATE_KEY` = **the FRESH `0x1Fe087` key** (safe to set — not a prod credential) + deploy. The 8 non-secret vars are **already set** on it (`PCC_USE_EAS_V2=true`, `ORACLE_SCHEMA_VERSION=v2`, `ORACLE_EVIDENCE_V2_SCHEMA_UID=0xe8ab…`, `ORACLE_FEE_BPS=235`, `ORACLE_FEE_RECIPIENT=0xC582…`, `EAS_RPC_URL`, `EAS_ADDRESS`, `PCC_EVIDENCE_SCHEMA_UID`).
3. **Wire the staging gateway.** `MILESTONE_ESCROW_FACTORY_V3=0x71b9E1…` + `PCC_USE_EAS_V2=true` + `PCC_USE_V3_MODE_A=true` (this makes escrows `version="v3"` → the `eas-v3-mode-b` release path post-#194) + `PCC_EVIDENCE_V2_ENABLED=true` + `PCC_ORACLE_URL=https://pcc-oracle-staging.up.railway.app`. (`MOCK_SETTLEMENT=false`/`ORACLE_MOCK=false` already set.)
4. **E2E** one real job through the staging gateway → confirm the split lands in `0xC582…`.

---

## 4. Key custody summary

| Key | Address | Location | Sensitivity |
|---|---|---|---|
| Prod oracle (TRUST ROOT) | `0x3e9cf724…` | Railway `pcc-oracle`/prod ONLY | **MAX — never replicate** |
| Fresh staging oracle | `0x1Fe087…` | `C:\Users\globa\.pcc-staging-oracle\staging-oracle.key` | throwaway testnet |
| Treasury | `0xC582…` | `C:\Users\globa\.pcc-treasury\treasury-eoa.key` | receive-only; → Safe for mainnet |
| Gateway operational | `0xdDF4…` | Railway `pcc-gateway` | operational hot wallet |
| Deployer | `0x61B4…` | Railway (DEPLOYER_PRIVATE_KEY) | deploy-only |

**Rule:** keyed `forge`/`cast` ops run **locally** (`C:\Users\globa\.foundry\bin`). The auto-mode classifier blocks (a) relaying prod keys to shared Spark and (b) replicating a prod signing credential into a new secret store — both correct. Setting a *fresh* key (like `0x1Fe087`) into staging is fine.

---

## 5. Option B — oracle off `diplomatic-compassion` (future, the correct end state)

**Goal:** the oracle (trust root) runs on infrastructure the owner controls, with **no shared boundary** with any PCC gateway.

**Design:**
- **Dedicated oracle host** — a separate Railway project (or a KMS/HSM-backed signer service), owned solely by the oracle owner. The signing key lives only there. For mainnet: back it with a cloud KMS or hardware signer so the raw key never sits in an env var.
- **Gateways are clients.** A PCC gateway (open source, anyone-hosted) gets only an `ORACLE_URL` + an API token. It requests attestations; it never sees the signing key. This is *already* how the gateway is wired (`PCC_ORACLE_KEY` is an API token, `PCC_ORACLE_URL` is the endpoint) — Option B just relocates the oracle out of the gateway's project.
- **One oracle, many gateways.** The oracle is the shared trust root across every gateway. This is what makes "anyone can host a gateway" safe.
- **Decentralization path.** The single-key oracle is a stepping stone; the roadmap (Mode-C / juror pool, `verification-mode.ts`) evolves the trust root toward an m-of-n verifier set so no single key is the root forever.

**First concrete step:** create a dedicated Railway project (e.g. `pcc-oracle-host`), move the `pcc-oracle` service there, repoint every gateway's `PCC_ORACLE_URL` at it, and rotate the signing key during the move (so the old co-located key is retired). The V3 factory's `authorizedOracle` is immutable, so a key rotation means deploying a new factory bound to the new oracle address + migrating gateways to it — plan this as a versioned cutover, not an in-place swap.

---

## 6. Notes for the next worker

- **Smoke script (`scripts/v3-settlement-smoke.ts`, PR #188) has two harness bugs** that make it falsely report FAIL against a *working* protocol: (1) it awaits receipts but never checks `receipt.status`, so on-chain reverts read as successes; (2) no tolerance for Base Sepolia public-RPC stale reads (`simulateContract` sees pre-tx state → false "Insufficient allowance"). Fix locally applied: a `wc()` helper doing simulate→write→status-check with **retry-on-lag** + `waitForTransactionReceipt confirmations:2` + explicit `gas`, plus an `ONLY_MODE_B` gate + `fund()` approves `amount*2` (fund pulls `totalByToken`). **Fold these into #188 before it merges.**
- **Do not** re-run the full smoke's Mode-A (contract-capability test of the oracle-free `approveAndRelease`) as a *product* path — Mode-A is removed from the gateway (#194) per the owner directive "everything through the oracle."
- All Mode-B gateway code is on master: #189 (schema), #190 (dispatch), #192 (gas), #194 (Mode-A removal). Oracle v2 mint on `pcc-oracle` master (`f5efa16`, PR #5).
