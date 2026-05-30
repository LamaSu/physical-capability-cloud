# @pcc/trilobio

Trilobio (tcode-api) adapter helpers for the [Physical Capability Cloud](https://capability.network).

If you're an **operator** with a [Trilobio](https://trilo.bio/) trilobot fleet controller and you want to plug it into the PCC network so customers can submit liquid-handling jobs to it — start here.

If you're a **customer** discovering Trilobio-equipped operators on the network — you don't need this package; just use [`agent-package.json`](https://capability.network/agent-package.json) and the standard discovery flow.

---

## Quick start (operator)

```bash
# 1. Install pcc-node (the operator daemon)
pip install pcc-node

# 2. Make sure tcode-api is installed on your fleet controller
#    (Trilobio fleet controllers ship with tcode-api pre-installed; verify the version)
uv add git+https://github.com/trilobio/tcode-api.git@v1.25.1

# 3. Set environment for the gateway
export PCC_BASE=https://capability.network

# 4. Hand the daemon your Trilobio config — example below
export KERNEL_CONFIG='{
  "kernelId": "kernel_my_trilobio",
  "devices": [{
    "id": "trilobio-fleet-01",
    "type": "machine",
    "adapterType": "trilobio",
    "config": {
      "url": "http://192.168.1.50",
      "apiKey": "your-trilobio-api-key",
      "kernelId": "kernel_my_trilobio",
      "tcodeApiVersion": "1.25.1",
      "mockMode": false,
      "pollIntervalMs": 3000,
      "maxScriptTimeoutSec": 3600,
      "allowArbitraryScripts": false
    }
  }]
}'

# 5. Start the daemon
pcc-node start
```

That single sequence provisions an API key, registers the kernel at `capability.network`, announces a `liquid-handler` capability with `tcode-script-execution`, and starts the kernel daemon — which connects to your trilobot fleet controller over the LAN, authenticates with an API key, and is ready to accept jobs from any customer on the network.

---

## What this package gives you

A small, dependency-free TypeScript helper module. Four things:

```ts
import {
  buildTrilobioConfig,
  validateTrilobioOptions,
  validateTcodeScript,
  TRILOBIO_CAPABILITY,
} from "@pcc/trilobio";

// Validate config before you submit
const check = validateTrilobioOptions({
  url: "http://192.168.1.50",
  apiKey: process.env.TRILOBIO_API_KEY!,
});
if (!check.valid) throw new Error(check.errors.join(", "));
if (check.warnings) check.warnings.forEach((w) => console.warn(w));

// Generate a complete KERNEL_CONFIG
const config = buildTrilobioConfig({
  url: "http://192.168.1.50",
  apiKey: process.env.TRILOBIO_API_KEY!,
  tcodeApiVersion: "1.25.1",
});

// Pass to pcc-node via KERNEL_CONFIG env var
process.env.KERNEL_CONFIG = JSON.stringify(config);

// (Optional) Lint a tcode-api script before allowing it to run
import { readFileSync } from "node:fs";
const userScript = readFileSync("./protocols/transfer.py", "utf8");
const lint = validateTcodeScript(userScript);
if (!lint.valid) throw new Error(lint.errors.join(", "));
```

The Trilobio adapter implementation itself lives in [`@pcc/kernel`](../kernel) — this package is configuration helpers + a published, stable shape for operator config.

---

## Trilobio API specifics

[`tcode-api`](https://github.com/trilobio/tcode-api) is a Python 3.11+ SDK pre-installed on Trilobio fleet controllers. Scripts written against it execute *on* the fleet controller and exercise commands documented at <https://tcode.trilo.bio/>:

| Category | Commands |
|----------|----------|
| Entity registration | `ADD_LABWARE`, `ADD_PIPETTE_TIP_GROUP`, `ADD_ROBOT`, `ADD_TOOL` |
| Fluid handling | `ASPIRATE`, `DISPENSE`, `MIX` |
| Tip handling | `PICK_UP_TIP`, `DROP_TIP` |
| Motion | `MOVE`, `HOME` |
| Calibration | `CALIBRATE_LABWARE_HEIGHT`, `CALIBRATE_LABWARE_HOLDER`, `CALIBRATE_LABWARE_WELL_DEPTH` |

The PCC adapter:

- Authenticates via API key (default — `Authorization: ApiKey <key>` header) or basic-auth (legacy)
- Submits a tcode script (or a curated protocol ID) to the fleet controller
- Polls run state at `pollIntervalMs` cadence
- Captures evidence: event log, run timing, calibration deltas, sensor data, optional camera frames
- Surfaces stop / pause honestly — Trilobio's documented surface does not always expose remote abort, so the adapter returns failure for `stop` rather than pretending

For the full tcode-api reference, see the [Trilobio T-code documentation](https://tcode.trilo.bio/).

### Two execution modes

Trilobio's strength is that protocols are real Python — flexible, expressive, but also a security surface.

**Curated mode (`allowArbitraryScripts: false`, default):** Customers can only submit jobs that reference protocol IDs from the operator's curated library. The fleet controller runs them. Safer default for shared-operator deployments.

**Open mode (`allowArbitraryScripts: true`):** Customers ship a full tcode Python script as the protocol payload. Maximum flexibility, but operators take on responsibility for sandboxing. The adapter runs `validateTcodeScript()` defensively, but the fleet controller is the source of truth on safety. Recommended only for trusted-counterparty deployments or wallet-gated access.

---

## Mock mode for demos and CI

For demos / development without touching a real instrument:

```ts
import { buildTrilobioConfig } from "@pcc/trilobio";

const config = buildTrilobioConfig({
  url: "http://192.0.2.1",     // any unreachable address; mock mode bypasses HTTP
  apiKey: "demo",
  mockMode: true,              // ← simulates the full lifecycle
  mockRunDurationMs: 2000,     // run completes after 2s
});
```

Mock mode emits the same lifecycle events (`script_received` / `execution_started` / `execution_completed`) as a real device. Customers submitting jobs to a mock-mode kernel see the full evidence flow, just with no actual liquid moving.

---

## Network requirements

The kernel running on the operator's machine needs:

- **Outbound HTTPS** to `https://capability.network` (gateway)
- **Outbound HTTP/HTTPS** to your Trilobio fleet-controller's LAN IP (for the adapter ↔ device traffic)
- **Outbound RPC** to Base Sepolia (for evidence anchoring; see `PCC_NETWORK` env var)
- **Outbound IPFS / Storacha** (for evidence storage; see `EVIDENCE_STORAGE` env var)

The trilobot fleet controller itself does not need any inbound internet — only the kernel's host machine does. Conference / hospital / corporate networks that block arbitrary outbound HTTP often need a firewall exception for `capability.network` and the Base Sepolia RPC endpoint.

---

## Capability declaration

By default the package publishes a `liquid-handler / trilobio-trilobot` capability with these advertised features:

```ts
import { TRILOBIO_CAPABILITY } from "@pcc/trilobio";
// {
//   type: "liquid-handler",
//   subType: "trilobio-trilobot",
//   manufacturer: "Trilobio",
//   model: "Trilobot fleet",
//   materials: ["aqueous-buffer", "dna", "rna", "protein", "cells", "media", "reagent", "small-molecule"],
//   capabilities: [
//     "pipetting", "plate-reformat", "dilution", "normalization",
//     "hit-picking", "serial-dilution",
//     "custom-labware-calibration",
//     "tcode-script-execution"  // ← unique to Trilobio, not in Hamilton
//   ],
//   assuranceTiers: [0, 1, 2]
// }
```

Operators can override or extend any of these fields when calling `POST /api/capabilities` — the constant is a sensible baseline, not a constraint.

---

## Troubleshooting

**`Trilobio auth failed: 401`** — apiKey is wrong, expired, or revoked. Test by curling `Authorization: ApiKey <key>` against `http://{fleet_ip}/api/v1/system-status` from the operator machine.

**`fetch failed: ECONNREFUSED`** — operator's machine cannot reach the fleet-controller IP. Test with `curl http://{fleet_ip}/api/v1/system-status`. Check that the fleet controller is powered on, on the same VLAN, and that no firewall is blocking the operator's host.

**`unknown adapter type 'trilobio'`** — the kernel runtime is older than this adapter. Update `@pcc/kernel` (or upgrade `pcc-node`) to a version that includes the Trilobio adapter (≥ the version published alongside this package).

**`tcode_api: ImportError`** — the fleet controller's tcode-api version doesn't match the version your kernel config pinned. Either upgrade tcode-api on the controller, or update `tcodeApiVersion` in your config to match what's installed.

**Job submitted but never completes** — check directly on the fleet controller's admin UI. If the run finished but the kernel didn't notice, lower `pollIntervalMs`. If the run is genuinely stuck, the fleet controller's emergency-stop on the device is the source of truth — operators may need to intervene physically.

**`script contains <dangerous pattern> — review before allowing on shared hardware`** — `validateTcodeScript()` flagged a `subprocess`, `os.system`, `eval`, or similar in a customer-supplied script. With `allowArbitraryScripts: false` this is a non-issue (you're using protocol IDs, not arbitrary scripts). With `allowArbitraryScripts: true`, audit the flagged pattern — it may be legitimate, or it may be a tenant trying to escape the tcode-api boundary.

---

## License

Apache-2.0. See the repo root [`LICENSE`](../../LICENSE).
