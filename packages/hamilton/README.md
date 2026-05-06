# @pcc/hamilton

Hamilton ML Prep adapter helpers for the [Physical Capability Cloud](https://capability.network).

If you're an **operator** with a Hamilton Microlab Prep instrument and you want to plug it into the PCC network so customers can submit liquid-handling jobs to it — start here.

If you're a **customer** discovering Hamilton-equipped operators on the network — you don't need this package; just use [`agent-package.json`](https://capability.network/agent-package.json) and the standard discovery flow.

---

## Quick start (operator)

```bash
# 1. Install pcc-node (the operator daemon)
pip install pcc-node

# 2. Set environment for the gateway
export PCC_BASE=https://capability.network

# 3. Hand the daemon your Hamilton config — example below
export KERNEL_CONFIG='{
  "kernelId": "kernel_my_hamilton",
  "devices": [{
    "id": "hamilton-prep-01",
    "type": "machine",
    "adapterType": "hamilton",
    "config": {
      "url": "http://192.168.1.50",
      "username": "your-hamilton-username",
      "password": "your-hamilton-password",
      "kernelId": "kernel_my_hamilton",
      "mockMode": false,
      "pollIntervalMs": 3000
    }
  }]
}'

# 4. Start the daemon
pcc-node start
```

That single sequence provisions an API key, registers the kernel at `capability.network`, announces a `liquid-handler` capability, and starts the kernel daemon — which connects to your Hamilton over the LAN, authenticates with JWT, and is ready to accept jobs from any customer on the network.

---

## What this package gives you

A small, dependency-free TypeScript helper module. Three things:

```ts
import {
  buildHamiltonConfig,
  validateHamiltonOptions,
  HAMILTON_PREP_CAPABILITY,
} from "@pcc/hamilton";

// Validate before you submit
const check = validateHamiltonOptions({
  url: "http://192.168.1.50",
  username: "alice",
  password: process.env.HAMILTON_PASSWORD!,
});
if (!check.valid) throw new Error(check.errors.join(", "));

// Generate a complete KERNEL_CONFIG
const config = buildHamiltonConfig({
  url: "http://192.168.1.50",
  username: "alice",
  password: process.env.HAMILTON_PASSWORD!,
});

// Pass to pcc-node via KERNEL_CONFIG env var
process.env.KERNEL_CONFIG = JSON.stringify(config);
```

The Hamilton adapter implementation itself lives in [`@pcc/kernel`](../kernel) — this package is configuration helpers + a published, stable shape for operator config.

---

## Hamilton API specifics

Hamilton's ML Prep instruments expose a LAN-resident REST API at `http://{prep_ip}/api/v1/...`. The adapter:

- Authenticates via `POST /api/v1/authenticate` → JWT bearer
- Refreshes via `POST /api/v1/authenticate/renew-token` near expiry
- Selects protocols via `POST /api/v1/protocol-run/create`
- Polls run state via `GET /api/v1/protocol-run`
- Collects evidence via `GET /api/v1/run-data/{id}/pdf` and `/pipetting-csv`
- Captures camera snapshots via `GET /api/v1/camera/{rectify}` (if your model has the vision system)

Hamilton's documented REST surface does not include a clean cancel — runs are stopped at the touchscreen on the instrument. The adapter surfaces this honestly (returns failure for `stop` commands) rather than pretending.

For the full Hamilton API surface, see the [Hamilton Developer Portal](https://developer.hamiltoncompany.com/products/prep/api/openapi).

---

## Mock mode for demos and CI

For demos / development without touching a real instrument:

```ts
import { buildHamiltonConfig } from "@pcc/hamilton";

const config = buildHamiltonConfig({
  url: "http://192.0.2.1",     // any unreachable address; mock mode bypasses HTTP
  username: "demo",
  password: "demo",
  mockMode: true,              // ← simulates the full lifecycle
  mockRunDurationMs: 2000,     // run completes after 2s
});
```

Mock mode emits the same lifecycle events (`gcode_received` / `execution_started` / `execution_completed`) as a real device. Customers submitting jobs to a mock-mode kernel see the full evidence flow, just with no actual liquid moving.

---

## Network requirements

The kernel running on the operator's machine needs:

- **Outbound HTTPS** to `https://capability.network` (gateway)
- **Outbound HTTP/HTTPS** to your Hamilton instrument's LAN IP (for the adapter ↔ device traffic)
- **Outbound RPC** to Base Sepolia (for evidence anchoring; see `PCC_NETWORK` env var)
- **Outbound IPFS / Storacha** (for evidence storage; see `EVIDENCE_STORAGE` env var)

The Hamilton instrument itself does not need any inbound internet — only the kernel's host machine does. Conference / hospital / corporate networks that block arbitrary outbound HTTP often need a firewall exception for `capability.network` and the Base Sepolia RPC endpoint.

---

## Troubleshooting

**`Hamilton auth failed: 401`** — username / password is wrong, or the Hamilton account is locked. Test the credentials by logging into the touchscreen UI on the instrument.

**`fetch failed: ECONNREFUSED`** — operator's machine cannot reach the instrument IP. Test with `curl http://{prep_ip}/api/v1/system-ready` from the operator machine.

**`unknown adapter type 'hamilton'`** — the kernel runtime is older than this adapter. Update `@pcc/kernel` (or upgrade `pcc-node`) to a version that includes the Hamilton adapter (≥0.1.0 of `@pcc/kernel` post-2026-05-06).

**Job submitted but never completes** — check `GET /api/v1/protocol-run` directly on the instrument. If the run finished but the kernel didn't notice, the poll-based completion detection may need its `pollIntervalMs` lowered. If the run is genuinely stuck, an operator may need to intervene via the touchscreen.

---

## License

Apache-2.0. See the repo root [`LICENSE`](../../LICENSE).
