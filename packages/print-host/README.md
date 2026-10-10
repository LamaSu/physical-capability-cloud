# @pcc/print-host

Private workspace package for the N144 October MVP print host. The host application
comes in later PRs. This package currently contains deterministic test support and
repros of the toolkit gaps that prevent the host from using REAL-mode IPP printing
and producing the oracle's required evidence.

The host must produce one signed bundle per job: print events plus pulled carrier
events on success, or `execution_failed` evidence on failure. The reference is
[`tmp/oracle-bundle-contract.md`](../../tmp/oracle-bundle-contract.md), sections
3.0, 4.2 and 5. Toolkit changes belong to pcc-adk; this package records the needed
behavior without changing or working around the toolkit.

## Repros for pcc-adk

Each `GAP-n` calls the exported toolkit and asserts what the host needs. By default,
`gap(name, fn)` registers `it.fails`; a fixed gap therefore makes the expected-failure
test fail until its registration is updated. Set `PRINT_HOST_SHOW_GAPS=1` to register
ordinary tests and see the actual unmet assertions. One ordinary passing test
checks that the scripted adapter completes a print and returns a success bundle.

Paths and line numbers below refer to the supplied toolkit HEAD, a57ca6e1.

| Test name | What the host called | What it needs | Toolkit lines (path:line) |
| --- | --- | --- | --- |
| GAP-1 real mode never silently simulates | `createIppPrintKernel({mockMode:false, uri:"ipp://127.0.0.1:9/ipp/print", kernelId, deviceId}).print({documentData, ...})` | Refuse unavailable real printing, or emit no simulated/mock events. Refuse or report any downgrade. The current adapter reports its downgrade but still successfully simulates. | `packages/kernel/src/adapters/ipp-adapter.ts:130`, `:136`, `:143`, `:432`; `packages/kernel/src/printer-job.ts:352` |
| GAP-2 a print's evidence holds only its own job's events (N106) | Two sequential `runPrintJob` calls sharing one adapter and emitter; `emitter.getEvents(A.jobId, A.stepId)` after B | A contains none of B's events, identified by B's `ippJobId`. | `packages/kernel/src/printer-job.ts:193`, `:208`; `packages/kernel/src/adapters/types.ts:60` |
| GAP-3 a reported failure returns a SIGNED execution_failed bundle | `runPrintJob` followed by adapter `execution_failed {ippJobId, state:"canceled"}` | A bundle containing failure and no completion, with a verifiable Ed25519 signature over its bundle hash. | `packages/kernel/src/printer-job.ts:256`, `:265` |
| GAP-4 a timeout cancels the device job and returns a SIGNED execution_failed bundle | `runPrintJob({timeoutMs:300, ...})`; adapter starts but emits no terminal event | Cancel/stop the active device job; return a signed failure bundle with no completion. | `packages/kernel/src/printer-job.ts:230`, `:240`, `:248` |
| GAP-5 stopping a print yields a terminal failure event | Mock `createIppPrintKernel`, start two pages, then `adapter.execute({type:"stop"})` after first progress | Record `execution_failed` and resolve the print promptly, before its timeout. | `packages/kernel/src/adapters/ipp-adapter.ts:295`, `:412`, `:477`; `packages/kernel/src/printer-job.ts:230` |
| GAP-6 the unit fields reach every event | `runPrintJob({... settlementUnitId, challengeNonce})`, passed through a requested-option cast | Every recorded event payload commits both unit fields. | `packages/kernel/src/printer-job.ts:107`, `:179`; `packages/kernel/src/evidence-emitter.ts:138`, `:192` |
| GAP-7 a success bundle is signed by a delegated session key | Host device signer supplied to `EvidenceEmitter`; successful `runPrintJob` with requested `parentAgentId` and `sessionKeyExpiresAt` three days ahead | `sessionKeyAuthorization`, parent signature over `sessionKeyDelegationPreimage` verified under the supplied device key, and bundle signed by the distinct session key. The expiry must support carrier transit measured in days. | `packages/kernel/src/printer-job.ts:57`, `:83`, `:107`; `packages/kernel/src/evidence-emitter.ts:275`; `packages/kernel-sdk/src/job-handler.ts:241` (TTL capped at 1 h); `packages/spec/src/evidence/signing-preimage.ts:239` |
| GAP-8 a busy refusal is reported as busy and emits no failure (N127) | `runPrintJob` after adapter refuses start with structured busy data | Structured `result.busy === true`; no failure evidence. | `packages/kernel/src/printer-job.ts:221`, `:228`; `packages/kernel/src/adapters/types.ts:37` |

The unit options, `parentAgentId`, `sessionKeyExpiresAt` and `result.busy` are
requested host-facing API shapes, absent from the current print runner. Their casts
make the missing behavior executable; they do not implement it in the host.

## Running

From the workspace root, set the environment for every command and link offline:

```bash
export TMPDIR=$PWD/tmp npm_config_cache=$PWD/tmp/npm-cache npm_config_logs_dir=$PWD/tmp/npm-cache/_logs XDG_CACHE_HOME=$PWD/tmp/xdg-cache
pnpm install --offline --store-dir /mnt/sparkbulk/pnpm-store
(cd packages/print-host && ./node_modules/.bin/vitest run)
(cd packages/print-host && PRINT_HOST_SHOW_GAPS=1 ./node_modules/.bin/vitest run)
(cd packages/print-host && ./node_modules/.bin/tsc --noEmit -p .)
```

The second test run is expected to report eight failures while these gaps exist.
Typecheck `test/` separately as well: the production tsconfig deliberately excludes
tests, and Vitest does not typecheck them.

`FakeMachineAdapter` implements the toolkit's `MachineAdapter`. Tests script each
start as success with a device job id, busy, or error; await `started()`; explicitly
`emit` print events with `ippJobId`; and inspect `commands`. It has no timers or
network. IPP repros use fake timers and dispose the adapter; the only real-mode URI
is the loopback discard endpoint above. All signing keys are generated in memory
at runtime. Signatures are verified using `@pcc/kernel-sdk` and Node's crypto API.
