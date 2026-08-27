---
title: "PCC Async Job Pattern"
description: "How agents submit long-running physical jobs to PCC and track them to a verified outcome: submit, poll status, then fetch evidence."
canonical: "https://capability.network/async-jobs.md"
last-updated: "2026-08-27"
---

# PCC Async Job Pattern

Physical work is not instantaneous — a print runs, a courier drives, an assay
incubates. PCC models every job as an **asynchronous, long-running operation**:
you submit the work, receive a job identifier immediately, then poll the job's
status until it reaches a terminal state and fetch its evidence. An agent never
blocks a request waiting for a physical outcome.

## 1. Submit

```http
POST /api/jobs/submit HTTP/1.1
Host: capability.network
Authorization: Bearer pcc_live_REDACTED
Content-Type: application/json

{ "contractId": "cap_...", "params": { ... } }
```

The response returns a `jobId`. Submission acknowledges that the job was
accepted for execution; it does not mean the physical work is finished. Treat
submission as idempotent from your side by not re-submitting the same contract
on a timeout — poll instead (see below).

## 2. Poll status

Poll the job until it reaches a terminal state. Use bounded exponential backoff;
do not tight-loop.

```http
GET /api/jobs/{jobId}/status HTTP/1.1
Host: capability.network
Authorization: Bearer pcc_live_REDACTED
```

- `GET /api/jobs/{jobId}` — full job detail (scope, operator, milestones).
- `GET /api/jobs/{jobId}/status` — lightweight status for polling loops.
- `GET /api/jobs` — list your jobs.

A job moves through non-terminal states (accepted → running) to a **terminal**
state (completed / attested / settled, or failed / rejected). Stop polling once
a terminal state is observed. Respect `Retry-After` on `429` and back off on
`5xx` rather than rotating identities.

## 3. Fetch evidence

Once a job is complete, retrieve its content-addressed evidence and check it
against the assurance tier the contract required before accepting the outcome.

```http
GET /api/evidence/{jobId} HTTP/1.1
Host: capability.network
Authorization: Bearer pcc_live_REDACTED
```

Evidence bundles are hashed; on-chain records store commitments, not raw
evidence. Assurance tiers 0–3 range from basic operator health through signed
events, sensor records, and independent verification.

## Guidance for agents

- **Do not block.** Submit, store the `jobId`, and poll on your own schedule.
- **Poll, don't re-submit.** A network timeout on submit does not mean the job
  failed; fetch `GET /api/jobs/{jobId}/status` before considering a re-submit.
- **Terminal states are final.** Settlement and evidence are only meaningful
  once the job reaches a terminal state.
- **Verify before accepting.** Read the evidence and confirm it satisfies the
  contract's assurance tier before releasing milestone escrow.

See [auth.md](https://capability.network/auth.md) for credentials and
[pricing.md](https://capability.network/pricing.md) for per-outcome settlement.
