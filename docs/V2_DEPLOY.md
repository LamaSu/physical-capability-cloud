# V2 Deploy Runbook

End-to-end recipe for cutting over from the V1 mock-settlement loop to the
real V2 substrate: EAS-gated escrow + real oracle attestations + real
compose execution.

> **Pre-deploy confidence**: run `bash scripts/smoke-v2.sh` against a local
> gateway first. It boots the V2 loop with mocks (no chain, no Railway) and
> verifies the agent-card, A2A skills, CSD endpoints, and operator-status
> wiring all respond correctly. Green smoke = green to start this runbook.
>
> Companion docs: `docs/DEPLOY.md` (build-once / deploy-many pipeline,
> Railway env mapping, Conventional Commit + release-please rules) and
> `docs/WORKFLOW_RUNTIME.md` §5.1 (volume mount for the workflow SQLite
> file — required before `PCC_COMPOSE_EXECUTE_REAL=true`).

## Prerequisites

- **Foundry installed** (`forge --version` ≥ 0.2.0). `curl -L https://foundry.paradigm.xyz | bash && foundryup`.
- **`cast` available** (ships with foundry).
- **Base Sepolia RPC URL** with a funded deployer (`https://sepolia.base.org` works; Alchemy/Infura URLs are faster).
  - Faucet ETH: https://www.alchemy.com/faucets/base-sepolia
- **Railway CLI authenticated** to the LamaSu project (`railway login` then `railway link` → `diplomatic-compassion`).
  - Note: as of `docs/DEPLOY.md` writing, the CLI does NOT support swapping a service's image source on an existing environment. Env var changes work via CLI (`railway variables set FOO=bar`), but image-source swaps must be done in the Railway UI.
- **Canonical `pcc-oracle` repo cloned** with the EAS-minting branch merged (the repo at `LamaSu/pcc-oracle` HEAD as of June 14, 2026). This is the service that signs evidence attestations onto EAS.
- **EAS schema not yet registered** for `pcc.evidence.v1`. If it already is (someone ran it before), record the UID and skip step 2 — re-registering the same triple reverts with `AlreadyExists` per `RegisterEASSchema.s.sol:24`.

### Required env vars (kept on your local machine, not committed)

```bash
# Funded deployer wallet on Base Sepolia
export DEPLOYER_PRIVATE_KEY=0x...

# Funded oracle signer wallet — same key the prod oracle service will use
# (derived from PCC_GATEWAY_PRIVATE_KEY on Railway, see step 3)
export PCC_GATEWAY_PRIVATE_KEY=0x...

# Oracle verifier address (V1 parity, also defaults the EAS attester)
export ORACLE_VERIFIER_ADDRESS=0x...     # same address as cast wallet $PCC_GATEWAY_PRIVATE_KEY

# RPC + Etherscan
export RPC=https://sepolia.base.org
export ETHERSCAN_API_KEY=<your-basescan-key>
```

## Step 1: Deploy V2 contracts (gated, on-chain)

PR #119 (`a4a71b1`) enables solc optimizer (runs=200) so V2 contracts fit
EIP-170. Deploy from master AFTER that PR.

```bash
cd packages/contracts

# Register the EAS schema FIRST — its UID is an immutable on PCCProtocolV2
# (so the schema must exist before the factory deploys).
forge script script/RegisterEASSchema.s.sol:RegisterEASSchema \
  --rpc-url $RPC \
  --broadcast -vvvv
```

Capture the printed schema UID from the logs:

```
--- pcc.evidence.v1 schema registered ---
0xabc123...    <- this is your PCC_EVIDENCE_SCHEMA_UID
```

Persist it for the next step and for Railway:

```bash
export PCC_EVIDENCE_SCHEMA_UID=0xabc123...

mkdir -p deployments/base-sepolia
cat > deployments/base-sepolia/eas-schema.json <<EOF
{
  "schemaUID": "$PCC_EVIDENCE_SCHEMA_UID",
  "registeredAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "txHash": "<paste tx hash from forge broadcast output>"
}
EOF
```

Now deploy V2 contracts. The schema UID is read from env and baked in as an
immutable; the script's `require(deployedSchemaUid == schemaUid)` read-back
hard-fails if anything mismatches (see `DeployProtocolV2.s.sol:111`).

```bash
forge script script/DeployProtocolV2.s.sol:DeployProtocolV2 \
  --rpc-url $RPC \
  --broadcast --verify --etherscan-api-key $ETHERSCAN_API_KEY \
  -vvvv
```

