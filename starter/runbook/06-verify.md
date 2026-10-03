# Phase 6: verify

**Goal:** one test job travels buyer → gateway → your device → evidence → finished, with no money involved, and the emergency stop works. **Ask the human** (class C) once: "May I run one test job on the device, and one emergency-stop drill? No money moves."

Don't use `POST /api/setup/test-job` as proof. On the current gateway it runs on a built-in mock device, not yours (board N59; the fix is #450).

```bash
BASE=$(cat .pcc/base); KID=$(cat .pcc/kernel-id); DEV=http://127.0.0.1:8765
```

## 1. Be your own test buyer, with no money involved
Use a second key, so the test is a real buyer-to-operator job. A buyer signs nothing, so it sends a throwaway public key: that keeps a private key out of the response here too.

Submit the test job with `POST /api/jobs/submit`. That route creates a queued job for your kernel and nothing else: no quote, no escrow, no payment. **Don't use `submit-from-discovery` for a test.** It settles for real whenever the gateway's own settlement mode is real, whatever its `paymentMethod` field says, and it prices the job from a template, not from your capability. No gateway reports its settlement mode yet, so no paid job can be treated as a test.
```bash
umask 077
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
python3 -c "import json; j = json.load(open('.pcc/test-job.json')); assert j.get('status') == 'queued' and j.get('jobId'), j; print(j['jobId'])"
```
**Check that no money is attached:** `GET $BASE/api/jobs/<jobId>/settlement` must show `"session": null` and `"escrow": null`. Anything else means this is not a test job: don't run it, and report `verify blocked` with what it showed.

## 2. Run it the way the operating loop will (phase 7), once, by hand
Every step either passes, or refuses **without touching the device**.
1. **See the job:** `curl -s "$BASE/api/operator/jobs?kernelId=$KID" -H @.pcc/auth.header`.
2. **Resolve its parameters.** For this test job, they are the ones you sent, in `.pcc/test-job-request.json`. A buyer's job carries none on the current gateway (board G6): they sit in the job's negotiation session (`GET $BASE/api/jobs/<jobId>/settlement` gives `session.id`, then `GET $BASE/api/negotiate/session/<sessionId>` gives the `selections`), and phase 7 does not run buyers' jobs yet.
3. **Re-check the envelope's confirmation, then type-check and envelope-check the parameters.**
   - Recompute the digest of `.pcc/envelope.json` and compare it with `.pcc/envelope.confirmed.json`. If they differ, the envelope changed after the human confirmed it, so stop and ask again: `python3 -c "import hashlib,json; d='0x'+hashlib.sha256(open('.pcc/envelope.json','rb').read()).hexdigest(); assert d == json.load(open('.pcc/envelope.confirmed.json'))['digest'], 'envelope changed since it was confirmed'; print('envelope as confirmed')"`
   - Type-check the parameters against `.pcc/operations.json`, and envelope-check them against `.pcc/envelope.json`. Any failure means: don't run it; set the status `failed`, with the reason.
4. **Check the device is idle:** `curl -s $DEV/status` shows `idle`. `busy` or `estopped` means don't run.
5. **Run:** set status `in_progress`, then `POST $DEV/runs` with exactly the checked parameters. Poll `GET $DEV/runs/<runId>` until it is `succeeded`, `failed` or `stopped`, and save that last answer as `.pcc/run.json`. Then fetch `GET $DEV/runs/<runId>/log`.
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

## 3. Emergency-stop drill
**How to read the stop.** The gateway answers HTTP 200 with its built-in default policy (`"source": "default"`, `emergencyStop: false`) both when it has no stored policy for your kernel and when it cannot read its store. So the stop reads **clear only for a stored policy** (it has `updatedAt` and no `"source": "default"`) whose `emergencyStop` is `false`. Anything else counts as stopped: a default policy, any answer but 200, an unreadable body.
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
Now set the stop, and read it again with the check above. It must say `STOPPED`:
```bash
curl -s -X POST "$BASE/api/operator/emergency-stop" -H @.pcc/auth.header -H 'Content-Type: application/json' \
  -d "{\"kernelId\": \"$KID\", \"reason\": \"verification drill\"}"
```
While the stop is set:
- send the device its own stop: for this device `POST $DEV/estop`, after which `GET $DEV/status` shows `estopped`;
- submit a second test job (step 1). The gateway should refuse it while the kernel is stopped.

**What this drill shows, and what it doesn't.** It shows that the gateway refuses new jobs for a stopped kernel, and that the device's own stop works. It does **not** show that a running node notices the flag:
- pcc-node 0.1.1 does not read it (that feature is held for a later release);
- in the operating loop, reading it before every job, with the check above, is the loop's rule 1 (phase 7).

Then clear it. **The human confirms the device is safe first:**
```bash
curl -s -X POST "$BASE/api/operator/emergency-resume" -H @.pcc/auth.header -H 'Content-Type: application/json' -d "{\"kernelId\": \"$KID\"}"
curl -s -X POST "$DEV/reset"
```
Read the stop once more: it must now say `CLEAR`, because the stop and resume left a stored policy.

**Done when:** the test job ran on the device with no money attached, its final status came from the code above, and the drill showed the gateway refusing a job while stopped, the device stopping on its own command, and the stop reading `STOPPED` then `CLEAR`.
```bash
bin/pcc-report verify ok "one test job (no money) ran on the device; its evidence was stored (unverified); while stopped the gateway refused a job and the device stopped" --job-id "<jobId>"
```
**Next:** [operate](07-operate.md).
