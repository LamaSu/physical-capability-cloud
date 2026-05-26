# Universal Aggregator — Operator Guide

This document covers operating the universal tool aggregator
(`/api/aggregator/*` routes) in production: env vars, deployment, the
x402 micropayment gate, vendor pricing, testnet integration, and
troubleshooting.

For the underlying architecture and spec see:
- `ai/research/universal-tool-aggregator-2026-05-23.md` (parent scope)
- `ai/scoping/x402-aggregator-gating-2026-05-23.md` (x402 gate scope)

---

## 1. What the aggregator does

The aggregator is PCC's "catalog + receipt" surface. Vendors submit
tools (via `/api/aggregator/ingest/*`) or PCC crawls them. The
gateway proxies invocation calls (`/api/aggregator/invoke/:toolId`),
records a cryptographically-signed `InvocationReceipt` per call, and
optionally bills the caller per-call in USDC via the x402 protocol.

Free tools work without any payment infrastructure — the gate is
opt-in per-tool (via `pricing.perCallUsdc`) AND globally via env.

---

## 2. Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/aggregator/ingest/mcp` | admin | Ingest an MCP source (URL → tools/list → IndexedTool entries) |
| POST | `/api/aggregator/ingest/openapi` | admin | Ingest an OpenAPI document |
| GET | `/api/aggregator/tools/search` | public | Search the registry |
| POST | `/api/aggregator/invoke/:toolId` | public | Proxy a call + sign a receipt (x402-gated if priced) |
| GET | `/api/aggregator/receipts/:cid` | public | Fetch a persisted receipt |
| GET | `/api/aggregator/receipts/by-tool/:id` | public | Recent receipts for a tool |
| GET | `/api/aggregator/receipts/by-caller/:agentId` | public | Recent receipts for a caller |

---

## 3. x402 payment gate

### 3.1 When does a call get gated?

A call is gated iff **both** are true:
- `PCC_X402_ENABLED=true` is set on the gateway, AND
- The tool's `pricing.perCallUsdc` parses to a number > 0.

Anything else — gate disabled, no pricing, `"0"` price, missing
`pricing` — falls through to the existing free-call path with no
change in response shape (other than the absence of a `payment`
field on the response body).

### 3.2 Settle ordering

Settle happens **after** the upstream call returns 2xx (scope §3.3
option B). If upstream returns 5xx the gateway does NOT settle — the
caller's signed EIP-3009 authorization is unused and they can retry
the whole invoke with a fresh nonce.

Settle failure after a successful upstream call returns 502 to the
caller and DISCARDS the upstream response (scope §8.2). This is the
expected mode when the facilitator transiently fails — the caller
retries the whole invocation, the upstream gets a duplicate-but-
deduplicatable call, and the on-chain nonce uniqueness in EIP-3009
prevents double-charging.

### 3.3 Idempotency

The gate keeps an in-process `(nonce, from) → receiptCID` cache with
a 10-minute TTL (slightly longer than the protocol's typical 5-minute
`validBefore` window). A retry with the same PAYMENT-SIGNATURE
returns the cached receipt CID without re-calling upstream or the
facilitator. Phase 1.5 nicety: swap to Redis or a DB index on
`paymentTxHash` for multi-gateway-instance deployments.

### 3.4 Price-tag (amount-tamper defense)

Every 402 PAYMENT-REQUIRED payload carries an HMAC `priceTag` in
`accepts[0].extra`. The tag covers `{toolId, amount, network, payTo,
validUntil}` so a caller can't swap the amount or destination on the
retry (scope §6.2 + §8.7). The gate's shape check verifies the tag
before reaching the facilitator.

---

## 4. Environment variables

### Gate-enable flag

| Var | Default | Description |
|---|---|---|
| `PCC_X402_ENABLED` | unset (off) | Set to `"true"` to enable the gate |

### Chain selection

| Var | Default | Description |
|---|---|---|
| `PCC_X402_CHAIN` | `base-sepolia` | `"base-sepolia"` or `"base-mainnet"` |

`base-sepolia` resolves to CAIP-2 `eip155:84532`, USDC
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, default facilitator
`https://x402.org/facilitator` (no auth required).

`base-mainnet` resolves to CAIP-2 `eip155:8453`, USDC
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, default facilitator
`https://api.cdp.coinbase.com/platform/v2/x402` (CDP key required).

### Facilitator

| Var | Default | Description |
|---|---|---|
| `PCC_X402_FACILITATOR_URL` | per-chain default | Override the facilitator endpoint |
| `CDP_API_KEY_ID` | unset | Coinbase CDP API key id (production facilitator only) |
| `CDP_API_KEY_SECRET` | unset | Coinbase CDP API key secret |

### Treasury + signing keys

| Var | Default | Description |
|---|---|---|
| `PCC_AGGREGATOR_TREASURY` | required when gate enabled | 0x... address receiving all per-call fees |
| `PCC_X402_HMAC_KEY` | falls back to `PCC_AGGREGATOR_HMAC_KEY` | 32-byte hex used for the price-tag HMAC |
| `PCC_AGGREGATOR_HMAC_KEY` | ephemeral with warning | Shared with receipt-signer; if unset, ephemeral fallback |

Without a stable HMAC key, gateway restarts invalidate priceTags
mid-flight (the next 402 will issue a fresh tag, which IS verifiable —
but a caller's in-flight signed authorization from before the restart
fails the tag check). Production deploys MUST set one of these keys
explicitly.

