# `@pcc/alerts`

In-house alerting for PCC operators. Replaces paid SaaS (Tenderly, BetterStack, Blocknative RPC-health) with ~800 lines of TypeScript.

## What it does

1. **On-chain event watcher** (`chain-watcher.ts`) — subscribes to contract events via `viem.watchContractEvent` and fires alerts. Supports caller whitelists so a `release()` event from an unexpected address is upgraded to `critical`.
2. **RPC health probe** (`rpc-health.ts`) — periodically calls `getBlockNumber()` and tracks rolling p50/p95 latency. Fires `warning` on sustained p95 degradation, `critical` on outright failure.
3. **Worker heartbeat** (`heartbeat.ts`) — `POST /heartbeat/:worker` + 60s sweep. Fires `critical` on stale workers.
4. **Discord notifier** (`notifiers/discord.ts`) — pluggable registry, Discord webhook is the v1 notifier.

## Install

Workspace dep:
```json
"@pcc/alerts": "workspace:*"
```

## Configure

Config is a JSON object in `ALERTS_CONFIG` (inline) or `ALERTS_CONFIG_FILE` (path), mirroring the `KERNEL_CONFIG` pattern:

```json
{
  "port": 8787,
  "heartbeatToken": "optional-bearer-for-POST-/heartbeat",
  "chainWatchers": [
    {
      "label": "escrow",
      "chain": "base-sepolia",
      "rpcUrl": "https://sepolia.base.org",
      "address": "0x10059efeeab1ddf013489e9597a3aec4480d95e1",
      "abi": [],
      "events": [
        { "name": "Released", "onFire": "info", "whitelist": ["0xOracle"], "whitelistArg": "caller" },
        { "name": "Disputed", "onFire": "warning" }
      ]
    }
  ],
  "rpcProbes": [
    { "label": "base", "rpcUrl": "https://sepolia.base.org", "chain": "base-sepolia" }
  ],
  "heartbeats": [
    { "worker": "oracle-worker", "maxSilenceMs": 300000 }
  ],
  "notifiers": {
    "discord": { "webhookUrl": "https://discord.com/api/webhooks/..." }
  }
}
```

All numeric fields have sensible defaults (see `config.ts` Zod schema).

## Run

```bash
pnpm --filter @pcc/alerts build
ALERTS_CONFIG='{"port":8787,...}' node packages/alerts/dist/server.js
```

Or via library:
```typescript
import { buildServer, loadAlertsConfig } from "@pcc/alerts";

const { app, shutdown } = buildServer({ config: loadAlertsConfig() });
await app.listen({ port: 8787, host: "0.0.0.0" });
```

## Endpoints

- `GET /health` — open; Upptime probes this.
- `POST /heartbeat/:worker` — open unless `heartbeatToken` set.
- `GET /alerts/recent?limit=50` — open; last N alerts from in-memory ring buffer.

## Adding a notifier

Implement the `Notifier` interface:

```typescript
import type { Notifier, Alert } from "@pcc/alerts";

export const pagerduty: Notifier = {
  name: "pagerduty",
  async fire(alert: Alert) {
    // POST to PagerDuty Events API
  },
};
```

Register in your own server bootstrap — `buildServer` currently wires Discord only; subclass or call `registry.register()` after `buildServer` returns.

## Why self-hosted

See `ai/research/landscape-pcc-alerts.md` for the full landscape report. TL;DR: each piece is 30-150 lines of code, and self-hosting aligns with PCC's thesis that operators own their telemetry.

## v2 backlog

- Generic signed-webhook notifier (HMAC).
- Email notifier (SES/Resend).
- Alert deduplication window.
- Escalation rungs (info → warn → critical policies).
- Persistence of ring buffer to Redis for multi-replica deployments.
