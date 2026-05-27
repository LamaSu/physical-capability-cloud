# @pcc/bridge-directory

Directory of vendor bridge repositories that integrate with PCC.

- **Phase 1 (current)**: JSON document served from
  `https://capability.network/bridges.json`. Consumer-friendly fetch + Zod
  validation.
- **Phase 2 (future)**: on-chain `BridgeDirectory.sol` (Base) as the upstream
  source of truth. JSON file becomes a generated mirror.

The package shape is the same across both phases — consumers always call
`getBridgeDirectory({ source: "auto" })` and get a validated
`BridgeDirectory` back.

## Schema

The JSON envelope mirrors Uniswap token-list shape:

```ts
{
  name: "PCC Bridge Directory",
  timestamp: "2026-05-27T00:00:00Z",
  version: { major: 0, minor: 1, patch: 0 },
  bridges: BridgeEntry[]
}
```

Each `BridgeEntry` carries 7 required fields (namespace, name, repoUrl,
maintainerAddress, adapterPackage, version, status) plus optional
trustTier, registries (multi-chain), configSchemaURI, SLA, capabilityTypes,
description, maintainerENS, and a free-form `extensions` escape hatch.

Full schema rationale + gas analysis + on-chain struct sketch:
`C:\Users\globa\physical-capability-cloud\ai\research\bridge-directory-schema-2026-05-26.md`.

## Usage

```ts
import {
  getBridgeDirectory,
  lookupBridge,
  filterByStatus,
} from "@pcc/bridge-directory";

const directory = await getBridgeDirectory();              // defaults to JSON
const hamilton = lookupBridge(directory, "hamilton");      // exact match by namespace
const active   = filterByStatus(directory, "active");      // subset

// Phase 2 (when contract ships):
const live = await getBridgeDirectory({
  source: "auto",
  chainId: 8453,
  directoryAddress: "0x...",
});
```

### Source modes

| Mode | Behavior |
|---|---|
| `"json"` (default) | Fetch + validate `https://capability.network/bridges.json`. |
| `"onchain"` | Read `BridgeDirectory.sol` directly. Phase 2 only — currently throws a clear "not implemented" error. |
| `"auto"` | Try on-chain first, fall back to JSON. Phase 2 only. |

### Options

```ts
{
  source?: "json" | "onchain" | "auto";    // default "json"
  jsonUrl?: string;                          // default "https://capability.network/bridges.json"
  chainId?: number;                          // default 8453 (Base mainnet)
  directoryAddress?: `0x${string}`;          // for onchain mode
  fetchImpl?: typeof fetch;                  // injection for tests
}
```

## Adding a bridge

1. Open the issue requesting your bridge be added.
2. PCC ops reviews repoUrl + adapterPackage + maintainerAddress.
3. PR edits `apps/dashboard/public/bridges.json`. CI validates against the
   Zod schema in this package.
4. Merge bumps the directory `version.minor` (Uniswap rule: ADD = minor).

## Phase 2 migration

When `BridgeDirectory.sol` deploys:

1. Migration script reads the JSON, writes each entry on-chain.
2. JSON file continues to publish — but generated FROM the contract via
   nightly cron.
3. `getBridgeDirectory({ source: "auto" })` becomes the default in v0.2 —
   tries on-chain first, falls back to JSON for hot path or RPC outages.
4. Existing consumers calling `getBridgeDirectory()` with no args keep
   working unchanged (still JSON-by-default in 0.1.x).
