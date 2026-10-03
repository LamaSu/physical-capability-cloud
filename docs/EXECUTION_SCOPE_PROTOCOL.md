# Execution Scope Protocol

## Problem

When a user's agent talks to a machine's agent, we need to:
1. Lock down exactly what operations are approved
2. Allow troubleshooting when easy things fail
3. Not compromise the whole system if one thing goes wrong

## Design Principles

- **Proposal first, execution second** — nothing runs until both sides agree on scope
- **Fail-safe, not fail-open** — if scope check fails, reject the operation
- **Graduated recovery** — retries are cheap, escalation is available, arbitrary access is not
- **Audit everything** — every tool call, every retry, every escalation is logged

## Operation Classes

### Class 1: READ (always allowed)
No scope needed for the kernel's operator. Any other agent reads robot state
only while it holds an active scope on that kernel. A tool call must name that
scope (`scopeId`); camera and chat reads check only that the caller holds an
active scope on the kernel, without naming one (see "Who may call the relay"
below).

| Tool | What |
|------|------|
| ot2_health | Robot health, firmware, serial |
| ot2_pipettes | Attached pipettes |
| ot2_modules | Attached modules |
| ot2_deck_calibration | Calibration status |
| ot2_pipette_offset | Pipette offset data |
| ot2_tip_length | Tip length calibrations |
| ot2_protocols_list | Uploaded protocols |
| ot2_runs_list | Run history |
| ot2_run_status | Status of a specific run |
| ot2_camera_snapshot | Take a photo |

### Class 2: SAFE CONTROL (always allowed during active job)
Low-risk operations that help troubleshooting without changing state.

| Tool | What |
|------|------|
| ot2_home | Home axes (safe recovery) |
| ot2_lights | Deck lights (visual aid) |
| ot2_identify | Blink for identification |

### Class 3: SCOPED WRITE (requires active scope)
Operations that change robot state — only allowed within an approved execution scope.

| Tool | What | Scope Check |
|------|------|-------------|
| ot2_protocol_upload | Upload a protocol | Protocol content must match proposal |
| ot2_run_create | Create a run | Protocol ID must be in scope |
| ot2_run_action | Play/pause/stop | Run ID must be in scope |

### Class 4: PRIVILEGED (requires operator approval)
Never auto-approved. Always requires human-in-the-loop.

| Tool | What |
|------|------|
| ot2_shell | Arbitrary shell commands |
| Self-update | Replace agent code |

## Execution Scope Lifecycle

```
┌─────────────┐
│  PROPOSED    │ ← User agent proposes a job
└──────┬──────┘
       │ operator approves (or auto-approve policy)
┌──────▼──────┐
│   ACTIVE    │ ← Tool calls validated against scope
└──────┬──────┘
       │ all steps complete OR scope expires OR operator revokes
┌──────▼──────┐
│  COMPLETED  │ ← Audit trail preserved
│  EXPIRED    │
│  REVOKED    │
└─────────────┘
```

## Scope Definition

```json
{
  "id": "scope-abc123",
  "kernelId": "kernel-nanoclaw",
  "jobId": "job-xyz",
  "createdBy": "agent-user-1",
  "status": "active",

  "allowedTools": [
    "ot2_protocol_upload",
    "ot2_run_create",
    "ot2_run_action",
    "ot2_run_status"
  ],

  "allowedPipettes": ["left"],
  "allowedSlots": [1, 2, 3, 9],

  "maxCommands": 50,
  "commandCount": 0,

  "maxRetries": 3,
  "retryCount": 0,

  "protocolHash": "sha256:abc...",

  "createdAt": "2026-03-28T...",
  "expiresAt": "2026-03-28T...+30m"
}
```

## Troubleshooting Protocol

When a tool call fails within a scope:

### Level 1: Auto-Retry (no escalation)
- **Trigger**: Tool call returns error
- **Budget**: `maxRetries` (default 3)
- **Allowed**: Retry same tool call, or use Class 1/2 operations to diagnose.
  A retry is a new call with a new id, submitted by the brain: the relay never
  redelivers a call (see "Delivery is at-most-once")
