# Phase 6: verify

**Goal:** the emergency stop reads correctly, and the device stops on its own command. The test job waits: no current gateway can queue one without possibly starting it first (section 2). **Ask the human** (class C) once: "May I run one emergency-stop drill on the device?"

Don't use `POST /api/setup/test-job` as proof. On the current gateway it runs on a built-in mock device, not yours (board N59; the fix is #450).

```bash
BASE=$(cat .pcc/base); KID=$(cat .pcc/kernel-id); DEV=http://127.0.0.1:8765
```

## 1. Read the stop, and drill it, before anything runs
**How to read the stop.** The gateway answers HTTP 200 with its built-in default policy (`"source": "default"`, `emergencyStop: false`) both when it has no stored policy for your kernel and when it cannot read its store. So the stop reads **clear only for a stored policy** (it has `updatedAt` and no `"source": "default"`) whose `emergencyStop` is `false`. Anything else counts as stopped: a default policy, any answer but 200, an unreadable body. This is the check every later step means by "read the stop":
```bash
curl -s -o .pcc/policy.json -w '%{http_code}' "$BASE/api/operator/policy/$KID" -H @.pcc/auth.header > .pcc/policy.status
python3 - <<'EOF'
import json
try:
    body = json.load(open(".pcc/policy.json"))
except ValueError:
    body = {}
stored = (open(".pcc/policy.status").read().strip() == "200" and isinstance(body, dict)
          and body.get("source") != "default" and "updatedAt" in body and isinstance(body.get("policy"), dict))
print("CLEAR" if stored and body["policy"].get("emergencyStop") is False else "STOPPED")
EOF
```
A new kernel has no stored policy yet, so this reads `STOPPED` at first. The drill below leaves one.

**The drill.** Set the stop, and read it: it must say `STOPPED`.
```bash
curl -s -X POST "$BASE/api/operator/emergency-stop" -H @.pcc/auth.header -H 'Content-Type: application/json' \
  -d "{\"kernelId\": \"$KID\", \"reason\": \"verification drill\"}"
```
While the stop is set, send the device its own stop: for this device `POST $DEV/estop`, after which `GET $DEV/status` shows `estopped`.

**What this drill shows, and what it doesn't.** It shows that the stop reads `STOPPED`, and that the device's own stop works. It does **not** show that anything else refuses work for a stopped kernel:
- the current gateway still accepts and queues a job submitted for a stopped kernel, and still lists it to the node (fixing that is gateway work);
- pcc-node 0.1.1 does not read the stop (that feature is held for a later release).

