# Changelog

All notable changes to `@pcc/workflow` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Versions are cut by [release-please](https://github.com/googleapis/release-please) on merges into `master` — do not hand-edit version numbers.

## [Unreleased]

### Added

- Initial v0.1.0 scaffold of `@pcc/workflow` — durable execution primitives for PCC, embedded as a library inside the Fastify monolith with no separate workflow server.
- **Public API surface (re-exported from the package barrel `@pcc/workflow`)**:
  - **Activity layer** (`@pcc/workflow/activity` subpath also exported):
    - `Activity.define(opts)` / `defineActivity(opts)` — registration + invocation primitive with retry policy, idempotency claim/complete/fail/reclaim, exponential backoff with jitter.
    - `ActivityDefinition<Args, R>` — concrete handle with `invoke({...}): Promise<Result<R, Error>>`.
    - `proxyActivities(activities)` / `createActivityProxy(opts)` — typed proxy for workflow-side use.
    - `deriveActivityKey(ctx)` — 3-tier key derivation (client header → semantic → content hash).
    - `deriveOnchainOpKey({ jobId, milestoneIdx, action, attempt? })` — keccak256 semantic key for on-chain ops; defaults `attempt` to `1n` (fencing token).
    - `encodeOnchainOpArgs(args)` — minimal ABI encoder for the `(bytes32, uint256, string, uint256)` shape used by `MilestoneEscrow`.
    - `computeBackoffMs`, `isNonRetryable`, `shouldRetry`, `applyRetryPolicyDefaults`, `DEFAULT_RETRY_POLICY`.
  - **Workflow layer** (`@pcc/workflow/workflow` subpath also exported):
    - `Workflow<Args, R>` — abstract base class. Subclasses declare `name`, `version`, and implement `run(ctx, args)`.
    - `WorkflowEngine` — orchestrates `start` / `recover` / `shutdown`. Methods: `register`, `registerActivity`, `start`, `recover`, `shutdown`.
    - `WorkflowEngineOptions`, `WorkflowHandle<R>`, `StartWorkflowOptions`.
  - **Store layer** (`@pcc/workflow/store-sqlite` subpath also exported):
    - `openSqliteStore({ path, pruneIntervalMs?, ... })` — SQLite factory implementing all five sub-stores under one handle.
    - `Store` interface aggregating `idempotency`, `events`, `steps`, `runs`, `dataLocations`, `close()`.
    - `IdempotencyStore`, `EventStore`, `StepResultStore`, `WorkflowRunStore`, `DataLocationStore` interfaces.
    - Row + arg types: `IdempotencyClaim`, `IdempotencyRow`, `IdempotencyClaimArgs`, `IdempotencyCompleteArgs`, `IdempotencyFailArgs`, `EventAppend`, `EventRecord`, `StepResultRecord`, `StepResultPutArgs`, `WorkflowRunRow`, `WorkflowRunCreateArgs`, `WorkflowRunUpdateExtra`, `DataLocationRegisterArgs`.
  - **Data port layer** (`@pcc/workflow/data-port` subpath also exported):
    - `createDataPort({ name, store, schema? })` — typed in-memory port with optional Zod validation.
    - `createDataManager(...)` — locality-aware transfer routing.
    - `createCidHandoff(...)`, `makeSha256CidHandoff(...)` — CID-handoff adapter for Storacha / IPFS.
    - Types: `DataPort<T>`, `DataLocation`, `DataScheme`, `DataType`, `Token<T>`, `TokenTag`.
  - **Versioning**:
    - `getVersion({ store, runId, key, defaultValue, currentValue })` — Temporal-style marker-based versioning.
  - **CWL export** (`@pcc/workflow/cwl` subpath also exported):
    - `cwlExport(def, opts?)` / `cwlExportWithDefaults(def)` — emit CWL v1.2 YAML.
    - Namespace constants: `PCC_NAMESPACE_IRI`, `PCC_KERNEL_REQUIREMENT`, `PCC_COMPENSATION_REQUIREMENT`, `PCC_QUORUM_REQUIREMENT`, `PCC_RETRY_POLICY`, `PCC_SIGNAL_REQUIREMENT`.
    - Types: `WorkflowDef`, `WorkflowDefInput`, `WorkflowDefOutput`, `WorkflowDefStep`, `KernelHint`, `CompensationHint`, `ResourceRequirement`, `QuorumRequirement`, `RetryPolicyHint`, `SignalRequirement`, `PccType`, `CwlPrimitiveType`.
  - **Shared utilities**:
    - `Result<T, E>` discriminated union + `ok` / `err` constructors.
    - `CanonicalInput` recursive JSON type.
    - `RetryPolicy` interface + defaults helper.
    - `ActivityContext`, `WorkflowContext` runtime context types.
    - `canonicalJSON`, `canonicalJSONStrict`, `parseCanonical`, `JsonLike`.
    - `sha256Hex`, `sha256OfCanonical`, `keccak256Hex`, `ZERO_HASH`.
    - Error classes: `NotImplementedError`, `ActivityFailedError`, `PortClosedError`, `TransferFailedError`, `CwlExportError`, `DuplicateRunIdError`.
- **SQLite schema** (created by `openSqliteStore` with `IF NOT EXISTS`):
  - `idempotency_keys` — claim/complete/fail/reclaim lifecycle, scope-driven TTL (24h `http:`, 30d `onchain:`, 7d `workflow:`, sentinel `evidence:`).
  - `events` — append-only, hash-chained per aggregate, ALCOA+ compliant. UNIQUE `(aggregate_type, aggregate_id, sequence)`.
  - `step_results` — Inngest-style memoized step output cache.
  - `workflow_runs` — per-run cursor + state + parent linkage.
  - `data_locations` — CID/path tracking per data-port output.
  - `schema_version` — migration sentinel.
- **Tests**: 146 tests across 15 test files in `__tests__/` covering canonical JSON + sha256/keccak256 hashing, SQLite store + WAL mode + all five sub-stores, idempotency lifecycle (claim → complete, claim → reclaim stuck, mismatch, TTL prune), event store hash-chain integrity + per-aggregate read + verifyChain, step-result memoization, activity define + retry math + non-retryable patterns + 3-tier key derivation + on-chain semantic key, workflow engine start → step → activity → signal → resume after crash, data-port put/get/close/backpressure/CID handoff, versioning marker emission + replay branch selection, CWL export snapshot + namespace correctness.
- **Documentation**:
  - `packages/workflow/README.md` — full public-API rewrite with three quick-starts (single Activity, full Workflow, CWL export), config table, Mermaid architecture diagram, limitations table.
  - `docs/WORKFLOW_RUNTIME.md` — repo-root deep dive: T1–T5 problem mapping, architecture, adoption guide with worked migration sketch, migration phases (lifted from design §11), operational notes (SQLite path, backup, vacuum, growth), performance section (TBD: bench in v0.2), FAQ.
  - `packages/workflow/examples/job-lifecycle.ts` — runnable worked example mirroring the migration target for `escrow.ts` + `protocol-runner.ts`.

### Known limitations

These are intentional cuts to keep v0.1 shippable. All have a defined landing window; tracked against the design doc §12 open questions.

- **`ctx.sleep(id, ms)` throws `NotImplementedError`** — durable timers require a `scheduled_at` poller (~100 LOC) and are deferred to v0.2. Workaround: `setTimeout` inside `ctx.step` for non-durable delays.
- **No child workflows** — `workflow_runs.parent_run_id` column exists but no `ctx.startChild()` API. Workaround: call `engine.start(...)` from inside a `ctx.step` (but lineage isn't auto-tracked). Lands in v0.2.
- **No per-activity `timeoutMs`** — execution is bound only by `RetryPolicy.maximumAttempts` and the handler's own internal timeouts. ~20 LOC addition planned for v0.1.1: `Activity.define({ timeoutMs })` wraps the handler in `Promise.race`.
- **Single-process signal delivery** — `handle.signal(...)` only reaches workflows running in the same Node process. Cross-process delivery requires a `SignalRouter` extension (Postgres LISTEN/NOTIFY or Redis pub/sub). Lands in v0.2.
- **No formal benchmarks** — order-of-magnitude expectations only. Bench harness lands in v0.2 under `packages/workflow/bench/`.
- **No tree archive helper** — `events` table is append-only and grows ~150 MB/month at 10k runs/month. Manual archive to Storacha + DELETE is supported via the `storage_cid` column; no convenience wrapper ships in v0.1.

### Status

Not yet merged. Ships on branch `feat/workflow-runtime`. Phase 1 migration (`escrow.ts` route handlers) is the next adoption step — see `docs/WORKFLOW_RUNTIME.md` §4 for the migration phases.