- **Example**: Tip pickup fails → home → retry tip pickup

### Level 2: Brain Recovery (Claude decides)
- **Trigger**: Auto-retry exhausted, or Claude identifies the issue
- **Budget**: Still within scope's `maxCommands`
- **Allowed**: Any Class 1/2/3 operation within scope
- **Example**: Wrong labware position → check calibration → adjust → retry

### Level 3: Operator Escalation
- **Trigger**: Brain can't resolve, or scope limits exceeded
- **Action**: Pause job, notify operator via PCC dashboard
- **Operator can**: Extend scope, grant temporary shell access, manually fix, abort
- **Example**: Pipette collision → pause → operator inspects → resume or abort

### Level 4: Emergency Stop
- **Trigger**: Safety concern, or operator hits E-stop
- **Action**: The kernel's emergency stop is engaged (see Emergency Stop
  Integration). The relay queues no call and mints no scope, and the calls still
  queued are rejected. Scopes are not revoked, and a call the node already
  claimed is not recalled.
- **Recovery**: The operator resumes (`POST /api/operator/emergency-resume`).
  The calls the stop rejected are not replayed; submit them again. A scope still
  inside its expiry works again after the resume; revoke it to end it sooner.

## Who may call the relay

The relay is `/api/relay/:kernelId/...` (`packages/gateway/src/routes/device-relay.ts`).
It is default-deny and scoped to one kernel. Every route is listed in
`RELAY_ROUTE_ACCESS`, and a route missing from that table is refused (so is any
method the table does not list, such as HEAD). A caller with no API key or SIWE
session gets 401.

| Who | May |
|-----|-----|
| The kernel's operator (its recorded `operatorAddress`) | Everything on that kernel, including the device side: claim pending calls, report results, push camera frames, read and answer chat, mint scopes |
| An agent holding an active, unexpired scope on that kernel | Post tool calls under its own scope, view the camera and chat |
| The creator of a scope, active or not | Read the scope, its audit and its calls' results, and revoke it. None of these commands or observes the device |
| Anyone else | Nothing |

A scope holder commands. It never acts as the device: claiming calls,
reporting results and pushing frames are the operator's alone. A scope is used
only on its own kernel.

**Authority is checked again where it is used.** Admission is not the last check.

- **Dispatch.** `GET /tool-call/pending` re-checks every queued call, oldest
  first, before handing it to the device:
  - a named scope must exist and be on the call's own kernel, for any tool;
  - a call with no scope must be a safe tool (only the operator can queue one);
  - a SCOPED call — safe tool or not — must still hold an active, unexpired
    scope. A safe tool such as `home` still moves the robot, so a holder's
    scoped `home` does not dispatch after the scope expires; only the
    operator's scope-free safe call skips the scope;
  - a non-safe write must also be in the scope's allowed tools, be within the
    command budget re-derived from the rows (so a legacy row admission never
    counted cannot exceed `maxCommands`), and pass the funding parity check;
  - then, at the dispatch site, the **physical-safety governor and circuit
    breaker** are re-run (`validateOnly`). The governor is async, and everything
    above can change while it is awaited: a scope expires or is revoked, the
    operator hits the emergency stop, a reported failure opens the breaker, a
    concurrent poll takes the scope's last command. So once the governor has
    answered, the checks above are run **again**, together with the
    **emergency stop** and the breaker's state (a read that moves nothing), in
    one synchronous step with no `await` before the claim. The call is claimed
    only if every one still passes, and is otherwise rejected with the reason.
    A command admitted while the breaker was closed does not reach the device
    after failures open it, and an engaged emergency stop blocks every dispatch
    (see Emergency Stop Integration).

  A refused call is closed as `rejected` with its reason, so no later poll can
  claim it and it does not hold back the calls behind it. The reasons are
  `scope_kernel_mismatch`, `scope_not_found`, `scope_required`,
  `scope_not_active`, `scope_expired`, `tool_not_allowed`, `max_commands_reached`,
  `escrow_not_funded`, `emergency_stopped` and the governor/breaker's
  `safety_denied`/`circuit_open`. A call whose escrow lookup fails, or which
  cannot be cleared because the safety gateway is unavailable, stays queued, as
  does every call from the point where the kernel's emergency-stop policy cannot
  be read (see Emergency Stop Integration). So a call recorded on one kernel
  under another kernel's scope (rows the retired writer could leave) never
  reaches a device and grants that scope's holder nothing, and a revoke or
  audit of the scope never reaches it.