So the only guard is yours: read the stop immediately before every run (section 3 step 5, and the operating loop's rules 1 and 5 in phase 7).

Then clear it. **The human confirms the device is safe first:**
```bash
curl -s -X POST "$BASE/api/operator/emergency-resume" -H @.pcc/auth.header -H 'Content-Type: application/json' -d "{\"kernelId\": \"$KID\"}"
curl -s -X POST "$DEV/reset"
```
Read the stop once more: it must now say `CLEAR`, because the stop and resume left a stored policy. If it doesn't, stop and report `verify blocked`.

## 2. The test job: blocked on the current gateway
A test job needs a submission that only queues it for your node. No current gateway route does that for certain:
- `POST /api/jobs/submit` starts a job at once, before any check of yours can run, when its kernel is the gateway's own local kernel, or for any kernel when the gateway's runtime has no kernel id configured. It can start any device the gateway has loaded, including devices registered in its database, and a request can even name the device.
- No endpoint reports the gateway's local kernel id together with every device it can start: `GET /api/setup/detect` lists only its configured devices, not the ones loaded from its database.
- `submit-from-discovery` creates a paid job. It settles for real whenever the gateway's own settlement mode is real, whatever its `paymentMethod` says. Never use it for a test.

So **don't submit a test job.** The drill above is this phase's result. Report the test job blocked:
```bash
bin/pcc-report verify blocked "the stop read STOPPED then CLEAR and the device stopped on command; no queue-only test submission on this gateway, so the test job waits"
```
The test job runs as in section 3 once the gateway offers a server-enforced queue-only submission (a gateway row). Then check, before running it: the submission answered `"status": "queued"` with no `deviceId`, and `GET $BASE/api/jobs/<jobId>/settlement` shows `"session": null` and `"escrow": null`.

## 3. Run it the way the operating loop will (phase 7), once, by hand
Only once a queue-only test submission exists (section 2). Every step either passes, or refuses **without touching the device**.
1. **See the job:** `curl -s "$BASE/api/operator/jobs?kernelId=$KID" -H @.pcc/auth.header`.
2. **Resolve its parameters.** For a test job, they are the ones you sent with its submission. A buyer's job carries none on the current gateway (board G6): they sit in the job's negotiation session (`GET $BASE/api/jobs/<jobId>/settlement` gives `session.id`, then `GET $BASE/api/negotiate/session/<sessionId>` gives the `selections`), and phase 7 does not run buyers' jobs yet.
3. **Re-check the envelope's confirmation, then type-check and envelope-check the parameters.**
   - Recompute the digest of `.pcc/envelope.json` and compare it with `.pcc/envelope.confirmed.json`. If they differ, the envelope changed after the human confirmed it, so stop and ask again: `python3 -c "import hashlib,json; d='0x'+hashlib.sha256(open('.pcc/envelope.json','rb').read()).hexdigest(); assert d == json.load(open('.pcc/envelope.confirmed.json'))['digest'], 'envelope changed since it was confirmed'; print('envelope as confirmed')"`
   - Type-check the parameters against `.pcc/operations.json`, and envelope-check them against `.pcc/envelope.json`. Any failure means: don't run it; set the status `failed`, with the reason.
4. **Check the device is idle:** `curl -s $DEV/status` shows `idle`. `busy` or `estopped` means don't run.
5. **Read the stop, then run.** Read the stop (section 1's check) immediately before the run: anything but `CLEAR` means don't run. Then set status `in_progress`, and `POST $DEV/runs` with exactly the checked parameters. Poll `GET $DEV/runs/<runId>` until it is `succeeded`, `failed` or `stopped`, and save that last answer as `.pcc/run.json`. Then fetch `GET $DEV/runs/<runId>/log`.
6. **Finish, the node's way:** evidence first. Then send the final status that the code below computes, never one you type. It is `completed` only for a run that `succeeded` whose evidence receipt says `"stored": true` for this `jobId` with a non-empty `bundleId`. Anything else is `failed`, with the reasons.
```bash
curl -s -X POST "$BASE/api/operator/evidence" -H @.pcc/auth.header -H 'Content-Type: application/json' \
  -d @.pcc/evidence.json > .pcc/evidence-receipt.json        # .pcc/evidence.json: {jobId, kernelId, evidence: {run, readings, log, bundleHash}}
python3 - <<'EOF' > .pcc/final-status.json
import json
job = json.load(open(".pcc/evidence.json"))["jobId"]
run = json.load(open(".pcc/run.json"))
try:
    receipt = json.load(open(".pcc/evidence-receipt.json"))
except ValueError:
    receipt = {}
reasons = []
if not isinstance(run, dict) or run.get("status") != "succeeded":
    reasons.append("run_not_succeeded")
if not isinstance(receipt, dict) or receipt.get("stored") is not True or receipt.get("jobId") != job:
    reasons.append("evidence_not_stored")
elif not (isinstance(receipt.get("bundleId"), str) and receipt["bundleId"]):
    reasons.append("evidence_receipt_without_bundle")
body = {"jobId": job, "kernelId": open(".pcc/kernel-id").read().strip(), "status": "failed" if reasons else "completed"}
if reasons:
    body["metadata"] = {"reason": ",".join(reasons)}
print(json.dumps(body))
EOF
cat .pcc/final-status.json
curl -s -X POST "$BASE/api/operator/job-status" -H @.pcc/auth.header -H 'Content-Type: application/json' \
  --data-binary @.pcc/final-status.json
```
The relay answers HTTP 200 even when it could not store the evidence, with `"stored": false` (an unknown job, a storage failure). That is why the receipt itself is checked, and why no command here sends a status by hand.

**Don't** call `pcc_job_complete` after this. It is for jobs run through execution scopes, and it answers 409 here.

**Check:**
- the device's own `GET $DEV/runs` lists the run;
- the evidence receipt says `"stored": true` for this job, with a `bundleId`;
- the job shows the status `.pcc/final-status.json` holds.

On the current gateway, evidence from this by-hand path is stored **unverified** (boards G3 and G1). It stays unverified until the operating agent signs evidence that is checked against your kernel's registered key (#428, D4a).

**Done when:** the stop read `STOPPED` during the drill and `CLEAR` after it, and the device stopped on its own command. The test job stays blocked, and reported so (section 2), until the gateway offers a queue-only submission. When it runs, its final status comes from the code above.
**Next:** [operate](07-operate.md).
