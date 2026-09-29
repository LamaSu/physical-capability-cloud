# Phase 0: prerequisites

**Goal:** a working gateway address, pcc-node with signing support, and an API key that never appears in a log.

Run every command from the folder you are onboarding in. State lives in `./.pcc/`, which stays out of git (see `.gitignore`), so it survives shells that forget variables.

## 1. The gateway: PCC_BASE
Use the PCC gateway you were given. At an event, a rehearsal or a staging gateway, **never call production** (`https://capability.network`) unless you were told to.

**Ask the human** (class C) only if no gateway was given: "Which PCC gateway should this machine join? I need its URL."

```bash
umask 077 && mkdir -p .pcc
printf '%s\n' "http://127.0.0.1:4310" > .pcc/base    # the gateway you were given
curl -sf "$(cat .pcc/base)/api/health" && echo " gateway OK"
```
**Check:** `/api/health` answers 200 with JSON. If not, stop and report `prerequisites blocked`. Don't guess another address.

## 2. pcc-node, with the crypto extra
pcc-node runs next to the device. It registers the kernel, signs its evidence and runs jobs. The `crypto` extra (pynacl) is **not optional**: without it the node cannot register a signing key or sign evidence, so its work can never verify.

```bash
python3 -m pip install 'pcc-node[crypto]>=0.1.1'
```
Until 0.1.1 is on PyPI (0.1.0 was withdrawn for security fixes), install the release commit instead:
```bash
python3 -m pip install 'pcc-node[crypto] @ git+https://github.com/LamaSu/physical-capability-cloud@81a0994af1409fa1a87c9d5ec00d784923b6a16c#subdirectory=packages/pcc-node'
```
**Check:**
```bash
pcc-node --version                                   # pcc-node, version 0.1.1 (or later)
python3 -c "import nacl.signing" && echo "signing OK"
```

## 3. An operator API key, captured without logging it
**Ask the human** (class C): "Which email should this operator account be registered under?" The key is issued to it.

The provisioning response contains your **API key and a server-minted signing private key**. Write the response straight to a private file, and **never print it, echo it, or paste it into the conversation**.

```bash
umask 077
curl -s -X POST "$(cat .pcc/base)/api/auth/provision" \
  -H 'Content-Type: application/json' \
  -d '{"email": "operator@example.org", "name": "Bench plate reader"}' > .pcc/provision.json
python3 -c "import json; print(json.load(open('.pcc/provision.json'))['api_key'], end='')" > .pcc/api-key
chmod 600 .pcc/api-key .pcc/provision.json
```
The key can do everything the account can, so treat it like a password. Keep `.pcc/` out of any repository or chat. Delete `.pcc/provision.json` once you no longer need the private key in it.

**Check:**
```bash
curl -s "$(cat .pcc/base)/api/auth/validate" -H "Authorization: Bearer $(cat .pcc/api-key)"
# → {"valid": true, ...}
```

## 4. Open the attempt and report
Every phase ends with one report, whether it worked or not. The first call creates `.pcc/attempt.json`, holding this attempt's `sessionId`.
```bash
export PCC_HARNESS=claude-code      # or codex, pcc-hosted, other
bin/pcc-report prerequisites ok "gateway healthy, pcc-node 0.1.1 with crypto, key valid"
```
If something failed, report it with `failed` or `blocked` and what you saw. Then stop or continue as the phase says. Reports never block the onboarding.

**Next:** [identify](01-identify.md).
