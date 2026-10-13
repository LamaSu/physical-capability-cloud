# @pcc/print-host

Private workspace package for the N144 October MVP print host. The host application
comes in later PRs. This package currently contains deterministic test support and
repros of the toolkit gaps that prevent the host from using REAL-mode IPP printing
and producing the oracle's required evidence.
Its source enters the gateway image through `COPY . .`; only the build skips it
via the Dockerfile's turbo filter.

The host must produce ONE signed bundle per settlement unit: print events plus pulled carrier
events on success, or `execution_failed` evidence on failure. The reference is
pcc-oracle's B5 print-host bundle contract (bus #7386; on the Spark:
`/mnt/sparkbulk/pcc-reconciliation/returns/pcc-oracle-work/print-host-bundle-contract-20261009.md`),
sections 3.0, 4.2 and 5. Toolkit changes belong to pcc-adk; this package records the needed
behavior without changing or working around the toolkit.

## Repros for pcc-adk

Each `GAP-n` calls the exported toolkit and asserts what the host needs. By default,
`gap(name, fn)` registers `it.fails`; a fixed gap therefore makes the expected-failure
test fail until its registration is updated. Set `PRINT_HOST_SHOW_GAPS=1` to register
ordinary tests and see the actual unmet assertions. Passing controls check a print's
success bundle, positive decimal cancel ids (and rejection of whitespace, hex, and
exponent strings), both cancel/event orders, the once-only cancel report control,
and a silent printer's once-only cancel-confirm deadline. An Ed25519 seed scan checks
isolated leak forms, seed-free text, random bytes, and real event hashes/signature
as false-positive controls.
GAP-7 also checks that an intact copied journal resumes alongside the requirement to
refuse a tampered copy. The original journal is scanned again after resume and delivery,
before finalization can erase a leaked session seed. The intact copy's scan detects
only the original bundle's session key.

The at-rest scan covers eight text forms: 64-hex seed, `0x`-prefixed 64-hex seed,
128-hex secret key, base64 seed, base64url seed, base64 secret key, JSON numeric
index-keyed Uint8Array secret key, and JSON numeric seed array. It also scans every
raw 32-byte window, covering a raw 32-byte seed, a raw 64-byte secret key, and a
raw seed at an odd byte offset, and directly searches raw bytes for the device
seed. It does NOT cover decimal Uint8Array text, `util.inspect` Buffer text,
odd-nibble hex, colon-separated hex, prefixed or wrapped base64, base64/base64url
tokens over 8192 characters, or decimal-string arrays.

The scan de-duplicates candidate seeds but derives an Ed25519 public key for every
unique 32-byte window, so its cost grows with journal bytes. GAP-7 has an explicit
60-second timeout, including its six scans; a timing control exercises all six on
a synthetic journal at least ten times the r8 reference's size.

When a toolkit change makes a GAP test pass, the same PR changes that test's `gap(` to `it(`; the repro is then that fix's acceptance test.

Paths and line numbers below refer to the supplied toolkit HEAD, a57ca6e1.

