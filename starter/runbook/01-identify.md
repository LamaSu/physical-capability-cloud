# Phase 1: identify

**Goal:** know exactly what the device is and how to reach it, from the device itself. **Ask the human nothing here.** Everything in this phase is yours to find (class A).

## 1. Ask the device
Most instruments describe themselves. Try its own API first, then its manual, then the nameplate.
```bash
DEVICE=http://127.0.0.1:8765          # the device's address, WITH its port
curl -sf "$DEVICE/health"; echo
curl -sf "$DEVICE/info";   echo        # make, model, serial, firmware, capabilities
curl -sf "$DEVICE/status"; echo        # idle or busy
```
The endpoints differ by device. Read the manual (`DEVICE_MANUAL.md`, the vendor PDF, or the device's own `/docs`), and use whatever it documents.

**Always write the device address with an explicit port** (`http://host:8080`, not `http://host`). It pins every request to that one host.

## 2. If the device can't say what it is
Describe it, or send a photo of its label or screen, to the gateway's identifier:
```bash
curl -s -X POST "$(cat .pcc/base)/api/onboard/identify-device" \
  -H 'Content-Type: application/json' \
  -d '{"text": "96-well absorbance plate reader, label says SIM-PR1"}'
# → {"candidates": [...], "clarifyingQuestions": [...], "askForPhoto": false}
```
It needs an LLM on the gateway, and answers 503 where there is none. Then use the manual. Pass `clarifyingQuestions` to the human only if you can't answer them yourself.

## 3. Record what you found
Later phases read it from `.pcc/device.json`. Write only what the device, manual or label told you. **Never invent a serial number or firmware version:** unknown is `null`.
```bash
cat > .pcc/device.json <<'EOF'
{"make": "Veriswell Instruments", "model": "SIM-PR1", "serial": "SIM-0001",
 "firmware": "1.4.2", "url": "http://127.0.0.1:8765", "protocol": "generic-http",
 "class": "lab_instrument", "sources": ["GET /info", "DEVICE_MANUAL.md"]}
EOF
```
`protocol` is how pcc-node talks to it: `octoprint`, `opentrons`, `ipp`, or `generic-http` for anything with its own HTTP API. `class` is one of `lab_instrument`, `robot`, `printer`, `process_agent` or `other`.

**Done when:** make, model, serial and firmware are recorded (or `null`, with the reason), and the device answers at the recorded address.

```bash
bin/pcc-report identify ok "SIM-PR1 plate reader identified from GET /info; reachable at its URL"
```
**Next:** [intake](02-intake.md).
