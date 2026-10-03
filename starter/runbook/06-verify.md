# Phase 6: verify

**Goal:** the emergency stop reads correctly, and one test job travels buyer → gateway → your device → evidence → finished, with no money involved. **Ask the human** (class C) once: "May I run one emergency-stop drill, and then one test job on the device? No money moves."

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

## 2. Be your own test buyer, with no money involved
Use a second key, so the test is a real buyer-to-operator job. A buyer signs nothing, so it sends a throwaway public key: that keeps a private key out of the response here too.

Submit the test job with `POST /api/jobs/submit`. For a kernel the gateway does not run itself, that route only queues the job: no quote, no escrow, no payment, and nothing runs until your node takes it. **For the gateway's own local kernel it starts the job at once** on the gateway's local devices, before any of the checks below. So check two things first:
- **The gateway can't run a real device itself.** `GET $BASE/api/setup/detect` lists the gateway's own devices under `kernelService.devices`. Every one must be a mock (`"adapterType": "mock"`), or the list empty. If any is real, a submission could start it directly: don't submit, and report `verify blocked` (a queue-only test submission is gateway work).
- **The stop reads `CLEAR`** (section 1's check).

**Don't use `submit-from-discovery` for a test.** It settles for real whenever the gateway's own settlement mode is real, whatever its `paymentMethod` field says, and it prices the job from a template, not from your capability. No gateway reports its settlement mode yet, so no paid job can be treated as a test.
```bash
umask 077
curl -s "$BASE/api/setup/detect" -H @.pcc/auth.header > .pcc/detect.json
python3 -c "import json; ks = json.load(open('.pcc/detect.json')).get('kernelService') or {}; real = [d for d in ks.get('devices') or [] if not isinstance(d, dict) or d.get('adapterType') != 'mock']; assert not real, f'the gateway runs real devices itself: {real}'; print('gateway runs no real device itself')"
BUYER_PUB=$(python3 -c "import nacl.signing; print(nacl.signing.SigningKey.generate().verify_key.encode().hex())")
curl -s -X POST "$BASE/api/auth/provision" -H 'Content-Type: application/json' \
  -d "{\"email\": \"test-buyer@example.org\", \"name\": \"test buyer\", \"publicKey\": \"$BUYER_PUB\"}" \
  | python3 -c "import json,sys; print('Authorization: Bearer ' + json.load(sys.stdin)['api_key'])" > .pcc/buyer.header
python3 - <<'EOF' > .pcc/test-job-request.json
import json
print(json.dumps({"kernelId": open(".pcc/kernel-id").read().strip(), "stepId": "verify-1",
                  "capabilityType": "lab.absorbance",
                  "parameters": {"plateFormat": "96-well", "wavelengthNm": 450, "wells": ["A1", "A2"]}}))
EOF
curl -s -X POST "$BASE/api/jobs/submit" -H @.pcc/buyer.header -H 'Content-Type: application/json' \
  --data-binary @.pcc/test-job-request.json > .pcc/test-job.json
python3 -c "import json; j = json.load(open('.pcc/test-job.json')); assert j.get('status') == 'queued' and j.get('deviceId') is None and j.get('jobId'), j; print(j['jobId'])"
```
The answer must be `"status": "queued"` with `"deviceId": null`: queued for your node. A `deviceId`, or any other status, means the gateway took the job to run itself. Then it is not your test: report `verify blocked` with what it answered.

**Check that no money is attached:** `GET $BASE/api/jobs/<jobId>/settlement` must show `"session": null` and `"escrow": null`. Anything else means this is not a test job: don't run it, and report `verify blocked` with what it showed.

## 3. Run it the way the operating loop will (phase 7), once, by hand
Every step either passes, or refuses **without touching the device**.
1. **See the job:** `curl -s "$BASE/api/operator/jobs?kernelId=$KID" -H @.pcc/auth.header`.
2. **Resolve its parameters.** For this test job, they are the ones you sent, in `.pcc/test-job-request.json`. A buyer's job carries none on the current gateway (board G6): they sit in the job's negotiation session (`GET $BASE/api/jobs/<jobId>/settlement` gives `session.id`, then `GET $BASE/api/negotiate/session/<sessionId>` gives the `selections`), and phase 7 does not run buyers' jobs yet.
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

**Done when:** the stop read `STOPPED` during the drill and `CLEAR` after it, the device stopped on its own command, and the test job (queued for your node, no money attached) ran on the device after one more `CLEAR` read, with its final status computed by the code above.
```bash
bin/pcc-report verify ok "the stop read STOPPED then CLEAR and the device stopped on command; one test job (no money, queued for this node) ran after a CLEAR read; its evidence was stored (unverified)" --job-id "<jobId>"
```
**Next:** [operate](07-operate.md).
