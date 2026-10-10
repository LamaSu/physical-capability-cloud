# @pcc/print-host

Private workspace package for the N144 October MVP print host. The host application
comes in later PRs. This package currently contains deterministic test support and
repros of the toolkit gaps that prevent the host from using REAL-mode IPP printing
and producing the oracle's required evidence.
The package is deliberately not built into the gateway image: the Dockerfile's
turbo filter excludes this operator-owned program.

The host must produce one signed bundle per job: print events plus pulled carrier
events on success, or `execution_failed` evidence on failure. The reference is
pcc-oracle's B5 print-host bundle contract (bus #7386; on the Spark:
`/mnt/sparkbulk/pcc-reconciliation/returns/pcc-oracle-work/print-host-bundle-contract-20261009.md`),
sections 3.0, 4.2 and 5. Toolkit changes belong to pcc-adk; this package records the needed
behavior without changing or working around the toolkit.

## Repros for pcc-adk

Each `GAP-n` calls the exported toolkit and asserts what the host needs. By default,
`gap(name, fn)` registers `it.fails`; a fixed gap therefore makes the expected-failure
test fail until its registration is updated. Set `PRINT_HOST_SHOW_GAPS=1` to register
ordinary tests and see the actual unmet assertions. One ordinary passing test
checks that the scripted adapter completes a print and returns a success bundle.

When a toolkit change makes a GAP test pass, the same PR changes that test's `gap(` to `it(`; the repro is then that fix's acceptance test.

Paths and line numbers below refer to the supplied toolkit HEAD, a57ca6e1.

| Test name | What the host called | What it needs | Toolkit lines (path:line) |
| --- | --- | --- | --- |
| GAP-1 real mode never simulates | `createIppPrintKernel({mockMode:false, uri:"ipp://127.0.0.1:9/ipp/print", kernelId, deviceId}).print({documentData, ...})` | Refuse unavailable real printing, or record no simulated or mock events. Reporting a downgrade is not enough: simulated evidence cannot settle. | `packages/kernel/src/adapters/ipp-adapter.ts:130`, `:136`, `:143`, `:432`; `packages/kernel/src/printer-job.ts:352` |
| GAP-2 a print's evidence holds only its own job's events (N106) | Two sequential `runPrintJob` calls sharing one adapter and emitter; `emitter.getEvents(A.jobId, A.stepId)` after B | A contains none of B's events, identified by B's `ippJobId`. | `packages/kernel/src/printer-job.ts:193`, `:208`; `packages/kernel/src/adapters/types.ts:59` |
| GAP-3 a reported failure returns a SIGNED execution_failed bundle | `runPrintJob` followed by adapter `execution_failed {ippJobId, state:"canceled"}` | A bundle containing failure and no completion, with a verifiable Ed25519 signature over its bundle hash. | `packages/kernel/src/printer-job.ts:256`, `:269` |
| GAP-4 a timeout cancels the device job and returns a SIGNED execution_failed bundle | `runPrintJob({timeoutMs:300, ...})`; adapter starts but emits no terminal event | Cancel with `cancelJob(ippJobId)` (never `"stop"`), keep polling to the canceled state, and return a signed failure bundle with no completion. | `packages/kernel/src/printer-job.ts:230`, `:240`, `:248`; `packages/kernel/src/adapters/ipp-adapter.ts:231`, `:477-481`, `:717-725` |
| GAP-5 an abort input cancels the device job and returns a SIGNED execution_failed bundle | Fake adapter starts job 105; `runPrintJob({timeoutMs:10_000, signal:controller.signal, ...})` through a requested-option cast; emit `execution_started`, then abort | The requested `signal: AbortSignal` input must cancel with `cancelJob(105)` (never `"stop"`) and return a signed `execution_failed` bundle with no completion before the timeout. Its shape is pcc-adk's to choose; the e-stop's device half needs it (runbook §10.1, task T12). | `packages/kernel/src/printer-job.ts:107`, `:230`, `:240`; `packages/kernel/src/adapters/ipp-adapter.ts:231`, `:717-725` |
| GAP-6 the unit fields reach every event | `runPrintJob({... settlementUnitId, challengeNonce})`, passed through a requested-option cast | Every recorded event payload commits both unit fields. | `packages/kernel/src/printer-job.ts:107`, `:179`; `packages/kernel/src/evidence-emitter.ts:138`, `:192` |
| GAP-7 a success bundle is signed by a delegated session key | Host device signer supplied to `EvidenceEmitter`; successful `runPrintJob` with Base Sepolia operator `parentAgentId` (`eip155:84532:0x<escrow operator, lowercase>`, independent of the device key) and `sessionKeyExpiresAt` three days ahead | `sessionKeyAuthorization` with the requested operator `parentAgentId`, parent signature over `sessionKeyDelegationPreimage` verified under the supplied device key, and bundle signed by the distinct session key. The expiry must support carrier transit measured in days. | `packages/kernel/src/printer-job.ts:57`, `:83`, `:107`; `packages/kernel/src/evidence-emitter.ts:275`; `packages/kernel-sdk/src/job-handler.ts:241` (TTL capped at 1 h); `packages/spec/src/evidence/signing-preimage.ts:239` |
| GAP-8 a busy refusal is reported as busy and emits no failure (N127) | `runPrintJob` after adapter refuses start with structured busy data | A structured busy marker; its shape is pcc-adk's to choose. No failure evidence. | `packages/kernel/src/printer-job.ts:221`, `:228`; `packages/kernel/src/adapters/types.ts:37` |

The unit options, `signal`, `parentAgentId`, `sessionKeyExpiresAt` and `result.busy` are
requested host-facing API shapes, absent from the current print runner. Their casts
make the missing behavior executable; they do not implement it in the host.

## Running

From the workspace root:

```bash
pnpm install
pnpm --filter @pcc/print-host test
PRINT_HOST_SHOW_GAPS=1 pnpm --filter @pcc/print-host test
pnpm --filter @pcc/print-host typecheck
```

The second test run is expected to report eight failures while these gaps exist.
Typecheck `test/` separately as well: the production tsconfig deliberately excludes
tests, and Vitest does not typecheck them.

`FakeMachineAdapter` implements the toolkit's `MachineAdapter`. Tests script each
start as success with a device job id, busy, or error; await `started()`; explicitly
`emit` print events with `ippJobId`; and inspect `commands` and `cancels`.
Its `cancelJob(jobId)` records every requested id; for the active device job it
models the poller observing job-state 7 by emitting
`execution_failed {ippJobId:jobId, state:"canceled"}` through `emit` in a
resolved-promise continuation. Other ids change nothing, and `"stop"` ends work
without a terminal event. It has no timers or network. Each test uses its own
kernel and device ids. IPP repros use fake timers and dispose the adapter; the only
real-mode URI is the loopback discard endpoint above. All signing keys are generated
in memory at runtime. Signatures are verified using `@pcc/kernel-sdk` and Node's
crypto API.
