# Phase 7: operate

**Goal:** the device takes jobs unattended, within its envelope, and says honestly what happened.

## The operating loop
This is phase 6's by-hand run, repeated every few seconds. Its rules are not optional:
1. **Take a job only while the emergency stop reads clear.** Read `GET $BASE/api/operator/policy/<kernelId>` before each job. `emergencyStop: true`, or a policy you cannot read, means: take nothing this round. On entering the stopped state, send the device its stop once (for this device, `POST $DEV/estop`).
2. **Resolve the job's parameters.** Never invent them, and never default one.
3. **Type-check and envelope-check them** against `.pcc/operations.json` and `.pcc/envelope.json`. Anything outside them is refused with a reason, and the device is untouched.
4. **Check the device is idle.**
5. **Run exactly one typed operation.** Nothing from the job reaches the device except the checked parameters of an operation you listed. Never forward a job's raw request, path or method.
6. **Finish the node's way:** evidence, then status `completed`, or `failed` with the reason.
7. **Heartbeat about once a minute:** `POST $BASE/api/operator/heartbeat` with `{"kernelId": "<kernelId>", "status": "online"}`.

Honour the human's intake answers too: take no jobs outside the stated availability, and none that need consumables they don't have.

## What runs the loop
- **Coming (ADK item 12, first cut 10-10):** the operating agent. It is refvertical's loop on top of pcc-node's typed `DeviceRuntime`, and it does all seven steps, signs its evidence with the kernel's key, and runs as a service.
- **Until then:** run the loop yourself, or as a small script you write in this folder, following the seven rules exactly.

Do **not** use `pcc-node start` for a generic-HTTP device on the current code:
- it drops configured devices (#390);
- its generic adapter lets a job's raw parameters choose the device request.

## Keep the listing honest
- `GET $BASE/api/operators/<slug>/status` lists what is still missing. Fill what you can.
- On the current gateway, availability can't be set; that is not your error.
- If the device goes down, or its consumables run out, stop taking jobs. Say so in the capability description, or through the emergency stop, and report it.

**Done when:** the loop has run at least one job unattended, and the status shows nothing you can still fill.
```bash
bin/pcc-report operate ok "loop running: 1 job unattended, 0 refused; heartbeat every 60 s" --kernel-id "$(cat .pcc/kernel-id)"
```
**Next:** [publish](08-publish.md).
