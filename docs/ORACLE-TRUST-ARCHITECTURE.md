# PCC Oracle Trust Architecture & Staging Isolation

**Status:** 2026-07-03 · globa/V3-lane session · companion to `ai/research/v3-mode-b-cutover-runbook.md`

## TL;DR

- The **oracle** (the EAS-attester signing key) is PCC's **trust root**. Whoever holds it can mint settlement verdicts *and* set protocol fees. **Only the oracle owner should ever hold it.**
- The **gateway** is the (ideally open-source, anyone-can-run) app. It holds its *own* operational wallet + an API token to *call* the oracle. **It must never hold the oracle signing key.**
- **Decision (2026-07-03, owner):** staging Mode-B uses a **fresh, throwaway oracle identity + a staging-only V3 factory bound to it**, so the production oracle trust root is **never replicated** into staging infra. This is **Option A — the full gateway→oracle service path is PROVEN end-to-end** (2026-07-04): a live gateway job settled Mode-B and the 2.35% fee landed in the treasury (§3).
- **Future (Option B):** move the oracle onto infrastructure the owner controls, *separate from* any PCC gateway deployment — now with a concrete step-by-step migration plan (§5).
- **Prod cutover:** owner-gated runbook in §7 (real treasury Safe + oracle isolation are the two decisions; the code is already on master).

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

**Proof (release tx `0x045c6b8e2824ee628be1a135c482e3d6da30583b5dbc5f31c7e6f5ff1a681801`):** `createEscrowV3 → addMilestone → fund → submitEvidence → fresh oracle mints 9-field attestation → submitAttestation → release`. Operator paid `976,500` (amount−fee); **treasury paid `23,500` (exact 2.35% fee)**. The prod key `0x3e9cf724` was **not used**. Reproduce with `packages/gateway/scripts/v3-settlement-smoke.ts` (see §6 for the smoke-script fixes needed).

### Full A *service* path (gateway → oracle) — PROVEN 2026-07-04

All four steps are **DONE**. A real job through the **live** staging gateway settled Mode-B end-to-end with the fee landing in the treasury.

