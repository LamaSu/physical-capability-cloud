# Phase 6: verify

**Goal:** one real job travels buyer → gateway → your device → evidence → finished, and the emergency stop works. **Ask the human** (class C) once: "May I run one real test job on the device, and one emergency-stop drill?"

Don't use `POST /api/setup/test-job` as proof. On the current gateway it runs on a built-in mock device, not yours (board N59; the fix is #450).

```bash
BASE=$(cat .pcc/base); OP="Authorization: Bearer $(cat .pcc/api-key)"; KID=$(cat .pcc/kernel-id); DEV=http://127.0.0.1:8765
```

## 1. Be your own test buyer
Use a second key, so the test is a real buyer-to-operator job. Test mode moves no money.
```bash
umask 077
curl -s -X POST "$BASE/api/auth/provision" -H 'Content-Type: application/json' \
  -d '{"email": "test-buyer@example.org", "name": "test buyer"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['api_key'], end='')" > .pcc/buyer-key
curl -s -X POST "$BASE/api/jobs/submit-from-discovery" -H "Authorization: Bearer $(cat .pcc/buyer-key)" \
  -H 'Content-Type: application/json' -d "{
  \"kernelId\": \"$KID\", \"capabilityType\": \"lab.absorbance\",
  \"parameters\": {\"plateFormat\": \"96-well\", \"wavelengthNm\": 450, \"wells\": [\"A1\", \"A2\"]},
  \"paymentMethod\": \"testnet-mock\", \"userAgentId\": \"test-buyer@example.org\"}" > .pcc/test-job.json
python3 -c "import json; print(json.load(open('.pcc/test-job.json'))['jobId'])"
```

## 2. Run it the way the operating loop will (phase 7), once, by hand
Every step either passes, or refuses **without touching the device**.
1. **See the job:** `curl -s "$BASE/api/operator/jobs?kernelId=$KID" -H "$OP"`.
2. **Resolve its parameters.** The polled job carries none on the current gateway (board G6). They sit in the job's negotiation session: `GET $BASE/api/jobs/<jobId>/settlement` gives `session.id`, then `GET $BASE/api/negotiate/session/<sessionId>` gives the `selections`.
3. **Type-check** them against `.pcc/operations.json`, and **envelope-check** them against `.pcc/envelope.json`. Any failure means: don't run it; set the status `failed`, with the reason.
4. **Check the device is idle:** `curl -s $DEV/status` shows `idle`. `busy` or `estopped` means don't run.
5. **Run:** set status `in_progress`, then `POST $DEV/runs` with exactly the checked parameters. Poll `GET $DEV/runs/<runId>` until it is `succeeded`, `failed` or `stopped`, then fetch `GET $DEV/runs/<runId>/log`.
6. **Finish, the node's way:** two calls, in this order.
```bash
curl -s -X POST "$BASE/api/operator/evidence" -H "$OP" -H 'Content-Type: application/json' \
  -d @.pcc/evidence.json        # {jobId, kernelId, evidence: {run, readings, log, bundleHash}}
curl -s -X POST "$BASE/api/operator/job-status" -H "$OP" -H 'Content-Type: application/json' \
  -d "{\"jobId\": \"<jobId>\", \"kernelId\": \"$KID\", \"status\": \"completed\"}"
```
**Don't** call `pcc_job_complete` after this. It is for jobs run through execution scopes, and it answers 409 here.

**Check:**
- the device's own `GET $DEV/runs` lists the run;
- evidence answered 200;
- the job shows `completed`.

On the current gateway, evidence from this by-hand path is stored **unverified**, and the test escrow is not released (boards G3 and G1). "Verified" arrives with the operating agent's **signed** evidence, checked against your kernel's registered key (#428, D4a).

## 3. Emergency-stop drill
```bash
curl -s -X POST "$BASE/api/operator/emergency-stop" -H "$OP" -H 'Content-Type: application/json' \
  -d "{\"kernelId\": \"$KID\", \"reason\": \"verification drill\"}"
curl -s "$BASE/api/operator/policy/$KID" -H "$OP"        # emergencyStop: true
```
While the stop is set:
- the operating loop must take **no** job;
- it must send the device its stop. For this device that is `POST $DEV/estop`, and `GET $DEV/status` then shows `estopped`.

Submit a second test job (step 1), and check that it is **not** run.

Then clear it. **The human confirms the device is safe first:**
```bash
curl -s -X POST "$BASE/api/operator/emergency-resume" -H "$OP" -H 'Content-Type: application/json' -d "{\"kernelId\": \"$KID\"}"
curl -s -X POST "$DEV/reset"
```
pcc-node's daemon starts honouring this flag with item 9 (#454). The operating loop checks it on every job.

**Done when:** the test job ran on the device and finished, and the drill stopped and then resumed intake.
```bash
bin/pcc-report verify ok "one real job ran on the device and finished; e-stop drill refused a job and stopped the device" --job-id "<jobId>"
```
**Next:** [operate](07-operate.md).