---

## 5. Vendor pricing

Vendors set `pricing.perCallUsdc` on the `IndexedTool` at submission
time. The value is a decimal USDC string:

```jsonc
{
  "pricing": {
    "perCallUsdc": "0.001",      // $0.001 per call
    "perKTokenUsdc": "0.0001",   // optional, hint for LLM-style tools (Phase 2)
    "tierLabel": "free",          // optional vendor tier label
    "mode": "fixed"               // "fixed" or "auction" (auction not yet supported)
  }
}
```

- `"0"`, `"0.00"`, undefined, or missing `pricing` → **free**.
- Anything that parses to a positive number → **paid**, gated when
  `PCC_X402_ENABLED=true`.

Recommended floor: don't price below `$0.001` per call. Below that,
PCC's 1% take (100 bps) doesn't cover the per-tx facilitator fee.

---

## 6. Testing against the testnet facilitator

The Base Sepolia facilitator at `https://x402.org/facilitator` is
free and requires no API key. The full happy path:

```bash
export PCC_X402_ENABLED=true
export PCC_X402_CHAIN=base-sepolia
export PCC_AGGREGATOR_TREASURY=0xYourTreasuryAddress
export PCC_X402_HMAC_KEY=$(openssl rand -hex 32)

# Start the gateway
pnpm --filter @pcc/gateway start

# First call (no payment) → 402
curl -X POST http://localhost:3000/api/aggregator/invoke/some-paid-tool \
  -H "Content-Type: application/json" \
  -d '{"args": {"q": "hello"}}'

# Response carries PAYMENT-REQUIRED header. Decode it,
# build an EIP-3009 authorization, sign it with viem, retry with
# PAYMENT-SIGNATURE header.
```

The repo's `packages/payments/src/x402-client.ts` is a reference
client that handles the 402 retry loop. Tests under
`packages/payments/src/__tests__/x402-*.test.ts` show full
verify/settle integration shapes.

---

## 7. Receipt fields populated by x402

The signed `InvocationReceipt` gains three fields on a paid call:

- `pricePaidUsdc`: decimal-string USDC amount the caller paid.
- `paymentTxHash`: the on-chain tx hash returned by `/settle`.
- `pccFeeBps`: PCC's basis-point take (default 100 = 1.0%).

Free calls omit `pricePaidUsdc` and `paymentTxHash` (undefined keys
are skipped by the canonical JSON encoder so receipt CIDs for free
calls are unaffected).

Receipt `requestProjection` redacts the PAYMENT-SIGNATURE header
before hashing (the receipt records that payment was used, but not
the signature bytes — those live on-chain).

---

## 8. Troubleshooting

### "PCC_X402_ENABLED=true but PCC_AGGREGATOR_TREASURY is missing or invalid; gate disabled"

The gate refuses to start without a valid treasury address. Set
`PCC_AGGREGATOR_TREASURY` to a 0x-prefixed 40-hex-char Ethereum
address and restart.

### "no PCC_X402_HMAC_KEY or PCC_AGGREGATOR_HMAC_KEY set; using ephemeral key"

The gate is running with an ephemeral HMAC key, so priceTags from
challenges issued by THIS instance won't verify after restart. Set
`PCC_X402_HMAC_KEY=$(openssl rand -hex 32)` and restart for stable
priceTag verification.

### 503 facilitator_unavailable

The configured facilitator is unreachable or timed out. On Base
mainnet (CDP facilitator) double-check `CDP_API_KEY_ID` and
`CDP_API_KEY_SECRET` are correct. On testnet, check
`https://x402.org/facilitator/verify` from your gateway host:

```bash
curl -X POST https://x402.org/facilitator/verify \
  -H "Content-Type: application/json" \
  -d '{}'
```

A 400 with a JSON error body means the facilitator is reachable.
A timeout / DNS failure means a network problem.

### 502 settlement_failed: NONCE_USED

The caller's nonce was already consumed on-chain. The caller's
client must use a fresh 32-byte random nonce per payment. The
gateway's nonce cache will return the same receipt CID for a replay
within 10 minutes, but a fresh nonce signs a new authorization.

### Why isn't my tool getting gated?

1. Verify `PCC_X402_ENABLED=true` at runtime.
2. Verify the IndexedTool entry has `pricing.perCallUsdc > 0` —
   `"0"` or `undefined` is treated as free.
3. Re-check the env at gateway boot (the gate config is built once
   and cached; restart to pick up env changes).
4. Confirm `PCC_AGGREGATOR_TREASURY` is set and a valid 0x address
   — the gate disables itself silently if treasury is missing.

---

## 9. Out-of-scope (Phase 2+)

The following are deliberately not handled in the Phase 1 gate:

- **Cross-chain** beyond Base mainnet/Sepolia (config-only change).
- **`perKTokenUsdc`** per-token billing for LLM-style tools.
- **Auction pricing** (`mode: "auction"`).
- **Vendor revenue splits** — Phase 1 sends 100% of per-call fees to
  the PCC treasury. Phase 2 will split to `tool.upstreamVendor`.
- **Custodial wallets** (RapidAPI-style single subscription).
- **MCP transport gating** (stdio / SSE) — Phase 1 only HTTP.
- **Phase 1.5: Redis-backed nonce cache** for multi-gateway deploys.
- **Per-call rate limiting** for paying callers (TBD).
