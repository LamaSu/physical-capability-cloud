# ZeroDev / Bundler + Paymaster Setup (Gasless ERC-4337)

PCC upgrades EOA signers into ERC-4337 smart accounts so agents (and passkey
users) don't need to hold ETH for gas. This doc is the operator runbook for
configuring the **bundler + paymaster** half of that stack. The gateway is
provider-agnostic — ZeroDev, Coinbase CDP, Pimlico, Alchemy, or a self-hosted
bundler all work through the same env vars.

## Background — why ZeroDev

When PCC chose to build passkey onboarding (Option B: passkey → smart wallet →
gasless), **ZeroDev Kernel V3 + `@zerodev/passkey-validator`** was selected as the
account-abstraction vendor: it's the most polished passkey story on Base and ships
bundler + paymaster + passkey validator as one SDK (vs. Coinbase Smart Wallet,
which requires assembling more of the AA plumbing yourself, or Alchemy AA).

## Two halves — mind the boundary

| Half | What it is | Status |
|---|---|---|
| **1. Bundler + paymaster URLs** | Gas sponsorship + userOp submission for PCC's existing SimpleAccount infra (`/api/gasless/*`, batch settlement). | **Wired by this change** — set the env vars below. |
| **2. Kernel account + passkey validator** | The actual passkey signup flow via `@zerodev/sdk` + `@zerodev/passkey-validator` (Kernel V3 accounts, not SimpleAccount). | **Not included here** — a further SDK integration, gated on owner vendor sign-off. |

Setting the env vars below makes ZeroDev's bundler/paymaster usable by the
gateway's current gasless + batch-settlement paths. It does **not** by itself
implement passkey login — that's half 2.

## Step 1 — Create a ZeroDev project

1. Go to <https://dashboard.zerodev.app> and create a project.
2. Select the chain: **Base Sepolia** (chain id `84532`) for testnet, or **Base**
   (`8453`) for mainnet.
3. Add a **gas policy** (a per-day / per-op spend cap) so the paymaster sponsors
   user-operation gas: <https://docs.zerodev.app/meta-infra/gas-policies>.
4. Copy the **Bundler RPC URL** and **Paymaster RPC URL** the dashboard shows.
   (In ZeroDev v3 these are the same meta-AA endpoint:
   `https://rpc.zerodev.app/api/v3/<projectId>/chain/84532`.)

## Step 2 — Configure the gateway

Set these in the gateway environment (see `packages/gateway/.env.example`).
Configure **one** provider. Precedence, highest first: ZeroDev → generic `PCC_*`
→ legacy `BUNDLER_URL` → Coinbase CDP.

**Option A — ZeroDev (recommended).** Paste the exact URLs:

```bash
ZERODEV_BUNDLER_URL=https://rpc.zerodev.app/api/v3/<projectId>/chain/84532
ZERODEV_PAYMASTER_URL=https://rpc.zerodev.app/api/v3/<projectId>/chain/84532
```

…or just set the project id and let the gateway build the v3 URL (verify the
format against your dashboard — ZeroDev's URL shape can change across API
versions, so pasting the exact URLs is the safe path):

```bash
ZERODEV_PROJECT_ID=<your-zerodev-project-id>
BUNDLER_CHAIN=base-sepolia   # or base; defaults to PCC_NETWORK
```

**Option B — Generic (Pimlico / Alchemy / self-hosted):**

```bash
PCC_BUNDLER_URL=https://api.pimlico.io/v2/base-sepolia/rpc?apikey=<key>
PCC_PAYMASTER_URL=https://api.pimlico.io/v2/base-sepolia/rpc?apikey=<key>
```

**Option C — Coinbase CDP (one URL serves both):**

```bash
CDP_API_KEY=<cdp-api-key>
# or COINBASE_PAYMASTER_URL=<full-url>
```

## Step 3 — Which wallet do I fund?

You do **not** fund a wallet "inside ZeroDev." Two distinct things:

- **Paymaster balance** — funded through your ZeroDev gas policy / account. This
  sponsors user-operation gas, so the smart account itself needs **no ETH**.
- **Gateway operational EOA** (`PCC_GATEWAY_PRIVATE_KEY`) — signs batch settlement
  and any **non-sponsored** transactions. It needs a little Base-Sepolia ETH only
  if you run flows that aren't paymaster-sponsored. Faucet:
  <https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet>.

```bash
PCC_GATEWAY_PRIVATE_KEY=0x...   # required for batch settlement + counterfactual address
```

## Step 4 — Verify

```bash
curl -s $PCC_URL/api/gasless/status | jq
```

Expected once configured:

```json
{
  "bundlerConfigured": true,
  "paymasterConfigured": true,
  "paymasterProvider": "zerodev",
  "provider": "zerodev",
  "bundlerEndpoint": "https://rpc.zerodev.app/api/v3/***/chain/84532",
  "chain": "base-sepolia",
  "chainId": 84532,
  "entryPoint": "0.7",
  "features": { "gaslessOnboarding": true, "batchedTransactions": true, "sessionKeys": false }
}
```

The `bundlerEndpoint` is redacted (project id / API key masked) — safe to expose.

Then compute a counterfactual smart-account address:

```bash
curl -s -X POST $PCC_URL/api/gasless/onboard \
  -H "Authorization: Bearer $PCC_KEY" -H "Content-Type: application/json" \
  -d '{"signerAddress":"0xYourEoa"}' | jq
```

## Where this is implemented

- `packages/gateway/src/config/bundler-config.ts` — the env resolver (`resolveBundlerConfig`, `redactBundlerUrl`).
- `packages/gateway/src/routes/gasless.ts` — `/api/gasless/status` + `/onboard`, now provider-aware.
- `packages/gateway/src/contracts/batch-settlement.ts` — batch settlement, resolved bundler/paymaster.
- `packages/gateway/src/__tests__/bundler-config.test.ts` — resolver + redaction tests.

## Remaining for full passkey Phase B (half 2)

- Add `@zerodev/sdk` + `@zerodev/passkey-validator`, build Kernel V3 accounts with
  the passkey validator (owner sign-off on SDK + RP domain required).
- Server passkey verification via `@simplewebauthn/server`; browser via
  `@simplewebauthn/browser`.
- Fund the paymaster gas policy for live sponsored mints.