- **Camera stream.** Before every frame and every 15-second heartbeat the
  stream checks two things again:
  - its credential still stands: the API key is neither revoked nor expired,
    or the SIWE session is still live;
  - its caller is still the kernel's operator or holds an active, unexpired
    scope there.

  A stream that fails either check is ended and receives no further frame.
  Revoking a scope ends the streams it held open at once. The camera's
  `latest` and `snapshot` and all chat routes are single requests, checked each
  time against the table.

The legacy `/api/ot2/*` routes are retired: no handler for them remains. A request
that reaches the retirement plugin gets 410 Gone with the replacement path; the
auth gate's 401, CORS preflight handling or an unmatched path may answer first,
and none of them runs a legacy operation.

**Funding (parity, not a funding gate).** A scoped, non-safe tool call bound to a
job is refused while that job's escrow exists in a state other than `funded`,
`active` or `completed`. The check runs at admission, where a lookup error
refuses the call (503), and again at dispatch, where a lookup error leaves it
queued. A job with no session, CWM or escrow record, or a `completed` escrow,
does not stop the call.
Binding every actuation to an accepted, funded job and its committed protocol is
item 5 of board row N4b-gw (R30), not this table.

## Delivery is at-most-once

A queued call is handed to the executor once. `GET /tool-call/pending` claims a
row with a compare-and-set on `pending`, so two polls cannot both take it, and
nothing puts a claimed row back in the queue:

- **A claim that is never reported fails; it is not redelivered.** A claim the
  executor has not reported within 120 seconds is closed by the next poll as
  `failed` with the error `claim_timeout` (and `completedAt` set; `claimedAt` is
  kept for the audit). The executor may still be running the command, and a
  physical command handed out twice is worse than one that failed. The call
  keeps counting against its scope's `maxCommands`, like any other non-safe
  call that was dispatched. `GET /tool-result/:id` shows `failed` with
  `claim_timeout`, and the caller resubmits if it still wants the work: a retry
  is a new call with a new id.
