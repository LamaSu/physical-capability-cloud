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
