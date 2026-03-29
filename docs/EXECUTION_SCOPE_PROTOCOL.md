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
No scope needed. Any authenticated agent can read robot state.

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
- **Action**: Immediate halt, scope revoked, all pending calls rejected
- **Recovery**: Operator must create a new scope to resume

## Validation Flow

```
Brain posts tool call
    │
    ▼
PCC receives POST /api/ot2/tool-call
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
ALLOW → increment commandCount → relay to executor
```

## Protocol Hash Enforcement

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

Query via: `GET /api/ot2/scope/:id/audit`

## Emergency Stop Integration

The operator dashboard's Emergency Stop button:
1. Revokes ALL active scopes for the kernel
2. Sends "stop" action to all active runs
3. Rejects all pending tool calls
4. Sets kernel status to "emergency_stopped"
5. Requires manual resume + new scope creation