- **A late report is still recorded, once.** If the executor reports a call the
  poll has already timed out, its outcome replaces `claim_timeout` (`completed`,
  or `failed` with the executor's error): the breaker hears it, a failure
  charges the scope's `retryCount`, and the call is never queued again. A replay
  of that report, or a report that only echoes `claim_timeout`, changes nothing.
- **A rejected call is never delivered either.** Whatever closed a call as
  `rejected` (a refusal at dispatch, a revoke, an emergency stop), no later poll
  claims it.

While a kernel is under an emergency stop, or its stop policy cannot be read,
the poll does not run this timeout step: the first poll after the resume does,
and the timed-out claim is closed then, not delivered.

## The execution lease: claim, then start

A claimed call is not yet a command the device may run. The executor first takes
the call's **lease**, at the moment it would actuate, and runs the call only if
the gateway grants it. This is the same wire shape as the job claim of #471:
claim, then start with the token, and the token is opaque to the node.

1. **Poll with `X-PCC-Lease: 1`.** Each call the poll claims for such an
   executor carries a fresh `claimToken` (32 random bytes, hex). The row stores
   only the token's SHA-256, so the database alone can't start a call.
2. **`POST /api/relay/:kernelId/tool-call/:callId/start`**, body
   `{"claimToken": "<token>"}`, operator only. In ONE synchronous step with no
   `await` before the compare-and-set, it re-checks everything that can move
   between the claim and the run:
   - the emergency stop (`unavailable` answers 503 `policy_unavailable` and the
     call stays claimed, for the claim timeout);
   - the claim's age: a claim older than 60 s is `stale_claim`;
   - the dispatch checks: the scope's status and expiry, its tools, its budget
     (an `executing` call counts against `maxCommands`), and escrow funding;
   - the circuit breaker (`circuit_open`).
   It then moves the row `claimed` → `executing` exactly once.
   | Answer | Meaning for the executor |
   |--------|--------------------------|
   | 200 `{"started": true, "callId", "startedAt", "leaseMs": 5000}` | Run it, beginning within `leaseMs` (below). Nothing else may run. |
   | 409 `{"error": "lease_refused", "reason"}` | Don't run it, and don't report it. A stop, scope, budget, breaker or stale-claim refusal has already closed the call as `rejected` with that reason. `token_mismatch` and `not_claimed` leave the row as it is: the call isn't this executor's to start. |
   | 404 | Don't run it, and don't report it (no such call on this kernel). |
   | 400 `claim_token_required`, 503, any other answer, a transport error or a timeout | Don't run it. Report it as `not_executed:lease_unavailable`, so the gateway closes it. |
3. **Report** with `POST /tool-result`:
   - A call claimed with a token can report a success only after it started.
     A success for one that never started is refused with 409
     `{"error": "not_started"}`, and the row stays claimed.
   - An error closes the call as `failed`, started or not.
   - Only a report on a call that may have run is a device outcome, so only such
     a report feeds the circuit breaker: a call that started (`executing`), or a
     call claimed without a token (a lease-less executor, below) that may have
     run straight from the claim. A `not_executed:<reason>` report, or any report
     on a token-claimed call that never started, ran nothing: it is never counted
     as a device failure.

**`RELAY_LEASE_ENFORCE`** (gateway environment). On by default: any value but
exactly `off`. While it is on, a poller that doesn't send `X-PCC-Lease: 1` is
handed no calls and nothing is claimed for it: 200
`{"calls": [], "count": 0, "leaseRequired": true}`. That leaves an executor
which predates the lease idle, not unsafe. `off` is a transition window for
installed nodes, and turning it on is the operator's decision. With it off, such
a poller is served as before, with no token, and its reports count as device
outcomes.

**pcc-node's guard** (`packages/pcc-node/pcc_node/executor.py`,
`acquire_execution_lease`) runs before any adapter is touched, in this order,
and fails closed at every step:

1. The call must carry a non-empty `claimToken`. Without one (a gateway without
   leases) it reports `not_executed:no_lease`.
2. **Freshness.** The poll stamps each call with the local monotonic time its
   answer arrived. That stamp never leaves the node, and the poll overwrites any
   value the gateway sent. A call older than 30 s, or with no stamp, reports
   `not_executed:stale`. The bound is set with `PCC_NODE_LEASE_FRESHNESS_S`; a
   value that isn't a positive, finite number refuses every call.
3. **Fence.** A marker named by the SHA-256 of the call id is created with
   `O_CREAT|O_EXCL` (0600) in `PCC_NODE_FENCE_DIR` (default
   `~/.pcc-node/relay-fence`, 0700) BEFORE the lease is requested. A crash after a
   granted lease therefore never re-runs the call on this node. A marker that
   already exists means this node has attempted the call: it is refused and not
   reported. A fence that can't be created reports `not_executed:fence_unavailable`.
4. **The lease**, as above, with a 10 s timeout. The call runs only on 200 with
   `"started": true` exactly.
5. **At adapter entry, and at the device boundary** (r8, r9). The grant is an
   expiring authority. The node may send a device command for the call only
   within the lease window, counted from just before it sent the start request,
   so a slow answer can only shorten it. The window is the gateway's `leaseMs`,
   capped at the node's own 5 s.
   - Right before each adapter is entered, the node re-checks the window and the
     poll's freshness.
   - The window is also checked where each command leaves the node. Inside the
     call's `actuation_deadline` block, `http_util.http()` and the shell path call
     `may_emit_device_command()` immediately before they send. A command whose
     deadline has passed never leaves.
   - If no device command left, the node reports `not_executed:lease_expired`
     (or `not_executed:stale`), and nothing ran.
   - If one did, and a later one was held back, the device may have moved. The
     node reports `lease_lapsed_mid_command`, a device outcome.

