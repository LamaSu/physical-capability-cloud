# Phase 7: operate

**Goal:** the device takes jobs unattended, within its envelope, and says honestly what happened.

## The operating loop
This is phase 6's by-hand run, repeated every few seconds. Before the loop starts, and after any envelope edit, recompute the envelope's digest and compare it with `.pcc/envelope.confirmed.json` (phase 6 step 2.3). If they differ, stop until the human confirms again. Its rules are not optional:
0. **Take no job that carries money yet.** PCC cannot yet pay a wallet the human confirmed (phase 0), so paid operation stays off. Before each job, read `GET $BASE/api/jobs/<jobId>/settlement`: run it only if that answers 200 with `"session": null` and `"escrow": null`. Otherwise don't run it: send `failed` with the reason `payout_destination_unbound`, and report it. On the current gateway that leaves only the test jobs you submit yourself (phase 6 step 1).
1. **Take a job only while the emergency stop reads clear**, read with phase 6 step 3's check before each job. It is clear only for a stored policy (`updatedAt` present, no `"source": "default"`) whose `emergencyStop` is `false`. `emergencyStop: true`, the gateway's default policy (it answers 200 with `"source": "default"` and `emergencyStop: false` when it has no stored policy or cannot read its store), or a policy you cannot read means: take nothing this round. On entering the stopped state, send the device its stop once (for this device, `POST $DEV/estop`).
2. **Resolve the job's parameters.** Never invent them, and never default one. A test job's are the ones in your own request.
3. **Type-check and envelope-check them** against `.pcc/operations.json` and `.pcc/envelope.json`. Anything outside them is refused with a reason, and the device is untouched.
4. **Check the device is idle.**
5. **Run exactly one typed operation.** Nothing from the job reaches the device except the checked parameters of an operation you listed. Never forward a job's raw request, path or method.
6. **Finish the node's way:** evidence, then the final status computed as in phase 6 step 2.6, never typed: `completed` only for a run that `succeeded` whose receipt says `"stored": true` for this job with a `bundleId`; otherwise `failed` with the reasons.
7. **Heartbeat about once a minute:** `POST $BASE/api/operator/heartbeat` with `{"kernelId": "<kernelId>", "status": "online"}`.

Honour the human's intake answers too: take no jobs outside the stated availability, and none that need consumables they don't have.

Paid operation turns on only when the gateway can pay a wallet the human confirms, and you have checked that wallet as the actual payout recipient of a job (a gateway row). Until then, rule 0 refuses every job with a negotiation session or an escrow.

## What runs the loop
- **Coming (ADK item 12, #471):** the operating agent. It is refvertical's loop on top of pcc-node's typed `DeviceRuntime`, and it does all eight:
  - it claims each job atomically, once the gateway serves its claim route;
  - it signs its evidence with the kernel's key;
  - it runs as a service.
- **Until then:** run the loop yourself, or as a small script you write in this folder, following the eight rules exactly.

Do **not** run `pcc-node start` beside the loop. From 0.1.1 its daemon takes no jobs, and its heartbeat says so (`acceptingJobs: false`), so the gateway stops refreshing your listing and it ages out. The loop's own heartbeat (rule 7) keeps the kernel online and listed.

## Keep the listing honest
- `GET $BASE/api/operators/<slug>/status` lists what is still missing. Fill what you can.
- On the current gateway, availability can't be set; that is not your error.
- If the device goes down, or its consumables run out, stop taking jobs. Say so in the capability description, or through the emergency stop, and report it.

**Done when:** the loop has run at least one test job unattended, refuses any job that carries money, and the status shows nothing you can still fill.
```bash
bin/pcc-report operate ok "loop running: 1 test job unattended; paid jobs refused until payouts can be bound; heartbeat every 60 s" --kernel-id "$(cat .pcc/kernel-id)"
```
**Next:** [publish](08-publish.md).
