# Phase 4: build

**Goal:** a pcc-node configuration for the device, the device's **typed operations**, and a **safety envelope** the human has confirmed once.

## 1. The pcc-node configuration
Keep it in `.pcc/` (private), not in the working directory. pcc-node saves your API key into this file after registering.
```bash
python3 - <<'EOF'
import json
d = json.load(open(".pcc/device.json"))
cfg = {"kernel_name": "Bench plate reader",               # a name the human is happy to show buyers
       "pcc_base": open(".pcc/base").read().strip(),
       "devices": [{"id": "sim-pr1-0001", "protocol": d["protocol"], "url": d["url"], "model": d["model"]}],
       "approval_mode": "manual"}
json.dump(cfg, open(".pcc/pcc-node.json", "w"), indent=2)
EOF
```
`protocol` picks pcc-node's adapter: `octoprint`, `opentrons`, `ipp`, or anything else for generic HTTP.

## 2. Typed operations
List every operation the device will run for buyers, with **typed inputs and outputs** and ranges taken from phase 3. Nothing a job sends reaches the device except through one of these.
```json
[{"name": "read_absorbance",
  "inputs": {"wavelengthNm": {"type": "integer", "enum": [405, 450, 600], "unit": "nm"},
             "wells": {"type": "array", "items": {"type": "string", "pattern": "^[A-H](1[0-2]|[1-9])$"}, "minItems": 1, "maxItems": 96},
             "plateFormat": {"type": "string", "enum": ["96-well"]}},
  "outputs": {"readings": {"type": "object", "additionalProperties": {"type": "number", "unit": "AU"}}},
  "sources": ["DEVICE_MANUAL.md 3.1", "research.json#0"]}]
```
Save this as `.pcc/operations.json`. It is the device's contract: buyers see it through the capability (phase 5), and the node enforces it.

> **Important on the current code:** pcc-node's generic-HTTP adapter lets a job's raw parameters choose the device request. Until the operating agent lands (ADK item 12: typed `DeviceRuntime.run(operation, params)`), **never let a job's raw parameters reach the device**. Run only the operations listed here, after checking the parameters against them (phase 7).

## 3. The safety envelope: draft, then one confirmation (R8)
From `.pcc/research.json` and `.pcc/intake.json`, draft `.pcc/envelope.json`:
- **Every quantity the device can drive**, with min, max, unit and source. A quantity with no sourced value is a **question for the human**, never a default.
- **Forbidden states**, each with a reason and a source. Example: "never read with the lid open".
- **The emergency stop:**
  - `mechanism`: `hardware`, `adapter-stop` or `none`;
  - where it is, and who can press it (from intake).
  `none` blocks activation for anything that moves or heats.
```json
{"device": "SIM-PR1", "limits": [
   {"quantity": "temperature", "min": 15, "max": 45, "unit": "degC", "source": "research.json#0"},
   {"quantity": "run duration", "max": 30, "unit": "min", "source": "DEVICE_MANUAL.md 4.2"}],
 "forbiddenStates": [{"when": "lid open", "reason": "stray light corrupts readings", "source": "DEVICE_MANUAL.md 4.4"}],
 "estop": {"mechanism": "hardware", "where": "front panel", "whoCanPress": "lab tech on duty"}}
```
Show the human the whole envelope **once**, and ask: "These are the limits the device will never exceed. Yes, or edit?" If they edit a value, re-check its unit and source, and show the changed lines again. Then record the confirmation:
```bash
python3 - <<'EOF'
import hashlib, json, datetime
digest = "0x" + hashlib.sha256(open(".pcc/envelope.json", "rb").read()).hexdigest()
json.dump({"confirmedBy": "operator (asked in chat)", "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
           "digest": digest}, open(".pcc/envelope.confirmed.json", "w"), indent=2)
print(digest)
EOF
```
Any later change to the envelope needs a new confirmation.

**Done when:** `.pcc/pcc-node.json`, `.pcc/operations.json` and `.pcc/envelope.json` exist, and `.pcc/envelope.confirmed.json` records the human's yes.
```bash
bin/pcc-report build ok "node config, 1 typed operation, envelope with 2 limits confirmed once by the operator"
```
Coming:
- sensors' R8 builder (`@pcc/spec`, onboarding/safety-envelope, target 10-14) will draft, confirm and compile the envelope for you, including the gateway's enforced copy;
- ADK item 12 will make pcc-node run only typed operations within it.

**Next:** [register](05-register.md).
