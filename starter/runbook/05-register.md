# Phase 5: register

**Goal:** the kernel, its signing key, its capability and its device exist on the gateway, and buyers can find the capability. The order is kernel-first. Every call uses the key file; nothing prints it.

```bash
BASE=$(cat .pcc/base); AUTH="Authorization: Bearer $(cat .pcc/api-key)"
```

## 1. The kernel (the site)
```bash
curl -s -X POST "$BASE/api/kernels" -H "$AUTH" -H 'Content-Type: application/json' -d '{
  "name": "Bench plate reader",
  "description": "Veriswell SIM-PR1 absorbance plate reader, 96-well, 405/450/600 nm",
  "location": {"address": "Oakland, US", "lat": 37.80, "lng": -122.27}
}' > .pcc/kernel.json
python3 -c "import json; print(json.load(open('.pcc/kernel.json'))['kernel']['id'])" > .pcc/kernel-id
```
**Check:** HTTP 201, and `.pcc/kernel-id` holds an id such as `kernel_…`. The location comes from intake, as coarse as the human chose.

## 2. The kernel's signing key
The node signs its evidence with this key, so its work can be checked against the kernel. pcc-node proves possession to the gateway. The key file lives in `.pcc/`, never in the working directory.
```bash
PCC_BASE="$BASE" PCC_API_KEY="$(cat .pcc/api-key)" python3 - <<'EOF'
import os
from pcc_node.crypto import load_or_create_keys
from pcc_node.register import register_signing_key
pub, sec = load_or_create_keys(".pcc/node-keys.json")
status, _ = register_signing_key(os.environ["PCC_BASE"], os.environ["PCC_API_KEY"],
                                 open(".pcc/kernel-id").read().strip(), pub, sec)
print("signing key:", status)
EOF
chmod 600 .pcc/node-keys.json
```
**Check:** status 200 or 201. `GET $BASE/api/kernels/$(cat .pcc/kernel-id)` then shows a non-null `signingKey`. If this refuses with "pynacl", go back to phase 0 step 2.

## 3. The capability (what buyers can order)
Choose the type: search first (`GET $BASE/api/capabilities/search?q=absorbance`). If nothing fits, use a dotted `category.action` name such as `lab.absorbance`. The price is the human's (intake), never a default. Put the typed operation from `.pcc/operations.json` in the description, because **the current gateway drops `requirementsSchema`**.
```bash
curl -s -X POST "$BASE/api/capabilities" -H "$AUTH" -H 'Content-Type: application/json' -d "{
  \"kernelId\": \"$(cat .pcc/kernel-id)\",
  \"type\": \"lab.absorbance\",
  \"name\": \"96-well absorbance read (SIM-PR1)\",
  \"description\": \"read_absorbance: wavelengthNm one of 405, 450, 600; wells A1-H12 (1-96 of them); 96-well plates. Returns per-well absorbance (AU).\",
  \"pricing\": {\"currency\": \"USD\", \"baseCost\": 25, \"minimum\": 25}
}" > .pcc/capability.json
```
**Check:** HTTP 201, and `GET $BASE/api/capabilities/search?q=absorbance` finds it.

## 4. The device
`deviceId` and `adapterType` are required. `type` is the device's role: `machine`, `sensor` or `camera`. `adapterType` is one of `octoprint`, `modbus`, `opcua`, `sila`, `ipp`, `generic-http` or `mock`.
```bash
curl -s -X POST "$BASE/api/setup/register-device" -H "$AUTH" -H 'Content-Type: application/json' -d "{
  \"kernelId\": \"$(cat .pcc/kernel-id)\", \"deviceId\": \"sim-pr1-0001\", \"type\": \"machine\",
  \"model\": \"SIM-PR1\", \"adapterType\": \"generic-http\",
  \"adapterConfig\": {\"url\": \"http://127.0.0.1:8765\"}, \"capabilities\": [\"lab.absorbance\"]
}"
```
**Check:** HTTP 201, or 200 if it already existed.

## 5. A channel for job notifications
The operator status wants a notification channel. The operator's slug is the account's id, the email you provisioned with.
```bash
SLUG=$(python3 -c "import urllib.parse,json; print(urllib.parse.quote(json.load(open('.pcc/kernel.json'))['kernel']['operatorAddress'], safe=''))")
curl -s -X POST "$BASE/api/operators/$SLUG/channels" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"label": "operator log", "transport": "file", "direction": "out", "endpoint": {"scheme": "file", "path": "./.pcc/inbox.log"}, "describe": "the local operating loop picks jobs up by polling", "enabled": true}'
curl -s "$BASE/api/operators/$SLUG/status" -H "$AUTH"
```
**Check:** the channel is created (201). The status lists what is still missing. On the current gateway, availability can't be set, so that slot stays open; it is not your error.

**Done when:** the kernel has a signing key, the capability is findable, and the device is registered.
```bash
bin/pcc-report register ok "kernel, signing key, lab.absorbance capability, device registered" --kernel-id "$(cat .pcc/kernel-id)"
```
**Not this path, on the current code:**
- `pcc-node start` replaces a configured generic-HTTP device with auto-detected ones (fix: #390).
- `onboard_machine` and `prove_registration` are self-attestation, not verification (board S3).

Phase 6 is where the kernel earns "verified".

**Next:** [verify](06-verify.md).