Capture the printed addresses:

```
PCCProtocolV2 deployed at: 0x...
--- Add to chain-config.ts ---
milestoneEscrowFactoryV2: 0x...
```

Record them under `deployments/base-sepolia/`:

```bash
cat > deployments/base-sepolia/v2-contracts.json <<EOF
{
  "chainId": 84532,
  "PCCProtocolV2": "0x...",
  "schemaUID": "$PCC_EVIDENCE_SCHEMA_UID",
  "EAS": "0x4200000000000000000000000000000000000021",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
```

Verify the factory baked in the right schema UID off-chain too:

```bash
cast call $PCCPROTOCOLV2_ADDR "pccEvidenceSchemaUid()(bytes32)" --rpc-url $RPC
# Should print exactly $PCC_EVIDENCE_SCHEMA_UID
```

> **MilestoneEscrowV2 deployment**: V2 escrows are deployed PER-JOB by the
> factory's `createEscrowV2(payer, arbiter, token, cwmId)`. There is no
> single "MilestoneEscrowV2 address" to record — each job's escrow lives
> at a unique address minted by the factory. The factory IS the canonical
> on-chain entry point, hence the chain-config name
> `milestoneEscrowFactoryV2`.

## Step 2: Verify `authorizedOracle`

V2 child escrows bake in the `authorizedOracle` address at construction
time, threaded from the factory's `easOracle` immutable (which was set
from `EAS_ORACLE_ADDRESS` env, defaulting to `ORACLE_VERIFIER_ADDRESS` —
see `DeployProtocolV2.s.sol:57-59`).

The Railway oracle service (step 3) MUST sign attestations as that same
address. The address is derived from `PCC_GATEWAY_PRIVATE_KEY` on Railway.

Cross-check now:

```bash
# Off-chain: what address will the oracle sign as?
cast wallet address --private-key $PCC_GATEWAY_PRIVATE_KEY

# On-chain: what did the factory bake in?
cast call $PCCPROTOCOLV2_ADDR "easOracle()(address)" --rpc-url $RPC

# Both must match. If they don't, the entire release gate breaks — every
# attestation will fail "Wrong attester" (MilestoneEscrowV2.sol:802).
```

If they don't match, redeploy the factory with `EAS_ORACLE_ADDRESS`
explicitly set to the oracle signer's address (re-run step 1's
DeployProtocolV2 with the env override). The schema UID stays the same.

> **Sample escrow check** (optional but recommended): if you deployed with
> `DEPLOY_SAMPLE_ESCROW=1`, the script also asserts the sample escrow's
> `PCC_EVIDENCE_SCHEMA_UID()` matches the factory's. You can re-verify:
>
> ```bash
> cast call $SAMPLE_ESCROW "PCC_EVIDENCE_SCHEMA_UID()(bytes32)" --rpc-url $RPC
> cast call $SAMPLE_ESCROW "authorizedOracle()(address)"  --rpc-url $RPC
> ```

## Step 3: Deploy `pcc-oracle` to Railway

The oracle is a separate Railway service (not the gateway). It receives
verification requests from the gateway, runs its checks, and submits EAS
attestations signed by `PCC_GATEWAY_PRIVATE_KEY`. The gateway's release
gate then reads the attestation back via EAS UID and unlocks the
milestone.

Use the canonical `LamaSu/pcc-oracle` repo at the HEAD commit you've
already verified (EAS-minting branch is merged as of June 14, 2026).

### Env vars required on the oracle Railway service

| Env var | Value | Notes |
|---|---|---|
| `EAS_RPC_URL` | `https://sepolia.base.org` (or your faster RPC) | Same RPC the gateway uses |
| `PCC_EVIDENCE_SCHEMA_UID` | `0x...` from step 1 | Must match factory's immutable |
| `ESCROW_CONTRACT_ADDRESS` | `$PCCPROTOCOLV2_ADDR` from step 1 | The factory address |
| `PCC_GATEWAY_PRIVATE_KEY` | `0x...` | Signs EAS attestations; address must match `authorizedOracle` |
| `PCC_ORACLE_KEY` | a secret shared with the gateway | Bearer token the gateway sends on verify-request |

```bash
# In the pcc-oracle repo:
cd ~/projects/pcc-oracle    # or wherever your clone lives
railway link                # link to LamaSu/diplomatic-compassion project, oracle service
railway up                  # builds + deploys
```

After deploy, confirm the oracle is up:

