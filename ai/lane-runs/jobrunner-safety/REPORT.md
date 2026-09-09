# JobRunner safety boundary — G-8c / R-11

**Agent**: jobrunner-safety-implementer-1
**Branch**: `fix/jobrunner-safety-boundary` off `lamasu/master` @ `7a864910`
**Date**: 2026-09-08

## Outcome

DONE. Both JobRunner actuation sites now route through `SafetyGateway.validateAndRelay()`,
the negative control passes (a prohibited command produces **zero** `machine.execute`
calls), and the full `@pcc/kernel` suite is green: **877 passed / 877, 38 files**,
typecheck exit 0. Three commits, no changes outside `packages/kernel`, no new deps.

One blocking integration item for the steward, stated up front because it is a
behaviour change, not a caveat: **`load_gcode` and `start` are class `"scoped"`, so a
job dispatched without an execution scope is now denied.** Four of the six JobRunner
construction sites live outside `packages/kernel` and do not thread a `scopeId`, so
their jobs will fail closed until they do. The fields they need already exist
(`SubmitJobParams.scopeId` / `.agentDid`, kernel-service.ts:34-35) — see
[Integration gap](#integration-gap-blocking-1-line-per-site).

---

## Design note (written before editing)

1. **Mapping.** A `MachineCommand` becomes a `PhysicalCommand` in one exported pure
   function, `toPhysicalCommand(command, deviceId, ctx)` (job-runner.ts:75).
2. `commandId` = `` `${jobId}:${stepId}:${command.type}` `` — deterministic and
   greppable in the governor's audit trail.
3. `deviceId` = `machine.id`. `params` = `command.payload ?? {}` — **the same object
   reference**, never a copy, so no validate-then-mutate gap is even expressible.
4. `class` comes from a fixed table `MACHINE_COMMAND_CLASS` (job-runner.ts:49):
   `load_gcode`→`scoped`, `start`→`scoped`, `pause`/`resume`/`stop`→`safe`,
   `status`→`read`. Rationale: governor.ts:38 defines Class 3 as "protocol upload, run",
   which is exactly what these two commands are. The table does **not** vary with
   whether a `scopeId` happens to be present — that downgrade is what makes a check vacuous.
5. `agentDid` = `config.agentDid ?? did:pcc:device:<machine.id>`. The default buckets the
   governor's 60/min rate limit **per device**; a per-job default would never rate-limit,
   since a job issues only two commands.
6. `scopeId` = `config.scopeId`. The governor has no scope registry — `isClassAllowed`
   (governor.ts:195-206) is literally `return !!cmd.scopeId` for class `scoped`. There is
   no open/close API to call, so JobRunner threads the caller's scope and does **not**
   mint one. Minting a scope inside JobRunner would be the bypass this item exists to close.
7. **Gateway acquisition**: optional 5th constructor arg (job-runner.ts:159), defaulting
   at `run()` time to the `getSafetyGateway()` singleton.
8. **Default posture, honestly stated**: a default `SafetyGateway()` **admits nearly
   everything**. No e-stop, no maintenance, no LOTO, empty breaker, 60 cmd/min, and the
   envelope checks (velocity/temperature/force) only fire when those keys appear in
   `params` — `load_gcode`'s payload is `{gcodeHash}`, so **none of them apply**. The
   *only* default-config check that actually bites a job command is the class check.
9. Therefore the scoped classification is what makes this enforcement real rather than
   decorative, and the negative control is built on it.
10. `getSafetyGateway()` throws when uninitialized. JobRunner catches that and **fails
    closed** (`success:false`, zero adapter contact) rather than dispatching unchecked —
    a missing gateway is a wiring error, not permission to skip admission.

---

## What was actually wrong

`job-runner.ts` had zero references to `safety`, `SafetyGateway`, `validate` or
`governor`. It held the only `MachineAdapter` reference during a job and called
`this.machine.execute(...)` directly at :100 and :132.

There *was* an admission check upstream, and reading it is what makes R-11 concrete —
`packages/gateway/src/services/kernel-service.ts:236-266`:

```ts
const cmdClass = params.scopeId ? "scoped" : "safe";       // :241
...
const preflightCmd = {
  commandId: `preflight:${jobId}`,
  type: "submit_job",                                       // :252
  params: { jobId, stepId, gcodeHash, assuranceTier },
  ...
};
const preflight = await gateway.validateOnly(preflightCmd); // :261
```

Two defects, both of which this change closes at the dispatch boundary:

- It validates a **synthetic** command (`type: "submit_job"`, params = job metadata).
  Nothing about the `load_gcode`/`start` that actually reach hardware is inspected.
- `params.scopeId ? "scoped" : "safe"` **downgrades the class when the credential is
  absent**, so the one check that bites can never fail. An unscoped job passes admission
  as `"safe"` and then actuates.

---

## Files changed

| File | Lines | Change |
|---|---|---|
| `packages/kernel/src/job-runner.ts` | 4-93 | Safety-boundary doc header; imports; `MACHINE_COMMAND_CLASS` table (:49); `DispatchContext` (:63); `toPhysicalCommand()` (:75) |
| | 110-133 | `JobConfig.scopeId` (:122) and `JobConfig.agentDid` (:130) |
| | 143-238 | `injectedGateway` field; 5th constructor arg (:159); `resolveGateway()` (:172, fail-closed); `dispatch()` (:190) |
| | 224-238 | `run()` resolves the gateway + builds `DispatchContext` before touching any adapter |
| | 261-280 | Phase 1 `load_gcode` via `dispatch()`; denial returns `safety: <reason>` and stops the job |
| | 300-315 | Phase 4 `start` via `dispatch()`; same denial contract |
| `packages/kernel/src/__tests__/job-runner-safety.test.ts` | new, 426 | 14 tests (below) |
| `packages/kernel/src/__tests__/tier-enforcement.test.ts` | 12-17, 355-380, +7 configs | Setup only — see note |

**Sentry spans preserved**: `job.load_gcode` and `job.start_execution` still wrap the
phases; `dispatch()` runs inside them, so a denial is visible on the span.

**Note on `tier-enforcement.test.ts`**: its 7 JobRunner integration tests never
initialized a gateway and never supplied a scope, so after the change all 6 assertions
in them hit the fail-closed path. I updated their **setup** — `resetSafetyGateway()` +
`initSafetyGateway()` in `beforeEach`, `afterEach` reset, and `scopeId: TEST_SCOPE` in
each `run()` config. **No assertion was changed, removed, or relaxed**, and no check was
made permissive. Those tests exercise tier gating; satisfying a legitimate new
precondition is setup, and the boundary itself is asserted in the new file. The
per-test gateway reset also stops one test's device failures from tripping the shared
breaker for the next (all mocks share `dev-mock-001`).

---

## Test run

```
$ pnpm --filter @pcc/kernel test          # vitest run --passWithNoTests

 ✓ src/__tests__/encryption-service.test.ts  (7 tests) 6ms
 ✓ src/__tests__/printer-job.test.ts  (9 tests) 152ms
 ✓ src/__tests__/kernel-registration-proof.test.ts  (4 tests) 216ms
 ✓ src/__tests__/log-capture.test.ts  (25 tests) 794ms
 ✓ src/__tests__/evidence-storage.test.ts  (9 tests) 1034ms
 ✓ src/__tests__/printer-log-adapter.test.ts  (19 tests) 3123ms

 Test Files  38 passed (38)
      Tests  877 passed (877)
   Start at  15:49:15
   Duration  4.50s (transform 3.41s, setup 0ms, collect 16.18s, tests 8.02s, environment 7ms, prepare 2.81s)
```

New file in isolation:

```
$ pnpm --filter @pcc/kernel exec vitest run src/__tests__/job-runner-safety.test.ts

 ✓ src/__tests__/job-runner-safety.test.ts  (14 tests) 165ms

 Test Files  1 passed (1)
      Tests  14 passed (14)
```

Typecheck:

```
$ pnpm --filter @pcc/kernel exec tsc --noEmit -p .
exit=0
```

(`packages/spec` and `packages/a2a` had to be built once in this fresh worktree —
`pnpm --filter @pcc/spec build && pnpm --filter @pcc/a2a build` — before either
command resolves `@pcc/spec`. No source change was needed for that.)

### Iterations

One implement→test cycle, then one red test. The red was my assertion, not the code:
I expected `"E-stop is engaged"` in `JobResult.error`, but governor.ts:139 returns the
family reason `"Hardware interlock active"` on the interlock path and keeps the specific
detail in `verdict.checks[]`, which `JobResult` does not carry. I corrected the
expectation to the string the governor actually produces (and pinned it with `toBe`,
not `toContain`). No production code was changed to make a test pass.

---

## Negative-control evidence

The memo's control — a prohibited command must cause zero actuation.
`packages/kernel/src/__tests__/job-runner-safety.test.ts:254-272`:

```ts
it("NEGATIVE CONTROL: a job with no execution scope calls machine.execute ZERO times", async () => {
  const gateway = new SafetyGateway();
  const machine = makeMockMachine();
  const runner = new JobRunner(machine, [], null, emitter, gateway);

  const result = await runner.run({
    jobId: "job-unscoped-1",
    stepId: "step-1",
    gcodeHash: GCODE_HASH,
    assuranceTier: 0,
    // no scopeId — load_gcode/start are class "scoped", so this is prohibited
  });

  // THE ASSERTION THAT PROVES ZERO ACTUATION:
  expect(machine.execute).toHaveBeenCalledTimes(0);

  expect(result.success).toBe(false);
  expect(result.error).toMatch(/^safety: /);
  expect(result.error).toContain("scope");
});
```

**Which prohibition this is, precisely**: the missing execution scope. That is the one
the `SafetyGovernor` genuinely enforces under its default config —
`isClassAllowed()` (governor.ts:195-206) returns `!!cmd.scopeId` for class `scoped`, and
`load_gcode`/`start` are classified `scoped` unconditionally. Denial reason:
`safety: Class 'scoped' requires active scope`.

Two further real prohibitions, same zero-actuation assertion:

- **E-stop** (`:275-293`) — `new SafetyGateway({ initialHardwareState: { isEStopEngaged: true } })`
  with a valid `scopeId`. Economically authorized *and* scoped, still denied:
  `expect(machine.execute).toHaveBeenCalledTimes(0)` and
  `expect(result.error).toBe("safety: Hardware interlock active")`.
- **Open circuit breaker** (`:296-314`) — `gateway.recordDeviceFailure(DEVICE_ID)` with
  `failureThreshold: 1`, then a scoped job: zero calls, `"Circuit breaker OPEN"`.
- **Uninitialized gateway** (`:317-334`) — no injection, singleton reset: zero calls,
  `"safety: safety gateway unavailable"`. Fail-closed.

**Short-circuit control** (`:342-366`), a tier-2 job denied at phase 1:

```ts
expect(machine.execute).toHaveBeenCalledTimes(0);
expect(sensor.startRecording).not.toHaveBeenCalled();
expect(sensor.stopRecording).not.toHaveBeenCalled();
expect(camera.captureSnapshot).not.toHaveBeenCalled();
expect(camera.runInspection).not.toHaveBeenCalled();
```

plus `:369-385`, which asserts the failure reason is the safety reason and **not**
`"requirements not met"` — proving the pipeline stopped at phase 1 rather than running
to the tier check.

**Positive control / no validate-then-mutate gap** (`:205-222`):

```ts
const validatedLoad = relaySpy.mock.calls[0][0] as PhysicalCommand;
const executedLoad  = machine.received[0];

// Reference identity: the params the governor inspected ARE the payload
// object the adapter received. Nothing was swapped in between.
expect(validatedLoad.params).toBe(executedLoad.payload);
```

`toBe` is reference equality, so this fails if any copy, merge or re-serialize is ever
introduced between admission and dispatch. The companion test asserts exactly two
`machine.execute` calls, `["load_gcode","start"]` in order, both `class: "scoped"`, both
carrying the scope, with commandIds `job-admitted-1:step-1:load_gcode` / `...:start`.

---

## Six-site inventory (report only — MS-11 input)

| # | Site | Reachable from a live HTTP route in the deployed gateway? |
|---|---|---|
| 1 | `packages/gateway/src/services/kernel-service.ts:102` (`initAdapters`, from `KERNEL_CONFIG`) | **YES** — `POST /api/setup/test-job` (`routes/setup.ts:814` → `svc.submitJob` → `runner.run` at kernel-service.ts:311). This is the network-reachable path. |
| 2 | `packages/gateway/src/services/kernel-service.ts:160` (`installMachineFromDbRow`) | **YES** — same `submitJob` path; this runner is the one installed by `POST /api/setup/register-device` (via `refreshDeviceFromDb`) and by `loadDbDevicesIntoRuntime()` at construction, so it serves the operator's *real* device. |
| 3 | `packages/agent-kernel/src/kernel-agent.ts:406` | **YES, indirectly** — `packages/gateway/src/agent-bridge.ts:76` does `new KernelAgent(...)`, and `server.ts:1037` calls `initAgentBridge()`. Jobs enter via the message bus (`kernel-agent.ts:314` `jobQueue.push` → `:318` `processQueue`), not via a route path, so the reachable *entry* is the agent bus rather than a URL. Worth a second look by the gateway reviewer. |
| 4 | `packages/kernel/src/server.ts:164` | **NO (separate process)** — `POST /execute` on the standalone kernel server (`buildServer`, exported at `kernel/src/index.ts:92`). Nothing in `packages/` imports it except a comment in `adapter-factory.test.ts`; it is the on-prem/dev kernel daemon, not the deployed gateway. Still a real actuation path for an operator running it. |
| 5 | `packages/onboard-kit/src/quick-start.ts:196` | **NO** — dev/example one-command onboarding helper. |
| 6 | `packages/onboard-kit/src/scaffolder.ts:646` | **NO** — this one is inside a template string; it *generates* kernel source for a scaffolded operator project. Generated code will need the scope threaded too, but nothing executes it in this repo. |

### Integration gap (blocking, ~1 line per site)

`SubmitJobParams` **already** carries both fields the boundary needs
(`kernel-service.ts:32-35`):

```ts
  /** DID of the requesting agent (for safety audit trail) */
  agentDid?: string;
  /** Execution scope ID (required for class-3 / scoped commands) */
  scopeId?: string;
```

but `kernel-service.ts:311-320` does not pass either into `runner.run()` — the config is
`{ jobId, stepId, gcodeHash, assuranceTier, onPhase }`. The gateway even mints a real
scope per paid job (`routes/paid-job-flow.ts:652`, table `executionScopes`). So the fix
at sites 1-2 is adding `scopeId: params.scopeId, agentDid: params.agentDid` to that
call. Sites 3-6 need whatever scope their caller holds. **I did not make these changes —
they are outside `packages/kernel`.**

I did not run the full `@pcc/gateway` suite, but I ran the five gateway test files that
mention `submitJob`/`test-job`: `kernel-service-safety` (2), `setup` (37),
`paid-job-flow-dispatch` (3), `pipeline-telemetry-coverage` (15), `tracing` (18) —
**75 passed, 0 failed**. That green is *not* evidence the gateway path still works:
`setup.test.ts:22-51` mocks the whole KernelService module (`submitJob` is a `vi.fn()`
returning `{status:"accepted"}` and `getJobStatus` a `vi.fn()` returning
`{status:"completed"}`), and `submitJob` is fire-and-forget — it returns `"accepted"`
before `runner.run()` resolves, so a denial only surfaces later as a `failed` job row.
**No existing gateway test would catch this.** The runtime consequence follows from
reading kernel-service.ts:311-320 (no `scopeId` in the config) plus the kernel test
above proving that exact config shape yields denial with zero actuation.

---

## Honest gaps — what is NOT enforced

1. **The other five construction sites still dispatch unscoped** (above). Until they
   thread a scope, they fail closed — safe, but non-functional. Sites 4-6 are separate
   processes/templates and are not fixed by this change at all.
2. **`kernel-service.ts:241`'s `params.scopeId ? "scoped" : "safe"` downgrade is still
   there.** I could not touch it. It no longer lets a command reach hardware unchecked
   (JobRunner re-checks with a fixed class), but it still means the upstream pre-flight
   reports "admitted" for an unscoped job that JobRunner will then deny. Recommend
   deleting the ternary in the follow-up.
3. **JobRunner has no pause/resume/stop path.** `MACHINE_COMMAND_CLASS` classifies them
   for completeness, but nothing in this class issues them. Wherever those commands are
   issued (operator routes, adapters), they are outside this boundary.
4. **Adapters that reach hardware outside `machine.execute` are unguarded.** In
   particular `waitForCompletion()` (`job-runner.ts:386`) calls `this.machine.getProgress()`
   and `getStatus()` directly — these are `read`-class polls that the governor would
   always admit, so routing them adds no protection, but they are literally hardware
   contact that does not pass the gateway. Anything an adapter does in its own
   constructor, `onEvidence` wiring, or `dispose()` is likewise outside.
5. **The default envelope does not constrain a print job.** velocity/temperature/force
   checks (governor.ts:223-263) only fire when those keys are in `params`;
   `load_gcode`'s payload is `{gcodeHash}` and `start`'s is empty. Nothing inspects the
   G-code itself. `allowedGcodes` and `forbiddenPatterns` exist in `OperationalEnvelope`
   but are unset by default and unused by this path. **Physical-envelope enforcement for
   the actual toolpath does not exist yet** — the class check is what is real today.
6. **Breaker/governor state is per-process RAM** — already flagged in gateway.ts:227-232.
   N gateway instances hold N breaker truths and a deploy resets a tripped breaker.
   Unchanged by this work.
7. **`validateAndRelay` records a breaker failure for a self-reported
   `{success:false}`** (gateway.ts:173-183). That is the pre-existing contract and the
   new `dispatch()` inherits it; the last test in the new file pins that behaviour end
   to end. It does mean a device that legitimately rejects a bad G-code counts toward
   tripping its own breaker.
8. **Evidence does not record the commandId.** Step 3 of the brief said to do this only
   if a natural hook existed. `EvidenceEmitter.addEvent` takes adapter-emitted events;
   there is no hook for the runner to attach a dispatch record without new plumbing, so
   I did not build one. The commandId is deterministic
   (`<jobId>:<stepId>:<type>`) and appears in the governor's verdict, so the audit trail
   is reconstructable, but it is not in the signed bundle.

---

## Commits

```
$ git log --oneline 7a864910..HEAD
3b8db45f jobrunner-safety-impl: negative-control tests for the JobRunner safety boundary
4f081d4e jobrunner-safety-impl: route JobRunner actuation through SafetyGateway
```

(this report is committed on top)

---

## Gateway follow-up (jobrunner-safety-gateway-followup-1)

**Branch**: `fix/jobrunner-safety-boundary-gw` off `b1be6cfe`
**Date**: 2026-09-08

### Design note (written before editing)

1. **(a) Paid path — the scope exists, but never meets a dispatch.**
   `createJobFromSession` (paid-job-flow.ts:656) mints a real scope into
   `execution_scopes` (`jobId`, `kernelId`, `status:"active"`, 1h `expiresAt`)
   — but it **never calls `submitJob`**. It inserts the job row (`queued` when
   external, `pending`/`active` when local) and returns; execution is
   out-of-process, by an operator daemon polling `GET /api/operator/jobs`
   (operator-relay.ts:75, a read-only poll). **There is no `submitJob` call site
   in paid-job-flow.ts**, so the brief's step-3 premise ("add that one line at
   the call site") does not hold, and I added no line there.
2. **(b) test-job path — no scope, and none to mint.** `routes/setup.ts:814`
   builds `{jobId, stepId, deviceId, assuranceTier}`. Nothing on that path mints
   a scope. It therefore **fails closed** at the pre-flight with an explicit
   safety reason. I did **not** mint one to make it pass.
3. **The only two in-process dispatchers are `job.facade.ts:293`
   (`POST /api/jobs/submit`) and `routes/setup.ts:814`** — neither holds a
   scope, and both are outside the file boundary this lane was given.
4. **Considered and rejected: resolving the scope from the DB by `jobId`**
   inside `submitJob`. It would be dead code — `repos.jobs.insert`
   (packages/db/src/repositories/jobs.ts:54) is a plain insert with no
   `onConflict`, so re-submitting a paid job's `jobId` through
   `POST /api/jobs/submit` throws on the primary key *before* reaching
   `submitJob`. No live caller can present a `jobId` that owns a scope row.
   Beyond being unverifiable, inheriting authority from an ambient row keyed by
   a caller-supplied id is strictly weaker than threading it explicitly.
5. **Consequence, stated plainly:** this change makes `KernelService` *carry* a
   scope and makes the pre-flight *honest*. It does **not** make
   gateway-dispatched jobs run, because no in-process caller mints a scope.
   That is the correct fail-closed state; the remaining work is producer-side,
   in files this lane was scoped out of.

### Outcome

PARTIAL, and the shortfall is a scope boundary, not an unfinished edit. The
threading and the downgrade removal are **done and proven**: `@pcc/gateway` is
**2983 passed / 4 failed / 6 skipped**, typecheck **exit 0, zero errors**.

All 4 failures are in `job-submit.test.ts` and all 4 have one cause: the
`POST /api/jobs/submit` route supplies no execution scope, so the boundary now
denies it. **1 of the 4 was already red at `b1be6cfe`**, before I touched
anything; the other 3 are caused by this change and are the honest, loud version
of a failure that was previously silent. Fixing them requires a producer-side
change in `facades/job.facade.ts`, which this lane was explicitly scoped out of
— and *which one-line change is right there is a security decision for the
steward, not a mechanical fix.* See
[Remaining producer-side gap](#remaining-producer-side-gap).

Measured, not asserted — full `@pcc/gateway` suite run twice, once with
`kernel-service.ts` reverted to `b1be6cfe` via `git checkout`, once with it
restored, both with the new test file present:

| | baseline (`b1be6cfe` code) | with this change |
|---|---|---|
| Passed | 2981 | **2983** |
| Failed | 6 | **4** |
| — `job-submit.test.ts` | 1 | 4 (+3) |
| — `kernel-service-scope.test.ts` (new) | 5 | 0 (−5) |

**5 of the 7 new tests fail against the un-fixed code and pass against the
fixed code.** They are regression detectors, not decoration. (The other 2 pass
either way: the layer-2 test passes at baseline because JobRunner already
denied, and the scoped-class test passes because with a `scopeId` present the
old ternary also produced `"scoped"` — its unscoped twin is the one that bites.)

### What was actually wrong

Three defects, not the one the brief anticipated.

1. **`runner.run()` got no scope** — at *two* call sites, not one. The brief
   named `:311`; there is a second, near-identical fire-and-forget block at
   `:399` that runs whenever Sentry is uninitialised. That is the path most
   tests and self-hosted deployments take, so threading only the first would
   have left the fix half-applied and passing its own tests.
2. **The pre-flight downgraded its own class** (`:241`). Removed.
3. **The breaker double-counted, and blamed the device for the caller's
   missing credential.** Not in the brief — found by running the tests.
   `JobRunner.dispatch()` now goes through `validateAndRelay()`, which records
   each command's outcome against the device breaker. `kernel-service` *also*
   recorded once per job. So a `failureThreshold` of 2 tripped after ONE failing
   job, and — worse — a job denied for want of a scope, which never touches the
   adapter, was recorded as a **device** failure. An unauthorised caller could
   therefore trip a healthy device's breaker and deny service to everyone else.
   This is also why `job-submit.test.ts`'s "auto-select device" test was already
   red at `b1be6cfe`: repeated unscoped submits marked the mock device failed
   until its breaker opened. Removed the per-job recording on the success path;
   the `.catch()` path still records, because a rejected `run()` never reached
   the dispatch boundary at all.

### Files changed

| File | Change |
|---|---|
| `packages/gateway/src/services/kernel-service.ts` | `scopeId`/`agentDid` into `runner.run()` at **both** call sites; `cmdClass` fixed at `"scoped"`; per-job breaker recording removed from both success paths; three stale comments corrected |
| `packages/gateway/src/__tests__/kernel-service-scope.test.ts` | **new**, 7 tests |
| `packages/gateway/src/__tests__/kernel-service-safety.test.ts` | **setup only** — `scopeId` on 3 `submitJob` calls |
| `packages/gateway/src/__tests__/tracing.test.ts` | **setup only** — `scopeId` on 2 `submitJob` calls |

**Not touched**: `packages/kernel`, `paid-job-flow.ts` (no `submitJob` call site
exists there to add a line to — see design note 1), `job.facade.ts`,
`routes/setup.ts`, `kernel-agent.ts`, settlement, escrow, evidence. No new
dependencies.

**On the two setup-only edits**: `kernel-service-safety` and `tracing` submit
unscoped jobs, which the boundary now denies before their subjects (breaker
accounting, span shape) are ever reached. I added a `scopeId` to their setup.
**No assertion was changed, removed or relaxed, and no check was made
permissive.** The breaker test's original arithmetic — closed after 1 job, open
after 2, at `failureThreshold: 2` — passes *unchanged* once the double-count is
fixed, and that is precisely what confirms defect 3 was real rather than my
mis-reading. Worth noting that test was passing at baseline **for the wrong
reason**: a safety denial was being counted as the "real device failure" its
name claims to test, and the adapter was never reached at all.

### Test run

```
$ pnpm --filter @pcc/gateway exec vitest run \
    src/__tests__/kernel-service-scope.test.ts \
    src/__tests__/kernel-service-safety.test.ts \
    src/__tests__/tracing.test.ts \
    src/__tests__/paid-job-flow-dispatch.test.ts \
    src/__tests__/setup.test.ts \
    src/__tests__/pipeline-telemetry-coverage.test.ts

 ✓ src/__tests__/pipeline-telemetry-coverage.test.ts  (15 tests) 6ms
 ✓ src/__tests__/kernel-service-safety.test.ts  (2 tests) 70ms
 ✓ src/__tests__/kernel-service-scope.test.ts  (7 tests) 183ms
 ✓ src/__tests__/tracing.test.ts  (18 tests) 488ms
 ✓ src/__tests__/setup.test.ts  (37 tests) 330ms
 ✓ src/__tests__/paid-job-flow-dispatch.test.ts  (3 tests) 139ms

 Test Files  6 passed (6)
      Tests  82 passed (82)
   Duration  3.38s
```

Full suite (honestly red — see Outcome):

```
$ pnpm --filter @pcc/gateway test

 FAIL  src/__tests__/job-submit.test.ts > POST /api/jobs/submit > accepts a valid job and returns immediately
 FAIL  src/__tests__/job-submit.test.ts > POST /api/jobs/submit > uses provided jobId when given
 FAIL  src/__tests__/job-submit.test.ts > POST /api/jobs/submit > accepts optional assuranceTier and gcodeHash
 FAIL  src/__tests__/job-submit.test.ts > GET /api/devices/:kernelId > auto-select device: deviceId in response matches mock adapter

 Test Files  1 failed | 187 passed (188)
      Tests  4 failed | 2983 passed | 6 skipped (2993)
   Duration  23.00s
```

All four are `expected 500 to be 200` (and one consequent `expected undefined to
be 'dev-test-machine'`), from `[safety-gateway] Job <id> denied: Class 'scoped'
requires active scope`.

Typecheck:

```
$ pnpm --filter @pcc/gateway exec tsc --noEmit -p .
exit=0     # 0 errors
```

(This worktree needed `pnpm --filter "@pcc/gateway^..." build` once before tsc
resolves the workspace packages — vitest reads them from source via its config
alias, tsc needs the emitted `.d.ts`. No source change was required for that.)

### Negative-control evidence

The control the lane exists for — a prohibited command must cause zero
actuation. `packages/gateway/src/__tests__/kernel-service-scope.test.ts`:

```ts
it("denies an unscoped submission and calls machine.execute ZERO times", async () => {
  const svc = new KernelService(makeConfig());

  await expect(
    svc.submitJob({
      jobId: "ks-scope-unscoped-1",
      stepId: "s",
      assuranceTier: 0,
      deviceId: DEVICE_ID,
      // no scopeId — load_gcode/start are class "scoped", so this is prohibited
    }),
  ).rejects.toThrow(/Class 'scoped' requires active scope/);

  // THE ASSERTION THAT PROVES ZERO ACTUATION:
  expect(executed).toHaveLength(0);

  expect(await svc.getJobStatus("ks-scope-unscoped-1")).toMatchObject({ status: "unknown" });
});
```

That covers layer 1 (the synchronous pre-flight). Because a boundary asserted at
only its outer layer will rot at the inner one unnoticed, layer 2 is pinned
separately — with the pre-flight deliberately stubbed to **fail open**:

```ts
const realValidateOnly = gw.validateOnly.bind(gw);
vi.spyOn(gw, "validateOnly").mockImplementation(async (cmd) => {
  if (typeof cmd?.commandId === "string" && cmd.commandId.startsWith("preflight:")) {
    return { allowed: true, executed: false } as Awaited<ReturnType<typeof realValidateOnly>>;
  }
  return realValidateOnly(cmd);          // runner's own checks hit the REAL governor
});
...
expect(accepted.status).toBe("accepted");                       // admission bypassed
await waitFor(() => getRepos().jobs.findById(jobId)?.status === "failed");
expect(executed).toHaveLength(0);                               // still zero actuation
expect(getRepos().jobs.findById(jobId)?.status).toBe("failed");
```

Only `preflight:*` commandIds are waved through — `job-runner` builds
`<jobId>:<stepId>:<type>`, so its own `validateOnly` calls, made from inside
`validateAndRelay`, still meet the real governor with the real config.

And the deleted downgrade is pinned directly:

```ts
// The old line was `params.scopeId ? "scoped" : "safe"`, so an unscoped job was
// described to the governor as "safe" — the one class the default config always
// admits — and admission could therefore never fail. "safe" here is the bug.
expect(preflight!.class).toBe("scoped");
expect(preflight!.scopeId).toBeUndefined();
```

Plus a control for defect 3, which has real denial-of-service consequences:

```ts
// A missing credential is the CALLER's fault, not the device's. Counting it as a
// device failure would let an unauthorised caller trip a healthy device's
// breaker and deny service to everyone else.
expect(gw.getStatus().circuits.get(DEVICE_ID)?.failures ?? 0).toBe(0);
```

### Remaining producer-side gap

**This is the blocking item, and it did not move.** The lane's premise was that
threading the scope through `kernel-service` would make gateway-dispatched jobs
work again. It does not, because **no in-process gateway caller has a scope to
thread.** The producer side must change:

| Caller | Has a scope? | Needed | Touched? |
|---|---|---|---|
| `facades/job.facade.ts:293` (`POST /api/jobs/submit`) | **No** | Accept `scopeId` on `SubmitJobInput` and pass it — plus a decision about what happens when a caller omits it | **No** — outside the file boundary |
| `routes/setup.ts:814` (`POST /api/setup/test-job`) | **No**, and nothing on that path mints one | A decision: does an operator self-test actuate under a scope, or is it exempt? | **No** |
| `routes/paid-job-flow.ts:656` | **Yes** — mints one per paid job | Nothing here; it never calls `submitJob` | **No** — no call site exists to change |

The one-line fix the brief expected does not exist, because the producer of the
scope and the caller of `submitJob` are **different code paths that never meet**.
Bridging them is a design decision (does `POST /api/jobs/submit` require a
client-supplied scope from the existing minting API at `device-relay.ts:708`, or
does the route mint one on the operator's behalf?), and I will not pre-empt it by
minting a scope inside the service.

Note also that the denial currently surfaces as **HTTP 500**
(`job_submission_failed`) because the facade re-throws. A missing authorisation
credential is a **4xx**, not a server error — worth fixing in the same
producer-side pass.

### Honest gaps — what is NOT enforced

Carrying forward the six-site inventory from the kernel lane, per site:

1. **`kernel-service.ts:102`** (`initAdapters`) — **now threaded.** Fails closed
   until a caller supplies a scope.
2. **`kernel-service.ts:160`** (`installMachineFromDbRow`) — **now threaded**,
   same runner path, same caveat.
3. **`packages/agent-kernel/src/kernel-agent.ts:406`** — **NOT touched.** Still
   dispatches unscoped, so agent-bus jobs fail closed. I had permission to touch
   this call site but no evidence of where its scope would come from; guessing
   one would be the same fabrication I refused elsewhere.
4. **`packages/kernel/src/server.ts:164`** — **NOT touched** (separate process,
   and `packages/kernel` is off-limits to this lane). Standalone kernel daemon's
   `POST /execute` still dispatches unscoped.
5. **`packages/onboard-kit/src/quick-start.ts:196`** — **NOT touched.** Dev/example helper.
6. **`packages/onboard-kit/src/scaffolder.ts:646`** — **NOT touched.** Inside a
   template string; generated operator projects will need the scope threaded too.

Further gaps introduced or left standing by *this* change:

7. **`agentDid` has two different defaults on one job.** The pre-flight falls
   back to `"kernel-service"` (pre-existing, `:254`); `JobRunner` falls back to
   `did:pcc:device:<machineId>`. So an unattributed job is rate-limited in two
   different buckets and appears under two identities in the audit trail. I left
   both as-is rather than change rate-limit behaviour in a safety lane, but they
   should be reconciled.
8. **The pre-flight still validates a synthetic command.** `type: "submit_job"`
   with job metadata as `params` — nothing about the actual `load_gcode`/`start`
   is inspected there. It is now honest about its *class*, which is what made it
   vacuous, but it is still not the command that reaches hardware. The real
   check is JobRunner's, and that is the one the layer-2 test pins.
9. **`MACHINE_COMMAND_CLASS` is duplicated by value, not imported.** It is
   module-private in `job-runner.ts` and not re-exported from `@pcc/kernel`, and
   I could not touch that package to export it. If that table ever changes,
   `kernel-service.ts:~258` must be updated by hand — nothing enforces it. The
   cheapest permanent fix is exporting the table from `@pcc/kernel` and importing
   it here.
10. **A `.catch()`-path failure is still recorded as a device failure.** Left
    deliberately (a rejected `run()` never reached the dispatch boundary, so
    nothing else records it), but a runner bug or an evidence/storage error will
    still be charged to the device's breaker. Narrower than before, not gone.
11. **Everything the kernel lane listed as unenforced remains unenforced** —
    no G-code inspection, no physical envelope for the toolpath, per-process
    breaker state, and no `commandId` in the signed evidence bundle. Unchanged
    by this work.

### Commits

```
$ git log --oneline b1be6cfe..HEAD
3b560f58 jobrunner-safety-gw: tests for gateway execution-scope threading
4c8d7f6a jobrunner-safety-gw: thread the execution scope into JobRunner and stop the class downgrade
4704fad1 jobrunner-safety-gw: design note for the gateway scope-threading follow-up
```

(this section is committed on top)

---

## Producer follow-up (jobrunner-safety-producer-1)

### Outcome

**Done.** Both in-process job producers now mint an execution scope at job
creation and pass it to `submitJob`, so gateway-dispatched jobs run again while
the safety boundary keeps denying unscoped dispatch. Full `@pcc/gateway` suite
green (189 files / 2995 tests), `tsc --noEmit` clean, the 4 red `job-submit`
tests green with **no edits to them**, and the 7 `kernel-service-scope` + 14
`job-runner-safety` boundary tests untouched and green.

Three commits on `fix/jobrunner-safety-boundary-producer` on top of `b6c9c771`.

### Design note (written before editing)

1. **Helper.** `mintExecutionScope({ kernelId, jobId, createdBy, capabilityType?,
   allowedTools?, maxCommands?, maxRetries?, ttlMs?, createdAt? })
   -> { scopeId, agentDid, allowedTools, createdAt, expiresAt }`, in the new
   `packages/gateway/src/services/execution-scope-service.ts`. It inserts one
   `execution_scopes` row and throws on failure. It also owns
   `getWriteToolsForDeviceType` + `DEVICE_WRITE_TOOLS`, moved verbatim out of
   `routes/paid-job-flow.ts` — that move is the actual de-duplication, because it
   is what lets both producers derive an allowed-tool set without importing from
   a route module.
2. **`createdBy` per producer.** Facade: the authenticated principal, i.e. the
   `actorId` the route passes in (`req.operatorId ?? req.apiKeyId`). Test-job:
   the API-key holder, read the same way `register-device` already reads it in
   `setup.ts`. Both fall back to the sentinel `"unauthenticated"` when the
   request carries no principal — `execution_scopes.created_by` is NOT NULL and
   the audit trail is the point of the row, so an unauthenticated producer
   records *that* rather than inventing a plausible operator id.
3. **`allowedTools` per producer.** Facade: from the job's capability type
   (`body.capabilityType ?? capabilities.findById(resolvedCapabilityId)?.type`).
   Test-job: from `caps[0]?.type` on the target kernel, which for an unmapped or
   absent type yields the generic minimal write set
   `["device_start_job","device_pause","device_resume","device_cancel"]`.
4. **`agentDid`.** `did:pcc:<principal>`, passed through unchanged when the
   principal is already a `did:`. The governor buckets its per-minute rate limit
   by `agentDid`; `KernelService`'s fallback is the constant `"kernel-service"`,
   which lumps every caller into one bucket, so a per-principal DID is both more
   correct and more useful in the audit trail.
5. **Expiry / budget.** Facade: 1 h / 200 commands / 5 retries — identical to the
   paid path, since a real contracted job can run long. Test-job: **15 min / 50
   commands / 1 retry**, deliberately tighter, because `routes/device-relay.ts`
   resolves an active scope by `(kernelId, createdBy, status)` **without**
   filtering on `jobId` — so a generous, long-lived grant minted for a one-shot
   onboarding self-test would widen what that same principal can relay to that
   kernel afterwards.

### Files changed

```
$ git diff b6c9c771 --stat
 .../src/__tests__/producer-execution-scope.test.ts | 517 +++++++++++++++++++++
 packages/gateway/src/facades/job.facade.ts         |  61 ++-
 packages/gateway/src/routes/paid-job-flow.ts       |  62 +--
 packages/gateway/src/routes/setup.ts               |  49 ++
 .../src/services/execution-scope-service.ts        | 181 ++++++++
 5 files changed, 813 insertions(+), 57 deletions(-)
```

`packages/kernel`, `kernel-service.ts`, settlement, escrow and evidence are
untouched — `git diff b6c9c771 --name-only` restricted to `packages/kernel`,
`packages/gateway/src/services/kernel-service.ts` and
`packages/gateway/src/__tests__/kernel-service-scope.test.ts` returns nothing.

Both producers mint **after** the job row exists and **before** `submitJob`, and
only on paths that actually dispatch in-process:

- `job.facade.ts` mints after the external-kernel early return, so the
  external-kernel path (which returns `queued` and dispatches nothing) still
  mints nothing. A grant nobody redeems is a grant `device-relay` could still
  resolve, so not minting it is the point, not an oversight.
- `setup.ts` mints after the deviceless self-attest branch, which returns before
  ever reaching a device.
- A mint failure aborts the submission in both (facade: job marked `failed`, then
  a thrown `execution_scope_mint_failed:` error -> 500; test-job: an explicit 500
  `execution_scope_mint_failed`). Neither falls through to an unscoped dispatch,
  because that would surface as a misleading safety-gateway denial instead of the
  real cause.
- `scopeId`/`agentDid` are derived in the producer and **never read off the
  request body**, in either producer.

### Paid path — byte-for-byte proof

The extraction was taken. The removed literals *are* the helper's defaults:

```diff
   // ── 3. Create execution scope ──────────────────────────────────────
-  const scopeId = `scope_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
-  const allowedTools = getWriteToolsForDeviceType(session.capabilityType);
-  const expiry = new Date(Date.now() + 60 * 60_000).toISOString(); // 1 hour
-
-  db.insert(executionScopes).values({
-    id: scopeId,
+  const { scopeId } = mintExecutionScope({
     kernelId: session.kernelId,
     jobId,
     createdBy: session.userAgentId,
-    status: "active",
-    allowedTools,
-    maxCommands: 200,
-    commandCount: 0,
-    maxRetries: 5,
-    retryCount: 0,
+    capabilityType: session.capabilityType,
     createdAt: now,
-    expiresAt: expiry,
-  }).run();
+  });
```

Field by field: `id` — same expression; `kernelId`/`jobId`/`createdBy` — passed
through; `status: "active"` — helper literal; `allowedTools` — the same
`getWriteToolsForDeviceType(session.capabilityType)` call, now the helper's
default; `maxCommands: 200` = `DEFAULT_MAX_COMMANDS`; `commandCount: 0` and
`retryCount: 0` — helper literals; `maxRetries: 5` = `DEFAULT_MAX_RETRIES`;
`createdAt` — the caller's shared `now`, passed explicitly so it still matches
the job/session rows written alongside it; `expiresAt` — the same
`new Date(Date.now() + 60*60_000).toISOString()` (note: computed from
`Date.now()`, not from `now` — preserved exactly, including that asymmetry).
`allowedPipettes`/`allowedSlots` were unset before and are unset now.

Empirically, the existing `paid-job-flow.test.ts` reads the row back through
`GET /api/ot2/scope/:id` and asserts `status === "active"`, `jobId`, `kernelId`
and a non-empty `allowedTools` (test: *creates an active execution scope tied to
the job*), exercises tool calls under the scope, and checks scopes stay active
after completion. All 16 pass, plus the 3 in `paid-job-flow-dispatch.test.ts`.

### Test tails

**Baseline (before any change) — the 4 reds the lane exists to fix:**

```
 FAIL  src/__tests__/job-submit.test.ts > ... > accepts a valid job and returns immediately
 FAIL  src/__tests__/job-submit.test.ts > ... > uses provided jobId when given
 FAIL  src/__tests__/job-submit.test.ts > ... > accepts optional assuranceTier and gcodeHash
 FAIL  src/__tests__/job-submit.test.ts > ... > auto-select device: deviceId in response matches mock adapter
 Test Files  1 failed | 5 passed (6)
      Tests  4 failed | 80 passed (84)
```

**Targeted, after the change** (`pnpm --filter @pcc/gateway test -- job-submit
kernel-service setup paid-job-flow producer-execution-scope`):

```
 ✓ src/__tests__/setup.test.ts  (37 tests) 332ms
 ✓ src/__tests__/paid-job-flow-dispatch.test.ts  (3 tests) 155ms
 ✓ src/__tests__/job-submit.test.ts  (19 tests) 721ms
 ✓ src/__tests__/paid-job-flow.test.ts  (16 tests) 770ms
 ✓ src/__tests__/producer-execution-scope.test.ts  (8 tests) 10612ms
 Test Files  7 passed (7)
      Tests  92 passed (92)
   Duration  13.43s
```

**Full gateway suite:**

```
 Test Files  189 passed (189)
      Tests  2995 passed | 6 skipped (3001)
   Start at  17:49:11
   Duration  23.11s (transform 14.26s, setup 1.01s, collect 258.04s, tests 78.42s, ...)
```

The first full run had 2 failed *suites* — `capture.test.ts` and
`capture-3d.test.ts`, both `Failed to load url @pcc/verifier/dist/...`. That is
the known unbuilt-dependency issue in a fresh worktree: `@pcc/verifier` has no
exports map, so vitest cannot alias it to source. `pnpm --workspace-concurrency=4
--filter "@pcc/gateway^..." build` fixed both. Not related to this change —
neither file imports anything this lane touched.

**Typecheck:**

```
$ pnpm --filter @pcc/gateway exec tsc --noEmit -p .
tsc exit code: 0
```

(no output)

**The new tests are load-bearing.** Reverting only the three producer files to
`b6c9c771` and re-running the new file:

```
 Tests  7 failed | 1 passed (8)
     -> expected 500 to be 200                       (scope row / principal)
     -> expected undefined not to be undefined       (submitJob params.scopeId)
     -> waitFor: condition not met within timeout    (nothing actuated)
     -> expected 500 to be 200                       (unauthenticated principal)
     -> expected 500 to be 200                       (negative control)
     -> expected 500 to be 200                       (setup test-job completion)
     -> expected 500 to be 200                       (setup test-job negative control)
```

The one that passes both ways is *mints no scope on the external-kernel path* —
it asserts an *absence*, so it is a guard against a future over-eager mint rather
than a regression test for this change. Files were restored with
`git checkout HEAD -- <paths>`; tree verified clean afterwards.

### The negative control, quoted

`POST /api/jobs/submit` is given a `scopeId` naming a **real, active** scope owned
by another operator — the strongest form of the attack, since a naive "does this
id resolve?" check would wave it through:

```ts
const FOREIGN_SCOPE = "scope_foreign_victim_001";
db.insert(executionScopes).values({
  id: FOREIGN_SCOPE, kernelId: KERNEL_ID, jobId: "job-belonging-to-someone-else",
  createdBy: "victim-operator@example.com", status: "active",
  allowedTools: ["printer_start_job"], /* ...active, unexpired... */
}).run();

const res = await app.inject({ method: "POST", url: "/api/jobs/submit", payload: {
  jobId: "job-producer-scope-attack", stepId: "step-attack", kernelId: KERNEL_ID,
  // The route body schema is additionalProperties:true, so these DO
  // arrive at the handler. They must not be honoured.
  scopeId: FOREIGN_SCOPE,
  agentDid: "did:pcc:victim-operator@example.com",
}});

const minted = scopesForJob("job-producer-scope-attack");
expect(minted).toHaveLength(1);
expect(minted[0].id).not.toBe(FOREIGN_SCOPE);
expect(minted[0].createdBy).toBe(PRINCIPAL);

// THE NEGATIVE CONTROL: what the boundary was handed is the minted scope,
// and the victim's scope never reached it.
const params = submitSpy.mock.calls[0][0];
expect(params.scopeId).toBe(minted[0].id);
expect(params.scopeId).not.toBe(FOREIGN_SCOPE);
expect(params.agentDid).toBe(`did:pcc:${PRINCIPAL}`);

// ...and the same holds all the way down at the governor.
await waitFor(() => executed.length >= 2);
const relayed = relaySpy.mock.calls.map((c) => c[0]);
for (const cmd of relayed) {
  expect(cmd.scopeId).toBe(minted[0].id);
  expect(cmd.scopeId).not.toBe(FOREIGN_SCOPE);
  expect(cmd.agentDid).not.toBe("did:pcc:victim-operator@example.com");
}

// The victim's grant is untouched — not consumed, not rebound.
const victim = db.select().from(executionScopes).where(eq(executionScopes.id, FOREIGN_SCOPE)).get();
expect(victim?.jobId).toBe("job-belonging-to-someone-else");
expect(victim?.createdBy).toBe("victim-operator@example.com");
```

The same assertion in shorter form covers `POST /api/setup/test-job`.

### Honest gaps

1. **The external-kernel relay path is still a no-op, by design here.** The
   facade's external branch returns `queued` and dispatches nothing in-process,
   so it mints nothing — and I did not build a scope for a future relay. When
   external-kernel dispatch is actually implemented (see the RTP-absorption
   transport work), it will need its own grant, and the interesting question is
   *who* holds it: a scope minted in the gateway is meaningless to a remote
   operator daemon running its own SafetyGateway. That is a protocol decision,
   not a code change.
2. **Other `submitJob` callers are still unscoped.** Outside these two producers,
   `packages/agent-kernel` and `packages/onboard-kit` have their own submission
   paths that do not mint a scope. They are outside the file list for this lane
   and outside the gateway package. Any of them that reaches an in-process
   `KernelService` will fail closed at the pre-flight, exactly as the gateway
   producers did before this change. Each needs the same treatment, and each has
   a *different* principal — which is why this was left rather than guessed at.
3. **Scope expiry does not bind long jobs — and does not bind anything else
   either.** The governor's scoped-class rule is literally `return !!cmd.scopeId`;
   it never loads the row, so `expiresAt`, `status`, `maxCommands` and
   `allowedTools` are *not enforced on the in-process dispatch path at all*. They
   are enforced only by `routes/device-relay.ts` for relayed tool calls. So today
   a job outliving its 1 h scope keeps actuating, and a revoked scope keeps
   working. Making expiry real means the governor (or `KernelService`) resolving
   the scope row before admitting — a boundary change, deliberately not made here.
4. **Nothing marks a scope `completed` when its job ends.** The paid path already
   leaves scopes active on purpose (`paid-job-flow.ts` section *Execution scopes —
   left active*; revoked at expiry, not on complete), and these producers follow
   that precedent. Combined with gap 3, an active scope is effectively a standing
   relay grant for `(kernelId, createdBy)` until it expires. The tighter test-job
   budget is a mitigation for that, not a fix.
5. **The unauthenticated fallback is a real principal in the DB.** Anything that
   reaches these routes without auth (today: several test harnesses; in
   production the api-gate should prevent it) mints a scope with
   `created_by = "unauthenticated"`. Since `device-relay` matches on `createdBy`,
   two unauthenticated callers on the same kernel would share a bucket. Rejecting
   unauthenticated submissions outright is the right answer, but that is an
   auth-policy change and would have required editing the 4 red tests.
6. **`POST /api/setup/test-job` polls for its full 10 s on success.** Its loop
   breaks only on `completed`/`failed`, but the settlement pipeline advances the
   job row past `completed` to `evidence_stored`, so a *successful* self-test
   always runs to the deadline and returns `evidence_stored`. Pre-existing, not
   caused by this change; the new test asserts it as-is (evidence bundle present,
   row in a terminal success state) rather than papering over it. It is why that
   one test takes ~10 s.

### Commits

```
$ git log --oneline b6c9c771..HEAD
b2d23c56 jobrunner-safety-producer: tests for producer-side execution-scope minting
8df9699d jobrunner-safety-producer: mint an execution scope at the two in-process job producers
```

(this report section is committed on top)
