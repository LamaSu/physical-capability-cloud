# Phase 5: register

**Goal:** the kernel, its signing key, its capability and its device exist on the gateway, and buyers can find the capability. The order is kernel-first. Every call sends the key from `.pcc/auth.header`, so nothing prints it and no command line carries it.

```bash
BASE=$(cat .pcc/base)
```

## 1. The kernel (the site)
Choose the kernel's id, and write down what the kernel says about itself. Nothing is sent yet: step 2 creates the kernel and registers its signing key in one call. If `.pcc/kernel-id` already holds an id, it is kept.
```bash
[ -s .pcc/kernel-id ] || python3 -c "import secrets; print('kernel-' + secrets.token_hex(6))" > .pcc/kernel-id
cat > .pcc/kernel-fields.json <<'JSON'
{
  "name": "Bench plate reader",
  "description": "Veriswell SIM-PR1 absorbance plate reader, 96-well, 405/450/600 nm",
  "location": {"lat": 37.80, "lng": -122.27},
  "physicalAddress": "Oakland, US"
}
JSON
python3 -c "import json; json.load(open('.pcc/kernel-fields.json')); print('kernel id', open('.pcc/kernel-id').read().strip())"
```
**Check:** `.pcc/kernel-id` holds an id such as `kernel-3f9a0c1b2d4e`, and the last command prints it. The location comes from intake, as coarse as the human chose. The gateway reads only `lat` and `lng` from `location`, so a text address goes in `physicalAddress`.

## 2. The kernel's signing key
Create the kernel and register the node key you made in phase 0 (step 3) as its signing key, in one call. The node signs its evidence with it, so its work can be checked against the kernel. pcc-node proves possession by signing a challenge; the private half never leaves the selected key file. Use the default `~/.pcc-node/keys.json`, or set `PCC_NODE_KEY_PATH` (or the fallback `PCC_NODE_KEYS_FILE`) to an absolute path outside this folder and every source checkout. Use the same location as phase 0, keeping any override set. Keep this owner-only location outside every source checkout. Key persistence requires Linux (see phase 0 step 3).

**First, GET `$BASE/api/kernels/<id>`.** It answers 404 for a new id. A 200 means a kernel already has this id, such as one an earlier run in this folder created; the call below then registers this node's key on it. Any other answer means the request itself failed: check `.pcc/base` and the API key first.
```bash
echo "GET kernel: $(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/kernels/$(cat .pcc/kernel-id)" -H @.pcc/auth.header)"
```
Then create the kernel and register its key:
```bash
python3 - <<'EOF'
import json, os
import nacl.signing                                 # refuses here if the crypto extra is missing
from pcc_node.crypto import load_or_create_keys
from pcc_node.register import register_kernel_signed
read = lambda name: open(".pcc/" + name).read().strip()
key_path = os.environ.get("PCC_NODE_KEY_PATH") or os.environ.get("PCC_NODE_KEYS_FILE") or os.path.expanduser("~/.pcc-node/keys.json")
if not os.path.isabs(key_path) or os.path.realpath(key_path).startswith(os.path.realpath(".") + os.sep):
    raise SystemExit("The node key location must be an absolute path outside this folder and every source checkout")
os.makedirs(os.path.dirname(key_path), mode=0o700, exist_ok=True)  # owner-only key directory
pub, sec = load_or_create_keys(key_path)              # explicit: the key file from phase 0 step 3
payload = dict(json.load(open(".pcc/kernel-fields.json")), id=read("kernel-id"))
data = register_kernel_signed(read("base"), read("api-key"), payload, pub, sec)
json.dump(data, open(".pcc/kernel.json", "w"))
print("kernel", data["kernel"]["id"], "signing key", data["kernel"]["signingKey"]["publicKey"][:18] + "...")
EOF
```
**Check:** it prints the kernel id and the start of its signing key, and `GET $BASE/api/kernels/$(cat .pcc/kernel-id)` then shows that `signingKey`. If the call refuses a kernel that already had this id, delete `.pcc/kernel-id` and run step 1 again: the kernel gets a new id. A line starting `Waiting` means pcc-node is waiting out an earlier registration attempt, for up to 11 minutes: let it finish.

If it refuses with "pynacl" or `signing_key_unusable`:
1. Install the crypto extra (phase 0 step 2).
2. If an older pcc-node made an unregistered placeholder without pynacl, retire the selected key file and delete `.pcc/node-public-key`. The placeholder can never sign. Current pcc-node refuses to create a key without pynacl.
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
- `pcc-node start`: its daemon takes no jobs, and its heartbeat tells the gateway so (`acceptingJobs: false`), which lets your listing age out.
- `onboard_machine` and `prove_registration` are self-attestation, not verification (board S3).

Phase 6 exercises the device. Its evidence stays unverified until the operating agent signs it.

**Next:** [verify](06-verify.md).
