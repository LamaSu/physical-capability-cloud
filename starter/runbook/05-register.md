# Phase 5: register

**Goal:** the kernel, its signing key, its capability and its device exist on the gateway, and buyers can find the capability. The order is kernel-first. Every call sends the key from `.pcc/auth.header`, so nothing prints it and no command line carries it.

```bash
BASE=$(cat .pcc/base)
```

## 1. The kernel (the site)
```bash
curl -s -X POST "$BASE/api/kernels" -H @.pcc/auth.header -H 'Content-Type: application/json' -d '{
  "name": "Bench plate reader",
  "description": "Veriswell SIM-PR1 absorbance plate reader, 96-well, 405/450/600 nm",
  "location": {"lat": 37.80, "lng": -122.27},
  "physicalAddress": "Oakland, US"
}' > .pcc/kernel.json
python3 -c "import json; print(json.load(open('.pcc/kernel.json'))['kernel']['id'])" > .pcc/kernel-id
```
**Check:** HTTP 201, and `.pcc/kernel-id` holds an id such as `kernel_…`. The location comes from intake, as coarse as the human chose. The gateway reads only `lat` and `lng` from `location`, so a text address goes in `physicalAddress`.

## 2. The kernel's signing key
Register the node key you made in phase 0 (step 3) as the kernel's signing key. The node signs its evidence with it, so its work can be checked against the kernel. pcc-node proves possession by signing a challenge; the private half never leaves `.pcc/node-keys.json`.

**First, GET `$BASE/api/kernels/<id>`** and check it is the kernel you just created, with no signing key yet. A mistyped id would sign, and create, a different kernel.
```bash
curl -s "$BASE/api/kernels/$(cat .pcc/kernel-id)" -H @.pcc/auth.header | python3 -c "import json,sys; k=json.load(sys.stdin)['kernel']; assert k['id'] == open('.pcc/kernel-id').read().strip() and not k.get('signingKey'), k.get('id'); print('kernel', k['id'], 'ready for its key')"
python3 - <<'EOF'
from pcc_node.crypto import load_or_create_keys
from pcc_node.register import register_signing_key
read = lambda name: open(".pcc/" + name).read().strip()
pub, sec = load_or_create_keys(".pcc/node-keys.json")
status, _ = register_signing_key(read("base"), read("api-key"), read("kernel-id"), pub, sec)
print("signing key:", status)
EOF
chmod 600 .pcc/node-keys.json
```
**Check:** status 200 or 201. `GET $BASE/api/kernels/$(cat .pcc/kernel-id)` then shows a non-null `signingKey`.

If it refuses with "pynacl" or `LogSigningRefused`:
1. Install the crypto extra (phase 0 step 2).
2. Delete `.pcc/node-keys.json` and `.pcc/node-public-key`. Made without pynacl, the key file holds a placeholder that can never sign, and it was never registered.
3. Run phase 0 step 3 again for a real key, then this step.

## 3. The capability (what buyers can order)
Choose the type: search first (`GET $BASE/api/capabilities/search?q=absorbance`). If nothing fits, use a dotted `category.action` name such as `lab.absorbance`. The price is the human's (intake), never a default: it is read from `.pcc/intake.json`. Put the typed operation from `.pcc/operations.json` in the description, because **the current gateway drops `requirementsSchema`**.
```bash
PRICING=$(python3 -c "import json; p = json.load(open('.pcc/intake.json'))['price']['value']; print(json.dumps({'currency': p['currency'], 'baseCost': p['amount'], 'minimum': p['amount']}))")
curl -s -X POST "$BASE/api/capabilities" -H @.pcc/auth.header -H 'Content-Type: application/json' -d "{
  \"kernelId\": \"$(cat .pcc/kernel-id)\",
  \"type\": \"lab.absorbance\",
  \"name\": \"96-well absorbance read (SIM-PR1)\",
  \"description\": \"read_absorbance: wavelengthNm one of 405, 450, 600; wells A1-H12 (1-96 of them); 96-well plates. Returns per-well absorbance (AU).\",
  \"pricing\": $PRICING
}" > .pcc/capability.json
```
**Check:** HTTP 201, and `GET $BASE/api/capabilities/search?q=absorbance` finds it.

## 4. The device
Don't list capabilities in this call. The gateway would create a second, zero-priced capability from them; your capability is the one from step 3.

`deviceId` and `adapterType` are required. `type` is the device's role: `machine`, `sensor` or `camera`. `adapterType` is one of `octoprint`, `modbus`, `opcua`, `sila`, `ipp`, `generic-http` or `mock`.
```bash
curl -s -X POST "$BASE/api/setup/register-device" -H @.pcc/auth.header -H 'Content-Type: application/json' -d "{
  \"kernelId\": \"$(cat .pcc/kernel-id)\", \"deviceId\": \"sim-pr1-0001\", \"type\": \"machine\",
  \"model\": \"SIM-PR1\", \"adapterType\": \"generic-http\",
  \"adapterConfig\": {\"url\": \"http://127.0.0.1:8765\"}
}"
```
**Check:** HTTP 201, or 200 if it already existed.

## 5. A channel for job notifications
The operator status wants a notification channel. The operating loop polls for jobs itself (phase 7), so the channel is `manual`: it gives the gateway no address to send to or write at. The operator's slug is the account's id, the email you provisioned with.
```bash
SLUG=$(python3 -c "import urllib.parse,json; print(urllib.parse.quote(json.load(open('.pcc/kernel.json'))['kernel']['operatorAddress'], safe=''))")
curl -s -X POST "$BASE/api/operators/$SLUG/channels" -H @.pcc/auth.header -H 'Content-Type: application/json' \
  -d '{"label": "operating loop", "transport": "manual", "direction": "out", "endpoint": {}, "describe": "the local operating loop polls GET /api/operator/jobs; nothing is sent", "enabled": true}'
curl -s "$BASE/api/operators/$SLUG/status" -H @.pcc/auth.header
```
**Check:** the channel is created (201). The status lists what is still missing. On the current gateway, availability can't be set, so that slot stays open; it is not your error.

**Done when:** the kernel has a signing key, the capability is findable, and the device is registered.
```bash
bin/pcc-report register ok "kernel, signing key, lab.absorbance capability, device registered" --kernel-id "$(cat .pcc/kernel-id)"
```
**Not this path, on the current code:**
- `pcc-node start`: from 0.1.1 its daemon takes no jobs, and its heartbeat tells the gateway so (`acceptingJobs: false`), which lets your listing age out.
- `onboard_machine` and `prove_registration` are self-attestation, not verification (board S3).

Phase 6 exercises the device. Its evidence stays unverified until the operating agent signs it.

**Next:** [verify](06-verify.md).
