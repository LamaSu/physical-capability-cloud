# Phase 6: verify

**Goal:** one real job travels buyer → gateway → your device → evidence → finished, and the emergency stop works. **Ask the human** (class C) once: "May I run one real test job on the device, and one emergency-stop drill?"

Don't use `POST /api/setup/test-job` as proof. On the current gateway it runs on a built-in mock device, not yours (board N59; the fix is #450).

```bash
BASE=$(cat .pcc/base); KID=$(cat .pcc/kernel-id); DEV=http://127.0.0.1:8765
```

## 1. Be your own test buyer
Use a second key, so the test is a real buyer-to-operator job. Test mode moves no money. A buyer signs nothing, so it sends a throwaway public key: that keeps a private key out of the response here too.
```bash
umask 077
BUYER_PUB=$(python3 -c "import nacl.signing; print(nacl.signing.SigningKey.generate().verify_key.encode().hex())")
curl -s -X POST "$BASE/api/auth/provision" -H 'Content-Type: application/json' \
  -d "{\"email\": \"test-buyer@example.org\", \"name\": \"test buyer\", \"publicKey\": \"$BUYER_PUB\"}" \
  | python3 -c "import json,sys; print('Authorization: Bearer ' + json.load(sys.stdin)['api_key'])" > .pcc/buyer.header
curl -s -X POST "$BASE/api/jobs/submit-from-discovery" -H @.pcc/buyer.header \
  -H 'Content-Type: application/json' -d "{
  \"kernelId\": \"$KID\", \"capabilityType\": \"lab.absorbance\",
  \"parameters\": {\"plateFormat\": \"96-well\", \"wavelengthNm\": 450, \"wells\": [\"A1\", \"A2\"]},
  \"paymentMethod\": \"testnet-mock\", \"userAgentId\": \"test-buyer@example.org\"}" > .pcc/test-job.json
python3 -c "import json; print(json.load(open('.pcc/test-job.json'))['jobId'])"
```
**Check the price before anything runs:** the job's quote must equal the human's price in `.pcc/intake.json`, in amount and currency. If it differs, the gateway priced the job itself (today it can default it), so stop and report `verify blocked` with both values. Never run a job at a price the human did not set.
```bash
python3 - <<'EOF'
import json
quote = json.load(open(".pcc/test-job.json"))["quote"]
price = json.load(open(".pcc/intake.json"))["price"]["value"]
same = float(quote["totalPrice"]) == float(price["amount"]) and quote["currency"] == price["currency"]
print("price OK" if same else f"PRICE MISMATCH: quoted {quote['totalPrice']} {quote['currency']}, intake {price['amount']} {price['currency']}")
EOF
```

## 2. Run it the way the operating loop will (phase 7), once, by hand
Every step either passes, or refuses **without touching the device**.
1. **See the job:** `curl -s "$BASE/api/operator/jobs?kernelId=$KID" -H @.pcc/auth.header`.
2. **Resolve its parameters.** The polled job carries none on the current gateway (board G6). They sit in the job's negotiation session: `GET $BASE/api/jobs/<jobId>/settlement` gives `session.id`, then `GET $BASE/api/negotiate/session/<sessionId>` gives the `selections`.
3. **Re-check the envelope's confirmation, then type-check and envelope-check the parameters.**
   - Recompute the digest of `.pcc/envelope.json` and compare it with `.pcc/envelope.confirmed.json`. If they differ, the envelope changed after the human confirmed it, so stop and ask again: `python3 -c "import hashlib,json; d='0x'+hashlib.sha256(open('.pcc/envelope.json','rb').read()).hexdigest(); assert d == json.load(open('.pcc/envelope.confirmed.json'))['digest'], 'envelope changed since it was confirmed'; print('envelope as confirmed')"`
   - Type-check the parameters against `.pcc/operations.json`, and envelope-check them against `.pcc/envelope.json`. Any failure means: don't run it; set the status `failed`, with the reason.
4. **Check the device is idle:** `curl -s $DEV/status` shows `idle`. `busy` or `estopped` means don't run.
5. **Run:** set status `in_progress`, then `POST $DEV/runs` with exactly the checked parameters. Poll `GET $DEV/runs/<runId>` until it is `succeeded`, `failed` or `stopped`, then fetch `GET $DEV/runs/<runId>/log`.
6. **Finish, the node's way:** evidence first, and `completed` **only if the evidence was stored for this job**.
```bash
curl -s -X POST "$BASE/api/operator/evidence" -H @.pcc/auth.header -H 'Content-Type: application/json' \
  -d @.pcc/evidence.json > .pcc/evidence-receipt.json        # .pcc/evidence.json: {jobId, kernelId, evidence: {run, readings, log, bundleHash}}
python3 -c "import json; r = json.load(open('.pcc/evidence-receipt.json')); job = json.load(open('.pcc/evidence.json'))['jobId']; print('STORED' if r.get('stored') is True and r.get('jobId') == job else 'NOT STORED: ' + json.dumps(r))"
```
The relay answers HTTP 200 even when it could not store the evidence, with `"stored": false` (an unknown job, a storage failure). So the receipt must say `"stored": true` and name this `jobId`. If it doesn't, send `failed` with the reason `evidence_not_stored`, never `completed`:
```bash
curl -s -X POST "$BASE/api/operator/job-status" -H @.pcc/auth.header -H 'Content-Type: application/json' \
  -d "{\"jobId\": \"<jobId>\", \"kernelId\": \"$KID\", \"status\": \"completed\"}"     # only after STORED
```
**Don't** call `pcc_job_complete` after this. It is for jobs run through execution scopes, and it answers 409 here.

**Check:**
- the device's own `GET $DEV/runs` lists the run;
- the evidence receipt says `"stored": true` for this job;
- the job shows `completed`.

On the current gateway, evidence from this by-hand path is stored **unverified**, and the test escrow is not released (boards G3 and G1). It stays unverified until the operating agent signs evidence that is checked against your kernel's registered key (#428, D4a).

## 3. Emergency-stop drill
```bash
curl -s -X POST "$BASE/api/operator/emergency-stop" -H @.pcc/auth.header -H 'Content-Type: application/json' \
  -d "{\"kernelId\": \"$KID\", \"reason\": \"verification drill\"}"
curl -s "$BASE/api/operator/policy/$KID" -H @.pcc/auth.header        # emergencyStop: true
```
While the stop is set:
- send the device its own stop: for this device `POST $DEV/estop`, after which `GET $DEV/status` shows `estopped`;
- submit a second test job (step 1). The gateway should refuse it while the kernel is stopped.

**What this drill shows, and what it doesn't.** It shows that the gateway refuses new jobs for a stopped kernel, and that the device's own stop works. It does **not** show that a running node notices the flag:
- pcc-node 0.1.1 does not read it (that feature is held for a later release);
- in the operating loop, reading it before every job is the loop's rule 1 (phase 7).

A policy read that fails (any answer but 200) counts as stopped.

Then clear it. **The human confirms the device is safe first:**
```bash
curl -s -X POST "$BASE/api/operator/emergency-resume" -H @.pcc/auth.header -H 'Content-Type: application/json' -d "{\"kernelId\": \"$KID\"}"
curl -s -X POST "$DEV/reset"
```

**Done when:** the test job ran on the device and its evidence was stored for it, and the drill showed the gateway refusing a job while stopped and the device stopping on its own command.
```bash
bin/pcc-report verify ok "one real job ran on the device; its evidence was stored (unverified); while stopped the gateway refused a job and the device stopped" --job-id "<jobId>"
```
**Next:** [operate](07-operate.md).