**What the lease guarantees.** No device command for a relayed call leaves the
node after the call's lease deadline. The gateway's last check of the stop, the
scope, the budget and the breaker is at the grant: a stop that lands after a
call's grant can't reach that call, but nothing of a granted call is sent more
than 5 s after its start request. So no relayed device command is sent more than
5 s after a stop, and stopping a command already sent is the operator node's
job. The one interval left is inside `may_emit_device_command()` and the send
that follows it, with no other I/O between them.

**`RELAY_LEASE_ENFORCE=off` must never be used on an armed (physically
actuating) deployment:** it serves executors that take no lease at all.

## Validation Flow

```
Brain posts tool call
    │
    ▼
PCC receives POST /api/relay/:kernelId/tool-call
    │
    ├── not the operator or an active scope holder → 401/403; no toolName → 400
    ├── emergency stop engaged → 409 (policy unreadable → 503); nothing is queued
    │
    ├── Is tool Class 1 (READ)? → ALLOW (no scope needed)
    ├── Is tool Class 2 (SAFE)? → ALLOW (no scope needed)
    ├── Is tool Class 4 (PRIVILEGED)? → REJECT (requires operator)
    │
    ├── No scopeId provided? → REJECT ("scope required for write operations")
    │
    ▼ (Class 3, has scopeId)
Check scope:
    ├── scope.status != "active"? → REJECT ("scope not active")
    ├── scope expired? → REJECT ("scope expired")
    ├── tool not in allowedTools? → REJECT ("tool not in scope")
    ├── commandCount >= maxCommands? → REJECT ("command limit reached")
    │
    ▼
ALLOW → safety governor admission check
    → emergency stop read once more, right before the insert (engaged → 409,
      unreadable → 503; the read and the insert share one synchronous step)
    → queue for the executor; a scoped non-safe call's commandCount is charged
      here, in ONE transaction with the insert (an insert that fails rolls the
      charge back), and only if the scope, read again, is still active, unexpired,
      allows the tool and has a command left (else REJECTED, 403, no charge);
      a refusal anywhere above spends no budget either

Executor polls GET /api/relay/:kernelId/tool-call/pending (operator only)
    │
    ├── emergency stop engaged → every queued call REJECTED (emergency_stopped);
    │      200 with calls [] and emergencyStop true
    ├── emergency-stop policy unreadable → 503; nothing claimed, nothing changed
    │
    ├── a claim unreported for 120 s → closed FAILED (claim_timeout), not requeued
    │
    │  each queued call, oldest first, until 5 are handed out:
    ├── names a scope that is missing or on another kernel? → REJECTED
    ├── no scope, and not a safe tool? → REJECTED
    ├── a SCOPED call (safe or not) whose scope is not active/has expired? → REJECTED
    ├── a write not in allowed tools, over the row-derived budget, or unfunded? → REJECTED
    ├── the safety governor/breaker denies? → REJECTED
    │      (the safety gateway being unavailable → stays queued)
    │
    │  then, in ONE synchronous step with the claim (no await between), what can
    │  have changed during the governor's await is checked again:
    ├── emergency stop engaged now? → this call and every one behind it REJECTED
    │      (policy unreadable now → this call and the rest stay queued)
    ├── scope no longer active or expired, tool or budget no longer allowed,
    │      escrow no longer funded? → REJECTED
    ├── circuit breaker open now (a read that moves nothing)? → REJECTED
    │
    ▼
CLAIMED → handed to the executor, once (with a claim token if it takes leases)
    │
    ├── POST /tool-call/:callId/start with the token, in one synchronous step:
    │      emergency stop, claim older than 60 s, scope/tool/budget/escrow,
    │      breaker? → REJECTED (409 lease_refused; the executor runs nothing)
    │      stop policy unreadable or a check unavailable → 503; stays CLAIMED
    │      otherwise → EXECUTING (200 started: true), once
    │
    ├── EXECUTING: the executor reports → COMPLETED, or FAILED with its error
    ├── a token-claimed call that never started: an error (such as
    │      not_executed:<reason>) → FAILED; a success → 409 not_started
    ├── a claim unreported (and unstarted) for 120 s → the next poll closes it
    │      FAILED (claim_timeout); it is never handed out again, and the caller
    │      resubmits (a late report is still recorded, once)
```

