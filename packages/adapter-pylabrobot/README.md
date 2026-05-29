# @pcc/adapter-pylabrobot

PCC adapter that bridges the kernel to any [PyLabRobot](https://github.com/PyLabRobot/pylabrobot)-supported lab instrument via a long-running Python sidecar that speaks JSON-RPC 2.0 over stdio.

**Phase 1 scope**: Opentrons OT-2 (+ ChatterboxBackend mock). Phase 2 adds Hamilton STAR / Vantage, Tecan EVO, Opentrons Flex, heater-shakers. Phase 3 adds plate readers, thermocyclers, centrifuges. Phase 4 adds storage hotels + multi-instrument orchestration.

See the authoritative integration spec: `C:\Users\globa\physical-capability-cloud\ai\research\pylabrobot-pcc-integration-2026-05-25.md`.

## Architecture

```
PCC Kernel (Node)              Python sidecar              PLR Backend           Real instrument
─────────────────              ──────────────              ───────────           ────────────────
 PyLabRobotAdapter   ────────► SidecarClient   ──stdio──► pcc_plr_sidecar  ────► OpentronsBackend ────► OT-2 (HTTP API)
   (TypeScript)                (JSON-RPC 2.0)              Server + Commands       STARBackend     ────► Hamilton STAR (USB)
                                                                                   EVOBackend      ────► Tecan EVO (TCP)
                                                                                   ChatterboxBackend  ─► (in-memory mock)
                                                                                   (Phase 1: stub  ────► no-PLR fallback)
```

One sidecar per kernel-device. The sidecar holds the PLR Machine object,
exclusive hardware locks, and the asyncio event loop across jobs. See
section 3.2 of the integration spec for why we picked sidecar over
subprocess-per-job (cold start, lock contention, calibration state).

## Install

This is a workspace package — there is no separate `npm install` step. The
adapter ships with two pieces:

1. **TypeScript** (auto-installed via `pnpm install` at the monorepo root):
   ```bash
   pnpm --filter @pcc/adapter-pylabrobot build
   ```

2. **Python sidecar** (`packages/adapter-pylabrobot/python/`):
   ```bash
   cd packages/adapter-pylabrobot/python
   uv pip install -e ".[dev]"          # dev + test deps
   uv pip install -e ".[ot2]"          # Opentrons HTTP API support
   uv pip install -e ".[hamilton]"     # Hamilton STAR/Vantage firmware support
   uv pip install -e ".[tecan]"        # Tecan EVO support
   ```

   The `[dev]` extra installs `pylabrobot` core + pytest. Vendor extras
   pull in optional native deps (`pyusb`, `pyserial`, `opentrons`) — install
   only what you need.

   For air-gapped installs, pre-bundle a wheelhouse:
   ```bash
   pip download -r requirements.txt -d /opt/pcc/wheels
   pip install --no-index --find-links=/opt/pcc/wheels pylabrobot
   ```

## Config

Register a PLR-driven device via your `KERNEL_CONFIG`:

```json
{
  "kernelId": "kernel_lab_42",
  "devices": [
    {
      "id": "dev-ot2-001",
      "type": "machine",
      "adapterType": "pylabrobot",
      "config": {
        "plrBackend": "ot2",
        "backendConfig": {
          "ot2Url": "http://192.168.1.50:31950",
          "ot2ApiKey": "${OT2_API_KEY}"
        },
        "pythonPath": "auto"
      }
    }
  ]
}
```

Or use the `pcc-node` CLI / `/api/setup/register-device` route (see PCC's
operator onboarding docs).

### Environment variables

| Var | Default | Description |
|-----|---------|-------------|
| `PCC_PLR_PYTHON_PATH` | `python` | Python interpreter the sidecar runs under |
| `PCC_PLR_SIDECAR_TIMEOUT_MS` | `60000` | Default per-RPC timeout |

Per-device overrides via `config.pythonPath`, `config.rpcTimeoutMs`,
`config.runTimeoutMs`, `config.restartAfterJobs`.

## Backends supported (Phase 1)

| Backend       | Config keys                          | Notes |
|---------------|--------------------------------------|-------|
| `chatterbox`  | (none)                               | PLR's in-memory mock liquid handler. Always available. Dry-run only. |
| `ot2`         | `ot2Url`, `ot2ApiKey?`               | Opentrons OT-2 via PLR's `OpentronsBackend`. Requires `[ot2]` extra. |
| `stub`        | (none)                               | Pure-stdlib no-PLR fallback. CI + smoke tests use this. Single sub-second simulated run. |

Phase 2 extends with `flex`, `star`, `vantage`, `evo`, `hamilton-hhs`, `inheco-thermoshake`. Phase 3 adds `clariostar`, `cytation5`, `inheco-odtc`, `vspin`. Phase 4 adds `cytomat-2`, `cytomat-6`, `liconic-stx`.

## Usage

```ts
import { PyLabRobotAdapter } from "@pcc/adapter-pylabrobot";

const adapter = new PyLabRobotAdapter({
  deviceId: "dev-ot2-001",
  kernelId: "kernel_lab_42",
  plrBackend: "ot2",
  backendConfig: {
    ot2Url: "http://192.168.1.50:31950",
    ot2ApiKey: process.env.OT2_API_KEY,
  },
  sidecarConfig: {
    pythonPath: "python3",
  },
});

adapter.onEvidence((event) => {
  // event is shaped like spec's EvidenceEvent (minus id/hash)
  console.log(`${event.type}: ${JSON.stringify(event.payload)}`);
});

await adapter.execute({ type: "load_gcode", payload: { deckLayoutId: "deck-pcr-prep-v1" } });
const result = await adapter.execute({
  type: "start",
  payload: {
    jobId: "job-001",
    protocolSource: "inline-ops",
    protocolInline: [
      { op: "pickUpTips", channel: 0 },
      { op: "aspirate", well: "A1", volume_uL: 100, labwareId: "src" },
      { op: "dispense", well: "B1", volume_uL: 100, labwareId: "dst" },
      { op: "dropTips", channel: 0 },
    ],
  },
});

console.log("result", result);
await adapter.dispose();
```

Mock mode (no Python subprocess — pure synthetic responses):

```ts
const adapter = new PyLabRobotAdapter({
  deviceId: "dev-1",
  kernelId: "k",
  plrBackend: "chatterbox",
  backendConfig: {},
  mockMode: true,
});
```

## OT-2 simulator setup

For development without a physical OT-2, run Opentrons' robot simulator:

```bash
docker run --rm -p 31950:31950 opentrons/opentrons-simulator:latest
```

Then point the adapter at `http://localhost:31950`. The simulator exposes
the same HTTP API the OT-2 uses, so `PyLabRobotAdapter` with
`plrBackend: "ot2"` works against it unchanged.

## End-to-end acceptance test

```bash
pnpm --filter @pcc/adapter-pylabrobot exec tsx scripts/test-plr-ot2.ts
```

The script (`scripts/test-plr-ot2.ts`):
1. Detects whether the OT-2 simulator is reachable on `OT2_SIMULATOR_URL`
   (default `http://localhost:31950`).
2. Falls back to `chatterbox` if not — still exercises the full sidecar
   round trip with PLR's mock backend.
3. Builds a 96-well water transfer protocol, submits it, waits for
   completion, asserts an evidence bundle was produced.

See `scripts/test-plr-ot2.ts` for the full reference flow.

## RPC contract

The sidecar exposes (see `src/protocol.ts`):

| Namespace | Methods |
|-----------|---------|
| `backend.*` | `init`, `run`, `status`, `calibrate`, `shutdown`, `abort` |
| `evidence.*` | `startRecording`, `stopRecording`, `snapshot` |
| `health.*` | `ping` |

JSON-RPC 2.0 error codes used (see `RPC_ERROR_CODES`):

| Code | Meaning |
|------|---------|
| `-32700` | Parse error |
| `-32600` | Invalid request |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |
| `-32001` | Retryable transient failure |
| `-32002` | Non-retryable protocol error |
| `-32003` | Hardware unreachable |
| `-32004` | Not supported on this backend |
| `-32005` | Device busy |
| `-32099` | Sidecar restart in progress |

The sidecar also pushes `evidence` notifications (no `id`) during a
recording window — every PLR atomic op surfaces as one notification, plus
the adapter folds Python `logging` records into `process_log_summary`
events.

## Testing

```bash
# TypeScript side (34 tests, runs without Python or PLR):
pnpm --filter @pcc/adapter-pylabrobot test

# Python side (36 tests, uses the `stub` backend — no pylabrobot required):
cd packages/adapter-pylabrobot/python
PYTHONPATH=. python -m pytest tests/
```

## Coexistence with hamilton-adapter

This adapter and `packages/kernel/src/adapters/hamilton-adapter.ts` cover
**different Hamilton product lines** and **different protocols** — they
coexist by design:

| Adapter | Covers | Protocol |
|---------|--------|----------|
| `hamilton-adapter.ts` | Hamilton Microlab Prep | Vendor REST API on port 80 (JWT auth) |
| `@pcc/adapter-pylabrobot` (this) | Hamilton STAR / STARlet / Vantage | PLR firmware-level USB/FTDI |

Same operator can register one of each and advertise distinct capabilities.

## See also

- `ai/research/pylabrobot-pcc-integration-2026-05-25.md` — full integration spec
- `ai/scoping/plr-backend-author-economics-2026-05-25.md` — per-backend-author payout machinery (referenced from §5)
- `packages/contract-builder/src/templates/liquid-handling-plr.ts` — capability template
- `packages/contract-builder/src/profiles/opentrons-ot2-via-plr.ts` — OT-2 machine profile