```bash
ORACLE_URL=https://<oracle-railway-url>   # from `railway status` or Railway UI
curl -sf "$ORACLE_URL/health" && echo OK
```

> **Unknown**: the exact `railway up` flags depend on the oracle repo's
> `railway.toml` / service config. If `railway up` doesn't deploy to the
> oracle service, fall back to the Railway UI: project
> `diplomatic-compassion` → service `pcc-oracle` (or whatever it's
> named) → trigger a redeploy from the latest commit.

## Step 4: Flip gateway switches on Railway

The gateway service (`pcc-gateway` on Railway project
`diplomatic-compassion`) reads these env vars:

| Env var | Value | What it controls |
|---|---|---|
| `PCC_USE_EAS_V2` | `true` | Enables the V2 attestation-bridge path in `paid-job-flow.ts:72` |
| `MOCK_SETTLEMENT` | `false` | Required for real escrow interactions (`paid-job-flow.ts:63`) |
| `PCC_COMPOSE_EXECUTE_REAL` | `true` | Wires `/api/compose/execute` to real `@pcc/workflow` jobs (`compose.ts:615`) |
| `PCC_ORACLE_URL` | `https://<oracle-railway-url>` | From step 3 |
| `PCC_ORACLE_KEY` | matching shared secret from step 3 | Without it, oracle-client.ts falls back to mock |
| `PCC_EVIDENCE_SCHEMA_UID` | `0x...` from step 1 | Used by gateway's oracle-client encoder |
| `ESCROW_CONTRACT_ADDRESS` | `$PCCPROTOCOLV2_ADDR` from step 1 | The factory address |
| `WORKFLOW_DB_PATH` | `/data/workflow.sqlite` | SQLite path inside the mounted volume |

### Prerequisite: mount the Railway volume FIRST

`WORKFLOW_DB_PATH` points into a Railway volume. Per `docs/DEPLOY.md`
pending-follow-ups, before any consumer of `@pcc/workflow` ships, the
volume must be mounted on `pcc-gateway` in **both** staging and
production. Without this, every redeploy wipes in-flight workflow state.

Mount it via the Railway UI (CLI does not support volume creation on
existing services as of this writing): service `pcc-gateway` → Settings →
Volumes → Add Volume → mount point `/data` → Save.

### Set the env vars

```bash
railway environment use production    # or `staging` first; promote after smoke
railway service use pcc-gateway

railway variables set PCC_USE_EAS_V2=true
railway variables set MOCK_SETTLEMENT=false
railway variables set PCC_COMPOSE_EXECUTE_REAL=true
railway variables set PCC_ORACLE_URL=https://<oracle-railway-url>
railway variables set PCC_ORACLE_KEY=<shared-secret>
railway variables set PCC_EVIDENCE_SCHEMA_UID=0x...
railway variables set ESCROW_CONTRACT_ADDRESS=0x...
railway variables set WORKFLOW_DB_PATH=/data/workflow.sqlite
```