## Protocol Hash Enforcement (planned — not yet enforced)

> **Status:** this is the DESIGN for protocol-hash binding; it is board row
> N4b-gw item 5 / R30, not yet implemented. The execution-scope table and the
> scope-creation request carry no `protocolHash` field today, and dispatch does
> not compare an upload's content hash. Treat this section as the target
> behavior, not current enforcement.

For protocol upload, the scope includes a `protocolHash` — the SHA-256 of the approved protocol content. The gateway validates:

```
1. User agent proposes: "Run this protocol: [content]"
2. Operator reviews protocol content
3. Scope created with protocolHash = sha256(content)
4. Brain tells executor to upload protocol
5. Gateway hashes the upload content, compares to scope.protocolHash
6. Match → allow. Mismatch → reject.
```

This prevents the brain from uploading a different protocol than what was approved.

## Rate Limiting (per-scope)

> **Status:** only the defaults are applied today. The scope mint
> (`POST /scope`) takes `maxCommands`, `maxRetries` and `expiresInMinutes` as
> given, uses the defaults below when they are omitted, and enforces no ceiling.
> The Max column and the concurrent-scopes limit are the intended ceilings, not
> current enforcement.

| Resource | Default | Max |
|----------|---------|-----|
| Commands per scope | 100 | 500 |
| Retries per scope | 3 | 10 |
| Scope duration | 30 min | 120 min |
| Concurrent scopes per kernel | 1 | 3 |

## Audit Trail

Every tool call under a scope is recorded in `tool_call_relay` with:
- Scope ID
- Tool name and args, stored and returned as submitted (they are not hashed)
- Status and reason: `pending`, `claimed`, `executing`, `completed`, `failed`, or
  `rejected` with the reason (`scope_expired`, `emergency_stopped`,
  `circuit_open`, `stale_claim`, ...), and `failed` with `claim_timeout` for a
  claim that was never reported
- The executor's result or error (`not_executed:<reason>` when it refused to run)
- When it was created, claimed, started and completed

The requesting principal is not recorded per call; the scope's `createdBy` is
the holder it was minted for.

Query via: `GET /api/relay/:kernelId/scope/:scopeId/audit`

## Emergency Stop Integration

What `POST /api/operator/emergency-stop` does (`routes/operator.ts`):
1. Sets `operatorPolicies.policy.emergencyStop = true` for the kernel.
2. Rejects that kernel's pending job **approvals**.
3. Rejects that kernel's queued relay calls: every `tool_call_relay` row still
   `pending` becomes `rejected` with the error `emergency_stopped`. A reset must
   not restart motion (ISO 13850), so a call still queued at the stop never runs
   after the resume, even if the node did not poll during the stop.

What the relay then enforces (`routes/device-relay.ts`). Each request reads the
kernel's stop as one of three states, and fails closed:

| State | When |
|-------|------|
| `clear` | The kernel has no `operator_policies` row, or the policy's `emergencyStop` is falsy (`false`, `0`, `null`, `""` or absent) |
| `stopped` | The policy's `emergencyStop` is truthy. Not only `true`: `1`, a non-empty string such as `"false"`, `{}` and `[]` all engage the stop, as in the kernel's policy engine |
| `unavailable` | The stop cannot be told: the read throws, the stored JSON does not parse, or the policy is not a JSON object (`null`, an array, a string, a number or a boolean). The relay refuses rather than guess |

