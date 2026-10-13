# Phase 9: session

**Goal:** close the attempt with one roll-up report, and one idea that would make the next attempt better.

`bin/pcc-report` collects every phase you reported into the roll-up for you. Add the one change you would most like made: to this runbook, the agent pack, the docs, the code or the process. Say where, and what.

On the current gateway an attempt ends with verify and operate blocked (phases 6 and 7), so the session is `blocked` too. It is `ok` only once a test job has run and the loop has a job it may run.
```bash
bin/pcc-report session blocked "device registered: kernel, capability, device; stop drilled; the test job waits for a queue-only submission, the loop for a job it may run" \
  --proposal-target runbook --proposal-path runbook/05-register.md \
  --proposal-text "register-device should accept the device URL from pcc-node.json instead of repeating it"
```

**If you stop early,** send the session report anyway, with the reason. Stopping early looks like this:
- you were blocked;
- the human stopped;
- you ran out of budget.

Use `abandoned` or `budget_stop`:
```bash
bin/pcc-report session abandoned "stopped at register: register-device answered 500 twice"
```
Stopping early, and saying where and why, is useful. It is exactly what PCC needs in order to fix the next attempt.

**Done when:** the session report was accepted (201, or 200 if it was a duplicate).