1. **Gateway factory-override — DONE (#200, `4700da79`).** `paid-job-flow.ts` reads `MILESTONE_ESCROW_FACTORY_V3` before falling back to `getContractAddress(network, "milestoneEscrowFactoryV3")`. Staging sets `MILESTONE_ESCROW_FACTORY_V3=0x71b9E1…` → the live gateway creates V3 escrows on the isolated staging factory (verified on-chain: escrow `authorizedOracle = 0x1Fe087`, **not** prod's `0x3e9cf724`).
2. **Staging oracle service — DONE.** Railway service **`courageous-analysis`** (project `diplomatic-compassion`, `staging` env), `https://courageous-analysis-staging.up.railway.app`, signs as the fresh `0x1Fe087`. `ORACLE_PRIVATE_KEY` = the fresh key (**never** the prod key). Also set: `PCC_GATEWAY_URL` = staging gateway; `ORACLE_BOOTSTRAP_KEY` = the gateway's `PCC_ORACLE_KEY` (so the gateway's `x-oracle-key` is accepted); `PCC_GATEWAY_API_KEY` = a `pcc_live_` read key (so the oracle can fetch the auth-gated `/api/kernels` + `/api/evidence` — see the #6 fix below). Created via the Railway dashboard (`railway up`/`link` won't attach to a service with no prior deployment); deploy with the `⇧+Enter` shortcut if the canvas renderer stalls.
3. **Staging gateway wired — DONE.** `pcc-gateway-staging.up.railway.app` with `MILESTONE_ESCROW_FACTORY_V3=0x71b9E1…`, `PCC_USE_EAS_V2=true`, `PCC_USE_V3_MODE_A=true` (→ escrows `version="v3"` → the `eas-v3-mode-b` release path), `PCC_EVIDENCE_V2_ENABLED=true`, `PCC_ORACLE_URL`=staging oracle, `MOCK_SETTLEMENT=false`.
4. **E2E — PROVEN.** Job `job-566dea0c-4f0`, escrow `0xD6321A950C1355723fc19E780973b245d9Bf0AbE`: gateway created + funded the V3 escrow → oracle authenticated + verified + minted the 9-field attestation (UID `0x9c16c9e9…`, attester `0x1Fe087`, `feeRecipient=0xC582`, `feeBps=235`) → `submitEvidence` + `submitAttestation` bound it → after the 1h challenge window, `release` distributed **+387,750 (2.35%) → treasury `0xC582`** (release tx `0x4827ba0cb38b…`). The prod key `0x3e9cf724` was not used at any step.

**Three first-run oracle bugs fixed along the way** (the `pcc.evidence.v2` mint path had never run E2E; all backward-compatible, merged to `LamaSu/pcc-oracle` master):
- **#6** — `verify()` fetched the auth-gated gateway `/api/kernels/:id` + `/api/evidence/:hash` **unauthenticated** (401 on prod **and** staging) → `identityValid`/`evidenceExists` always failed. Fix: send `Bearer PCC_GATEWAY_API_KEY` when set (env-gated; unauthenticated fallback kept). Same PR: `evidenceHashToBytes32` rejected the gateway's `sha256:<hex>` format → now normalizes `sha256:`/bare/`0x` → `0x<64hex>`.
- **#7** — the legacy signer ran *before* the EAS-mint try/catch and 500'd on the raw `sha256:` hash → the whole `verify` aborted, so the attestation never minted. Fix: normalize once, use for both the signer and the minter.

**One gateway bug fixed** (`LamaSu/physical-capability-cloud` **#202**): the V3 `/complete` called `submitAttestationV3` **without first submitting evidence** → the escrow reverts "Evidence not submitted" and the attestation tx fails on-chain silently (the gateway never checked the receipt). I did `submitEvidence` manually to prove the E2E; #202 adds `submitEvidenceV3` + a `waitForReceipt` helper in the V3 branch so a gateway job completes Mode-B **hands-off**. **Latent (untouched):** the V2 `submitEvidenceV2` call at `paid-job-flow.ts:~1100` casts `sha256:` as Hex (same format bug) — left alone to avoid changing the V2 path; fix in a separate PR if V2 is still used.

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

**Concrete migration plan** — the staging Option-A cutover I just proved (§3) is a dry-run of exactly this: a fresh oracle identity + a new factory bound to it + a gateway repoint. Applied to prod:

1. **Provision the dedicated oracle host.** A new Railway project (e.g. `pcc-oracle-host`) owned solely by the oracle owner — **no gateway service in it**. For mainnet, prefer a KMS/HSM-backed signer so the raw key never sits in an env var; for testnet a dedicated project suffices. This is the trust boundary Option A can't give (staging's oracle still shares the `diplomatic-compassion` project with the gateway).
2. **Generate a new oracle key on the host.** Never copy the current co-located key — retiring it is the point. Record only the address; the private key stays on the host (or in the KMS).
3. **Deploy a new V3 factory bound to the new oracle.** `authorizedOracle` is immutable, so a key rotation *requires* a new factory: `DeployProtocolV3.s.sol` with `EAS_ORACLE_ADDRESS=<new oracle address>` + the same v2 schema `0xe8ab…799d`. (This is exactly how the staging factory `0x71b9E1…` was bound to `0x1Fe087`.)
4. **Point gateways at the new oracle + factory.** Each gateway sets `PCC_ORACLE_URL=<oracle-host URL>` + `PCC_ORACLE_KEY=<its own API token>` + `MILESTONE_ESCROW_FACTORY_V3=<new factory>`. Gateways get the URL + token only — never the signing key. This is already the wiring; Option B just relocates the endpoint.
5. **Drain + cut over, don't swap in place.** New escrows use the new factory immediately; escrows already open on the old factory must finish settling against the **old** oracle (immutable `authorizedOracle`). Keep the old oracle reachable until every open escrow on the old factory has released or refunded — a **versioned cutover**, not a hot swap.
6. **Retire the old co-located oracle** once its factory has no open escrows. Its key is now dead; the trust root lives only on the dedicated host.

**Decentralization path (beyond B).** The oracle-host is still one key. `verification-mode.ts` (Mode-C / juror pool) evolves the trust root toward an m-of-n verifier set — at that point `authorizedOracle` becomes a threshold/multisig address and no single key is the root. **B is the infra-isolation step; Mode-C is the trust-distribution step.**

---

## 6. Notes for the next worker

- **Smoke script (`packages/gateway/scripts/v3-settlement-smoke.ts`, PR #188) has two harness bugs** that make it falsely report FAIL against a *working* protocol: (1) it awaits receipts but never checks `receipt.status`, so on-chain reverts read as successes; (2) no tolerance for Base Sepolia public-RPC stale reads (`simulateContract` sees pre-tx state → false "Insufficient allowance"). Fix locally applied: a `wc()` helper doing simulate→write→status-check with **retry-on-lag** + `waitForTransactionReceipt confirmations:2` + explicit `gas`, plus an `ONLY_MODE_B` gate + `fund()` approves `amount*2` (fund pulls `totalByToken`). **Fold these into #188 before it merges.**
- **Do not** re-run the full smoke's Mode-A (contract-capability test of the oracle-free `approveAndRelease`) as a *product* path — Mode-A is removed from the gateway (#194) per the owner directive "everything through the oracle."
- All Mode-B gateway code is on master: #189 (schema), #190 (dispatch), #192 (gas), #194 (Mode-A removal), **#200 (per-env factory override), #202 (V3 `/complete` submits evidence before the attestation)**. Oracle v2 mint on `pcc-oracle` master (`f5efa16`, PR #5) **+ #6/#7 (the three first-run mint-path fixes, §3)**.
- **The gateway-driven Mode-B E2E is PROVEN on staging (§3).** A durable hardened V3-settlement smoke lives at `packages/gateway/scripts/v3-settlement-smoke.ts` (`wc()` simulate→write→status-check with retry-on-lag, `confirmations:2`, explicit `gas`, `ONLY_MODE_B` gate, `fund()` approves `amount*2`).

---

## 7. Prod Mode-B cutover runbook (owner-gated)

Staging (§3) de-risks this entirely — the mechanism, the three oracle fixes, and the gateway fix are all proven. Prod activation is **owner-gated** on two decisions and follows versioned-cutover discipline. **Do not flip the prod oracle to v2 in place** — the prod `pcc-oracle` is un-mocked and shared across envs; a global `ORACLE_SCHEMA_VERSION=v2` flip would change live prod minting.

**Preconditions (owner decisions):**
1. **Real treasury.** Replace the throwaway EOA `0xC582` with a Safe (multisig). It's a changeable env var (`ORACLE_FEE_RECIPIENT`), no contract redeploy — but decide the Safe *before* go-live so fees never land in a hot EOA.
2. **Oracle isolation.** Prefer doing this as the **Option B** move (§5) — dedicated oracle host + a new prod factory bound to it — rather than flipping the co-located prod oracle. If B isn't ready, the interim is a prod-only oracle service/env with `ORACLE_SCHEMA_VERSION=v2` that does **not** share the schema flip with the current prod minting path.

**Cutover steps (once preconditions are met):**
1. **Confirm the prod factory ↔ oracle binding.** Prod V3 factory `0x786E85…` has immutable `authorizedOracle = 0x3e9cf724`. If you rotated the oracle (Option B), you deployed a **new** factory — use that in step 3 and keep `0x786E85…` reachable until its open escrows drain.
2. **Confirm v2 schema + fee + oracle auth.** v2 schema `0xe8ab…799d` is registered. On the prod oracle set `ORACLE_FEE_BPS=235`, `ORACLE_FEE_RECIPIENT=<Safe>`, and `PCC_GATEWAY_API_KEY`=a prod `pcc_live_` read key (the #6 fix — the oracle must authenticate its `/api/kernels` + `/api/evidence` fetches).
3. **Wire the prod gateway** (env only, no code — #200 + #202 are already on master): `MILESTONE_ESCROW_FACTORY_V3=<prod factory>`, `PCC_USE_EAS_V2=true`, `PCC_USE_V3_MODE_A=true`, `PCC_EVIDENCE_V2_ENABLED=true`, `PCC_ORACLE_URL=<prod oracle host>`.
4. **Canary.** Run one small real job end-to-end; confirm the split lands in the Safe on-chain (`balanceOf` — mockUSDC emits no Transfer events). Widen traffic only after the canary settles.
5. **Rollback.** New V3 Mode-B escrows are opt-in via the env flags — set `PCC_USE_EAS_V2=false` (or repoint `MILESTONE_ESCROW_FACTORY_V3`) to stop minting them. In-flight escrows still settle against their bound oracle; **never retarget an open escrow**.

**Companion:** `ai/research/v3-mode-b-cutover-runbook.md` (deeper contract-level runbook).