- **Submit (`POST /tool-call`).** `stopped` answers 409
  `{"error": "kernel_emergency_stopped"}`; `unavailable` answers 503
  `{"error": "policy_unavailable"}`. Nothing is queued and no scope budget is
  spent. Authentication, authorization and body validation (401, 403, 400)
  answer first. The stop is read again immediately before the row is inserted,
  in the same synchronous step (no `await` between the read and the insert), so
  a stop that lands while the safety governor is consulted still refuses the
  call, and no stop request can fall between the check and the insert.
- **Pending (`GET /tool-call/pending`).** `stopped` withholds the poll: 200
  `{"calls": [], "count": 0, "emergencyStop": true}`, and every call still
  `pending` for the kernel is rejected (`emergency_stopped`). A poller that
  predates the flag reads this as "nothing to do". `unavailable` answers 503
  `{"error": "policy_unavailable"}` and nothing is claimed, closed or changed
  (the claim-timeout step of "Delivery is at-most-once" does not run either).
  Within a poll the stop is read again for each queued call, after the call's
  safety check and in the same synchronous step as its claim (see Dispatch): a
  stop that lands during the poll rejects the call being checked and every call
  behind it, and a policy that turns unreadable mid-poll claims no further call
  (the rest stay queued). Calls claimed earlier in the same poll are returned.
- **Scope mint (`POST /scope`).** `stopped` answers 409
  `kernel_emergency_stopped`, `unavailable` answers 503 `policy_unavailable`,
  and no scope is written. A scope minted before the stop cannot queue a call
  while the stop is engaged (submit answers 409), so it does not keep working
  through a stop for the rest of its lifetime.
- **Not blocked:** scope revoke (a safety action), scope reads and the audit,
  tool results (the device reports what an in-flight call did), the camera and
  chat.

- **Start (`POST /tool-call/:callId/start`).** `stopped` refuses the lease (409
  `lease_refused`, `emergency_stopped`) and closes the call as `rejected`;
  `unavailable` answers 503 and starts nothing. So a call that was claimed but
  not yet started never runs while the stop is engaged, and never after it
  either.

Not done by the stop (planned; do not rely on it): it does not revoke active
execution scopes, does not send a "stop" to an in-flight run, and does not
change the kernel's status. Resume is by clearing the flag
(`POST /api/operator/emergency-resume`); a scope that was active stays active
and works again once the stop clears, until it expires or is revoked. A call the
node has already STARTED (`executing`) is not recalled by the stop: stopping it
is the operator node's job (below). A claimed call is not redelivered after a
resume either: one the node never started is refused at its start and closed,
and a claim the node never reports is closed as `failed` (`claim_timeout`) by
the first poll after the resume, never handed out again (see "Delivery is
at-most-once"). Stopping an in-flight run and revoking scopes on e-stop is
tracked follow-up.

### The authoritative physical-safety boundary is the operator node

The gateway relay is an **admission** gate: it re-checks the safety governor,
the circuit breaker and the emergency stop at dispatch, and claims a row
atomically so a revoked/expired/duplicate call is not handed out. The execution
lease moves the last of those checks to the moment of actuation: pcc-node runs a
relayed call only after the gateway grants its start, and the start re-checks
the stop, the scope, the budget, the breaker and the claim's age in one
synchronous step. Until the gateway says `started`, nothing runs; on any doubt
(no token, a stale poll, a fence it can't write, no clear answer) the node
refuses. The node also fences locally, so it never runs one call twice.

What the lease does not change: the breaker and governor state are **per
gateway instance and in-memory** (`packages/kernel/src/safety/gateway.ts`). A
horizontally scaled second instance would have independent safety truth, and a
deploy resets it. The deployment is single-replica (one gateway process on one
SQLite store), so the start's re-check is the one gateway's truth. A call the
node has already started can't be recalled by the gateway. Stopping a run in
progress is the operator node's job: the OT-2 start guard (N4a) and pcc-node's
per-command checks (N4b-robot) sit in front of the actuator. Shared
cross-instance safety state (a common breaker and e-stop store) is a separate
gateway-scaling concern, tracked apart from this relay.
