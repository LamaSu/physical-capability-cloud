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
- **Allowed**: Retry same tool call, or use Class 1/2 operations to diagnose
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
    breaker** are re-run (`validateOnly`) and the **emergency stop** is checked.
    A command admitted while the breaker was closed does not reach the device
    after failures open it, and an engaged emergency stop blocks every dispatch:
    the poll is withheld outright, and the stop is read again for each call
    just before it is claimed (see Emergency Stop Integration).

  A refused call is closed as `rejected` with its reason, so no later poll can
  claim it and it does not hold back the calls behind it. The reasons are
  `scope_kernel_mismatch`, `scope_not_found`, `scope_required`,
  `scope_not_active`, `scope_expired`, `tool_not_allowed`, `max_commands_reached`,
  `escrow_not_funded`, `emergency_stopped` and the governor/breaker's
  `safety_denied`/`circuit_open`. A call whose escrow lookup fails, or which
  cannot be cleared because the safety gateway is unavailable, stays queued, as
  does every call from the point where the kernel's emergency-stop policy cannot
  be read (see Emergency Stop Integration); a claim that times out is
  re-checked the same way. So a
  call recorded on one kernel under another kernel's scope (rows the retired
  writer could leave) never reaches a device and grants that scope's holder
  nothing, and a revoke or audit of the scope never reaches it.
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
ALLOW → increment commandCount → safety governor admission check
    → emergency stop read once more, right before the insert (engaged → 409,
      unreadable → 503; the read and the insert share one synchronous step)
    → queue for the executor

Executor polls GET /api/relay/:kernelId/tool-call/pending (operator only)
    │
    ├── emergency stop engaged → every queued call REJECTED (emergency_stopped);
    │      200 with calls [] and emergencyStop true
    ├── emergency-stop policy unreadable → 503; nothing claimed, nothing changed
    │
    │  each queued call, oldest first, until 5 are handed out:
    ├── names a scope that is missing or on another kernel? → REJECTED
    ├── no scope, and not a safe tool? → REJECTED
    ├── a SCOPED call (safe or not) whose scope is not active/has expired? → REJECTED
    ├── a write not in allowed tools, over the row-derived budget, or unfunded? → REJECTED
    ├── the safety governor/breaker denies? → REJECTED
    │      (the safety gateway being unavailable → stays queued)
    ├── emergency stop engaged since the poll began (read after the safety check,
    │      right before the claim)? → this call and every one behind it REJECTED
    │      (policy turned unreadable → this call and the rest stay queued)
    │
    ▼
CLAIMED → handed to the executor
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

| Resource | Default | Max |
|----------|---------|-----|
| Commands per scope | 100 | 500 |
| Retries per scope | 3 | 10 |
| Scope duration | 30 min | 120 min |
| Concurrent scopes per kernel | 1 | 3 |

## Audit Trail

Every tool call is logged with:
- Scope ID
- Tool name + args (hashed for sensitive data)
- Validation result (allowed/rejected + reason)
- Execution result
- Timestamp
- Who requested it (brain agent ID)

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
  `{"error": "policy_unavailable"}` and nothing is claimed, reclaimed or
  changed. Within a poll the stop is read again for each queued call, after the
  call's safety check and immediately before its claim: a stop that lands during
  the poll rejects the call being checked and every call behind it, and a policy
  that turns unreadable mid-poll claims no further call (the rest stay queued).
  Calls claimed earlier in the same poll are returned.
- **Scope mint (`POST /scope`).** `stopped` answers 409
  `kernel_emergency_stopped`, `unavailable` answers 503 `policy_unavailable`,
  and no scope is written. A scope minted before the stop cannot queue a call
  while the stop is engaged (submit answers 409), so it does not keep working
  through a stop for the rest of its lifetime.
- **Not blocked:** scope revoke (a safety action), scope reads and the audit,
  tool results (the device reports what an in-flight call did), the camera and
  chat.

Not done by the stop (planned; do not rely on it): it does not revoke active
execution scopes, does not send a "stop" to an in-flight run, and does not
change the kernel's status. Resume is by clearing the flag
(`POST /api/operator/emergency-resume`); a scope that was active stays active
and works again once the stop clears, until it expires or is revoked. A call the
node had already claimed is not recalled by the stop, and a claim the node never
reports is requeued by the 120-second claim timeout, which can fall after a
resume; the operator node is the authority there (below). Stopping an in-flight
run and revoking scopes on e-stop is tracked follow-up.

### The authoritative physical-safety boundary is the operator node

The gateway relay is a best-effort **admission** gate: it re-checks the safety
governor, the circuit breaker and the emergency stop at dispatch, and claims a
row atomically so a revoked/expired/duplicate call is not handed out. But the
breaker and governor state are **per gateway instance and in-memory**
(`packages/kernel/src/safety/gateway.ts`): a horizontally-scaled second instance
has independent safety truth, and a deploy resets it. And once a call is handed
to the executor, the gateway cannot recall it. Therefore the authoritative,
single-instance, per-device safety boundary is the **operator node**: the OT-2
start guard (N4a) and pcc-node's per-command checks (N4b-robot), which sit in
front of the actual actuator. Shared cross-instance safety state (a common
breaker/e-stop store) is a separate gateway-scaling concern, tracked apart from
this relay.
