# @pcc/adapter-pylabrobot

PCC adapter that bridges the kernel to any [PyLabRobot](https://github.com/PyLabRobot/pylabrobot)-supported lab instrument via a long-running Python sidecar that speaks JSON-RPC 2.0 over stdio.

**Phase 1 scope**: Opentrons OT-2 (+ PLR's `LiquidHandlerChatterboxBackend` digital twin). Phase 2 adds Hamilton STAR / Vantage, Tecan EVO, Opentrons Flex, heater-shakers. Phase 3 adds plate readers, thermocyclers, centrifuges. Phase 4 adds storage hotels + multi-instrument orchestration.

See the authoritative integration spec: `C:\Users\globa\physical-capability-cloud\ai\research\pylabrobot-pcc-integration-2026-05-25.md`.

## Architecture

```
PCC Kernel (Node)              Python sidecar              PLR Backend           Real instrument
─────────────────              ──────────────              ───────────           ────────────────
 PyLabRobotAdapter   ────────► SidecarClient   ──stdio──► pcc_plr_sidecar  ────► OpentronsOT2Backend ─► OT-2 (HTTP API)
   (TypeScript)                (JSON-RPC 2.0)              Server + Commands       STARBackend     ────► Hamilton STAR (USB)
                                                                                   EVOBackend      ────► Tecan EVO (TCP)
                                                                                   LiquidHandlerChatterboxBackend ─► (in-memory digital twin)
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
   pip download "pylabrobot>=0.2.2,<0.3.0" -d /opt/pcc/wheels
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
          "deckLayoutPath": "ot2-dilution.json",
          "initialLiquids": { "src": { "A1": 1500 } }
        },
        "pythonPath": "python3"
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
| `PCC_PLR_PYTHON_PATH` | `python3` (`python` on Windows) | Python interpreter the sidecar runs under |
| `PCC_PLR_SIDECAR_TIMEOUT_MS` | `60000` | Default per-RPC timeout |
| `PCC_PLR_LAYOUT_DIR` | (unset) | The directory the operator keeps deck layouts in. Required for `deckLayoutPath`, which must name a `.json` file inside it (symlinks are resolved first, and the file is then opened once with `O_NOFOLLOW` and identity-checked before it's read — R39 MED8 — so a symlink swapped in between the check and the read is refused, not followed). The sidecar inherits it from the kernel's environment. |

Per-device overrides via `config.pythonPath`, `config.rpcTimeoutMs`,
`config.runTimeoutMs`, `config.restartAfterJobs`.

## Backends supported (Phase 1)

| Backend       | Config keys                          | Notes |
|---------------|--------------------------------------|-------|
| `chatterbox`  | `deckLayout` or `deckLayoutPath` (required), `numChannels?` (1–96), `maxVolumeUL?`, `initialLiquids?`, `tracking?` | PLR's `LiquidHandlerChatterboxBackend`: an in-memory digital twin of the declared deck. Dry-run only: `executionMode: "simulated"`, and its evidence is marked `mock: true`. |
| `ot2`         | `ot2Url`, `deckLayout` or `deckLayoutPath` (an `OTDeck`, required), `maxVolumeUL?`, `initialLiquids?` | Opentrons OT-2 via PLR's `OpentronsOT2Backend(host, port)`: `executionMode: "unverified"` — the backend name alone never proves physical execution (R39 CRIT1); no hardware-identity provenance check exists yet (D1, queue item 19), so `ot2` evidence stays marked `mock: true` too, same as a simulator. Requires the `[ot2]` extra (PLR's own `opentrons` extra). Tip and volume tracking are always on. |
| `stub`        | (none)                               | Pure-stdlib test backend, used only when `plrBackend` is `"stub"`; nothing falls back to it. `executionMode: "stub"`, evidence marked `mock: true`. |

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
    deckLayoutPath: "/etc/pcc/decks/ot2-dilution.json", // a serialized PLR OTDeck
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
      { op: "pickUpTips", tipRack: "tips", tipSpot: "A1", channel: 0 },
      { op: "aspirate", well: "A1", volume_uL: 100, labwareId: "src", channel: 0 },
      { op: "dispense", well: "B1", volume_uL: 100, labwareId: "dst", channel: 0 },
      { op: "dropTips", channel: 0 },
    ],
  },
});

console.log("result", result);
await adapter.dispose();
```

### Declared deck and inline ops (status board row R39)

A PLR backend refuses to start without a declared deck: `backendConfig.deckLayout`
(the output of `deck.serialize()`) or `deckLayoutPath` (a `.json` file inside
`PCC_PLR_LAYOUT_DIR`). The layout is operator configuration, never job input, and it
is checked as data before PLR builds anything from it, on both paths:

- the root is the expected deck (`Deck` or `OTDeck` for chatterbox, `OTDeck` for
  `ot2`), and every typed object in it is one of the PLR resource or geometry
  classes in `backend_loader.LAYOUT_TYPES`;
- a serialized function is never deserialized. **On a hardware-capable backend
  (`ot2`) a function-bearing layout is refused outright** (R39 MED7): stripping
  it (replacing it with `null`) would silently change what PLR actually
  builds from the declared layout, so the declared layout is never mutated and
  then initialized there. On the simulator the strip may still stand
  (dry-run only, counted in `metadata.strippedFunctions`), but it's logged.
  Keys starting with `__`, non-finite numbers, strings over 4 KiB, more than
  100,000 values or nesting deeper than 32 are refused. A file is at most 5 MB;
- every resource has a size and a location, and lies inside its immediate
  parent and inside the deck in **x, y and z** (R39 CRIT4: z was unchecked
  before this; the deck's own `size_z` is the height bound). Deck-level
  siblings overlap no other deck-level labware. Nesting (holders, adapters,
  plates in carriers) is checked recursively: a child's position is relative
  to its immediate parent, and its absolute position must still fit the deck;
- any resource carrying a nonzero `rotation` is refused outright — rotated
  footprints are not computed, so a rotated placement is never silently
  checked against its unrotated box (R39 CRIT4);
- only then is it loaded with `Resource.deserialize(..., allow_marshal=False)`, and
  the result must be the expected deck class.

PLR's own tip and volume tracking are switched on for every PLR backend, so a
missing tip, a well without enough liquid or an overfilled well fails inside PLR
before it becomes a physical action. `initialLiquids` declares what the operator
loaded, as `{resource: {well: uL}}`. On the simulator, `tracking: {"tips": false}`
or `{"volume": false}` switches tracking off explicitly; on hardware it can't be
switched off. **These switches are process-global in PLR** (R39 CRIT3), so a
simulator may not weaken them while a hardware-capable backend (`ot2`) is
already loaded in this sidecar process — that `backend.init` is refused — and
every `ot2` run re-asserts tip/volume tracking ON and reads it back immediately
before actuating, refusing the run outright if it can't be verified.

Each inline op is one real `LiquidHandler` call. An op may carry only its own
fields, and anything else (a typo, a test hook such as `__delay_ms`) refuses the
whole protocol:

| `op` | Fields | Call |
|---|---|---|
| `pickUpTips` | `tipRack`, `tipSpot` (e.g. `"A1"`) or `tipColumn` (1 → `A1`), not both; `channel?` | `pick_up_tips([spot])` |
| `aspirate` / `dispense` | `labwareId`, `well`, `volume_uL` (finite, in (0, `maxVolumeUL`], default 1000); `channel?` | `aspirate/dispense([well], vols=[v])` |
| `dropTips` | `channel?`; optional `tipRack` + `tipSpot`/`tipColumn` | `drop_tips([spot])`, or `return_tips()` |

A run has two phases. First every op is checked (fields, bounds, a `channel` below
the backend's channel count, and deck resources: a tip op must name a tip spot, a
liquid op a well or container) before anything moves, so a protocol with one bad
op runs no op at all. Then the ops run in order, and each op's evidence event is
emitted only after its call returns — and `backend.run` awaits (drains) every one
of those evidence writes before it reports success (R39 HIGH5): completion never
outruns, or silently drops, the evidence it claims to have recorded; a write
failure there means the run does not report clean success. Every run result and
every op event carries `executionMode` (`hardware`, `simulated`, `unverified` or
`stub`). **The backend's declared name never proves physical execution**
(R39 CRIT1): `hardware` is never asserted by Phase 1's sidecar — no
hardware-identity provenance check exists yet (D1, queue item 19) — so `ot2`
reports `unverified`, the same bucket as a simulator. Anything but an exact
`hardware` is also marked `mock: true` (the TypeScript adapter normalizes any
value it doesn't recognize to `unverified` and applies the same marker — see
`normalizeExecutionMode` in `src/adapter.ts`), and it marks the run's
`execution_completed` event the same way.

Failures are loud and typed. A missing resource or well is `-32002`
(`data.missingResource` / `data.missingItem`, plus `opIndex` and `opsCompleted`).
A PLR exception is `-32002` with `data.plrException`. A malformed or unknown op, a
field an op does not take, or an out-of-bounds value is `-32602`. An empty op list
is `-32602`. A non-inline `protocolSource` is `-32004`. `opsCompleted` counts the
calls that returned: it does not prove the failing call had no physical effect.

**Not verified yet (operator decision D1, queue item 19).** The layout allowlist,
the geometry check, and tip and volume tracking are written from PLR's documented
names. The genuine-library test (`python/tests/test_plr_real.py`) runs everything
above through PLR 0.2.2's real deserializer and chatterbox, and it skips until D1
allows installing the pinned library. OT-2 completion semantics (what a returned
call means on the robot), timeouts, cancellation and partial-channel outcomes also
need the genuine backend and a robot before physical arming.

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

> **Known gap (after R39):** the script predates the declared-deck requirement. It
> sends no `deckLayout`, so the chatterbox and OT-2 paths now refuse it, and it
> asserts event counts only. Before it can serve as an acceptance test it needs a
> serialized deck with `tips-300uL`, `src` and `dst`, and assertions on tip and
> volume state. `python/tests/test_plr_real.py` does this against the genuine
> library.

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
# TypeScript side (38 tests, runs without Python or PLR):
pnpm --filter @pcc/adapter-pylabrobot test

# Python side (132 tests on tests/fake_plr, a small fake of the PLR API; no pylabrobot required):
cd packages/adapter-pylabrobot/python
PYTHONPATH=. python3 -m pytest tests/   # pytest-asyncio optional; test_plr_real.py skips without pylabrobot
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