> **Unknown**: as of June 14, 2026, `railway variables set` syntax in the
> CLI is the documented form per Railway docs
> (https://docs.railway.com/reference/cli-api), but specific flag
> behavior on multi-env projects has flipped between releases. If
> `railway variables set` errors, fall back to:
> `railway open` → Variables tab → paste keys and values manually.

### Redeploy

```bash
railway redeploy        # picks up the new env on the latest image
```

The image itself does not need rebuilding — V2 is gated entirely by env
vars, exactly as the build-once/deploy-many model assumes (per
`docs/DEPLOY.md` §"Rules when touching CI/CD or Dockerfile"). Promote
from staging to prod via the existing `Deploy to Prod` workflow_dispatch
(per `docs/DEPLOY.md`), not by re-deploying the gateway tag directly.

## Step 5: Smoke

Run the V2 smoke test against the freshly-flipped gateway:

```bash
# Against staging FIRST
PCC_BASE=https://<staging-railway-url> SKIP_BOOT=true bash scripts/smoke-v2.sh

# Then against prod after staging is verified
PCC_BASE=https://capability.network SKIP_BOOT=true bash scripts/smoke-v2.sh
```

The smoke script verifies the V2 surface: agent-card shows 8 skills, A2A
`pcc-author-integration` kernels a real operator end-to-end, status loop
returns `ready`/`partial`. It does NOT trigger real EAS attestations —
that requires running an actual paid-job-flow.

### Verify the live V2 path end-to-end

After the smoke is green, run one real `pcc-author-integration` against
the live gateway and follow it through to settlement:

```bash
# 1. Provision a key + author a test operator (the smoke script does this in mocked mode)
# 2. Submit a real job against the operator
# 3. Confirm the gateway's oracle-client posts to the oracle and gets a signed attestation
# 4. Confirm the attestation hits EAS:
#    cast call $EAS "getAttestation(bytes32)" $ATTESTATION_UID --rpc-url $RPC
# 5. Confirm the escrow release succeeds (the milestone transitions from active → released)
```

Tail the oracle status endpoint to verify the signing address matches:

```bash
curl -s https://capability.network/api/oracle/status | jq '.signingAddress'
# Should equal `authorizedOracle` from step 2's cast call.
```

## Rollback

The V2 cutover is reversible at three layers, in order of speed (fastest first):

1. **Env-toggle (instant)** — flip `MOCK_SETTLEMENT=true` on Railway, redeploy.
   Falls back to V1 mock-settlement loop. Use this as the kill-switch if
   anything goes wrong post-cutover.

2. **Oracle service rollback** — if the oracle is producing bad
   attestations, redeploy the oracle service to a previous Railway build
   via the Railway UI (service `pcc-oracle` → Deployments → Promote a
   prior deployment). The gateway will fall back to mock once
   `PCC_ORACLE_KEY` is removed or the oracle service URL becomes
   unreachable (`oracle-client.ts:73`).

3. **Contract rollback (irreversible — needs redeploy)** — if the
   `authorizedOracle` was baked in wrong or the schema UID is wrong, the
   V2 factory cannot be patched. Redeploy a new `PCCProtocolV2` with
   corrected immutables (step 1 again with `EAS_ORACLE_ADDRESS` set
   correctly), record the new address, and update
   `ESCROW_CONTRACT_ADDRESS` on Railway (step 4). The old factory
   remains on-chain — there's no destroy/upgrade mechanism — but no new
   jobs will route through it.

## Common failure modes

- **`Wrong attester` revert on milestone release**: the address that signed
  the EAS attestation does not equal the escrow's `authorizedOracle`
  immutable (MilestoneEscrowV2.sol:802). Re-check step 2; the oracle's
  `PCC_GATEWAY_PRIVATE_KEY` and the factory's `easOracle` must produce
  the same address.

- **`Schema UID mismatch` at deploy time**: the env `PCC_EVIDENCE_SCHEMA_UID`
  doesn't match what was registered. Re-derive: the on-chain UID is
  `keccak256(abi.encodePacked(SCHEMA_STRING, address(0), true))` where
  SCHEMA_STRING is the exact byte string from `RegisterEASSchema.s.sol:52`.

- **`AlreadyExists` on RegisterEASSchema**: someone already registered the
  same schema string. Look up the existing UID on-chain via Etherscan
  (search the SchemaRegistry contract at
  `0x4200000000000000000000000000000000000020` for a `Registered` event
  with your schema string) and use that UID; do NOT try to re-register.

- **Gateway boots but returns mock attestations after V2 flip**:
  `PCC_ORACLE_KEY` is empty or not propagated. The oracle-client falls
  back to mock when the key is missing (`oracle-client.ts:73`). Verify
  the env var landed: `railway variables get PCC_ORACLE_KEY`.

- **Compose execute hangs after `PCC_COMPOSE_EXECUTE_REAL=true`**: workflow
  store cannot open SQLite at `WORKFLOW_DB_PATH`. Confirm the volume is
  mounted (`railway logs | grep -i 'workflow.*sqlite\|EACCES\|ENOENT'`).
  See `docs/WORKFLOW_RUNTIME.md` §5.1.

## References

- Smoke test: `scripts/smoke-v2.sh`
- V2 contracts: `packages/contracts/src/PCCProtocolV2.sol`, `packages/contracts/src/MilestoneEscrowV2.sol`
- Deploy scripts: `packages/contracts/script/DeployProtocolV2.s.sol`, `packages/contracts/script/RegisterEASSchema.s.sol`
- Gateway V2 gates: `packages/gateway/src/routes/paid-job-flow.ts` (`isV2Enabled()`), `packages/gateway/src/routes/compose.ts` (`PCC_COMPOSE_EXECUTE_REAL`), `packages/gateway/src/services/oracle-client.ts`
- Build-once / deploy-many runbook: `docs/DEPLOY.md`
- Workflow runtime: `docs/WORKFLOW_RUNTIME.md`