| Test name | What the host called | What it needs | Toolkit lines (path:line) |
| --- | --- | --- | --- |
| GAP-1 real mode never simulates | `createIppPrintKernel({mockMode:false, uri:"ipp://127.0.0.1:9/ipp/print", kernelId, deviceId}).print({documentData, ...})` | Refuse unavailable real printing, or record no simulated or mock events. Reporting a downgrade is not enough: simulated evidence cannot settle. The current repro fails on its own assertion only because the IPP mock finishes inside its 1 s timeout. | `packages/kernel/src/adapters/ipp-adapter.ts:130`, `:136`, `:143`, `:432`; `packages/kernel/src/printer-job.ts:352` |
| GAP-2 a print's evidence holds only its own job's events (N106) | Two sequential `runPrintJob` calls sharing one adapter and emitter; `emitter.getEvents(A.jobId, A.stepId)` after B | A holds exactly its three events, each with `ippJobId:101`, and contains none of B's events. | `packages/kernel/src/printer-job.ts:193`, `:208`; `packages/kernel/src/adapters/types.ts:59` |
| GAP-3 a reported failure returns a SIGNED execution_failed bundle | `runPrintJob` followed by adapter `execution_failed {ippJobId, state:"canceled"}` | A bundle containing failure and no completion, with a verifiable Ed25519 signature over its bundle hash. | `packages/kernel/src/printer-job.ts:256`, `:269` |
| GAP-4 a timeout cancels the device job and returns a SIGNED execution_failed bundle | `runPrintJob({timeoutMs:300, ...})`; advance exactly 300 ms, then await real async work; also use a silent printer | One or more cancels, all for the print's own id (never `"stop"`); return a signed failure bundle with no completion and exactly one `execution_failed` with `origin:"device"`. A reporting printer reaches state 7; the silent printer reports `reason:"cancel-unconfirmed"` at its deadline and permits a following print instead of a busy refusal with `reason:"quiescing"`. The result has `failure:{kind:"timeout", origin:"device"}` and truthy `cancelRequested`. Assumes a contract-honouring adapter: these GAPs do not test the real IppAdapter's own origin stamping or cancel-confirm deadline. | `packages/kernel/src/printer-job.ts:230`, `:240`, `:248`; `packages/kernel/src/adapters/ipp-adapter.ts:231`, `:477-481`, `:717-725` |
| GAP-5 an abort input cancels the device job and returns a SIGNED execution_failed bundle | `runPrintJob({timeoutMs:10_000, signal, ...})`; abort under both cancel/event orders, then await real async work; also use a silent printer | One or more cancels, all for the print's own id (never `"stop"`); signed failure evidence with no completion before timeout whether state 7 arrives before or after cancellation resolves, with exactly one `execution_failed` carrying the print's own `ippJobId` and `origin:"device"`. The silent printer instead reports `reason:"cancel-unconfirmed"` at its deadline and permits a following print instead of a busy refusal with `reason:"quiescing"`. The result has `failure:{kind:"aborted", origin:"device"}` and truthy `cancelRequested`. Assumes a contract-honouring adapter: these GAPs do not test the real IppAdapter's own origin stamping or cancel-confirm deadline. | `packages/kernel/src/printer-job.ts:107`, `:230`, `:240`; `packages/kernel/src/adapters/ipp-adapter.ts:231`, `:717-725` |
| GAP-6 the unit fields reach every event | `runPrintJob({... settlementUnitId, challengeNonce})`, passed through a requested-option cast | The signed bundle holds exactly three events; every event payload commits both unit fields. | `packages/kernel/src/printer-job.ts:107`, `:179`; `packages/kernel/src/evidence-emitter.ts:138`, `:192` |
| GAP-7 a unit-level evidence session signs ONE journaled bundle under a delegated session key | Dynamically find `openUnitEvidenceSession` / `resumeUnitEvidenceSession`; open with PCC `jobId`, `parentAgentId = eip155:84532:<lowercase operator>`, whole-second `fundedAt`, and `expiresAt` set to the unit's `reclaimAt`; add print events and pickup, resume, add delivery, finalize | Per pcc-evidence bus #7537 H1(b), mint and authorize the session key at finalization: bundle `jobId` equals the requested PCC job id, authorization `parentAgentId` matches the operator, `contractIds` is exactly `[jobId]`, whole-second `issuedAt` lies between `fundedAt` and the earliest event timestamp, `expiresAt` equals `reclaimAt`, and `maxSignatures` equals this ONE bundle's event count. Every event binds `settlementUnitId` and `challengeNonce`. Keep device and session seeds off disk, journal the signed bundle before return, return byte-identical repeat/resumed finalization, reject another unit and a broken journal with an intact-copy resume control, and require files mode 0600 and all journal directories mode 0700. | API absent; `packages/spec/src/evidence/signing-preimage.ts:239` |
| GAP-8 a busy refusal is reported as busy and emits no failure (N127) | `runPrintJob` after adapter refuses start with top-level `busy: true` (also retained in `data`) | Top-level `result.busy` is a structured object with `reason:"device"`, never `true` or a string; no failure evidence. | `packages/kernel/src/printer-job.ts:221`, `:228`; `packages/kernel/src/adapters/types.ts:37` |

Adk was asked in bus #7752 to test the real IppAdapter's origin stamping and
cancel-confirm deadline. A PR1 fix that flips GAP-4/5 flips the kernel half.

The unit options, `signal`, top-level `busy`, `failure`, `cancelRequested`, and unit
evidence session API are requested toolkit shapes. Local types and dynamic lookup
keep the repros compilable before those APIs exist. GAP-7 consumes print events,
never the print's success bundle.

## Running

From the workspace root:

```bash
pnpm install
pnpm --filter @pcc/print-host test
PRINT_HOST_SHOW_GAPS=1 pnpm --filter @pcc/print-host test
pnpm --filter @pcc/print-host typecheck
```

The second test run reports eleven failures across eight gaps (GAP-5 has two
cancel/event orders, and GAP-4 and GAP-5 each have a silent-printer variant).
A root `pnpm test` may drop `PRINT_HOST_SHOW_GAPS` under turbo's strict environment
mode; use the `--filter` commands above.
Typecheck `test/` separately as well: the production tsconfig deliberately excludes
tests, and Vitest does not typecheck them.

`FakeMachineAdapter` implements the toolkit's `MachineAdapter`. Tests script each
start as success with a device job id, busy, or error; await `started()`; explicitly
`emit` print events with `ippJobId`; and inspect `commands` and `cancels`.
Its `cancelJob(jobId)` accepts positive safe integer numbers or decimal strings
matching `/^[1-9][0-9]*$/` whose numeric value is a safe integer, and records numbers.
For the active job it emits `execution_failed {ippJobId, state:"canceled", origin:"device"}` before
cancellation resolves, or on a later real event-loop poll with
`{cancelEventOrder:"after-resolve"}`. The default `cancelBehavior:"report"` reports
cancellation once. With `cancelBehavior:"silent"`, the printer never reports state
7; a real timer with `cancelConfirmMs` (default 50 ms) emits exactly one device-origin
`execution_failed {ippJobId, state:"processing", reason:"cancel-unconfirmed", jobStateReasons:[], origin:"device"}`
if that job is still active, then ends work so quiesce resolves. Repeated cancels
retain the first deadline, and fake timers cannot stall it. Dispose clears the
deadline. Other ids change nothing, and `"stop"` ends
work without a terminal event. A successful replacement start retains the old cancel
handles. In silent mode, cancelling the replacement before the old deadline fires
arms no new deadline; when the old callback runs it skips the replacement, which
remains silent indefinitely unless a later cancel arms a fresh deadline. This replacement
sequence is a declared gap in the fake. The after-resolve poll retains its handle in the
same way: a replacement cancelled before the stale poll fires gets no report.
Real-time waits let hashing finish; fake-time draining
is only a fallback. Each test uses its own
kernel and device ids. IPP repros use fake timers and dispose the adapter; the only
real-mode URI is the loopback discard endpoint above. All signing keys are generated
in memory at runtime. Signatures are verified using `@pcc/kernel-sdk` and Node's
crypto API.
