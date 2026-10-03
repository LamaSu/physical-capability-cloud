# Phase 0: prerequisites

**Goal:** a working gateway address, pcc-node with signing support, and an API key that never appears in a log.

Run every command from the folder you are onboarding in. State lives in `./.pcc/`, which stays out of git (see `.gitignore`), so it survives shells that forget variables.

## 1. The gateway: PCC_BASE
Use the PCC gateway you were given. There is no default. At an event, a rehearsal or a staging gateway, **never call production** (`https://capability.network`) unless you were told to.

**Ask the human** (class C) only if no gateway was given: "Which PCC gateway should this machine join? I need its URL."

pcc-node talks to a gateway only over **https**, or over plain http to **127.0.0.1** or **[::1]** on this machine. It refuses `http://localhost` and plain http to any other host, because the operator key would cross the network in clear text.

```bash
umask 077 && mkdir -p .pcc && chmod 700 .pcc    # chmod repairs a .pcc made earlier with looser modes
printf '%s\n' "http://127.0.0.1:4310" > .pcc/base    # the gateway you were given
curl -sf "$(cat .pcc/base)/api/health" && echo " gateway OK"
```
**Check:** `/api/health` answers 200 with JSON. If not, stop and report `prerequisites blocked`. Don't guess another address.

**The gateway must enforce ownership.** It must check that each operator call names a kernel or job its caller owns. Master does not do that yet for every operator route: jobs, evidence, job status and the emergency stop. The gateway's WP-C (#445) adds it. Until your gateway carries it, onboard only on a private gateway that no other tenant uses, and tell the human why.

## 2. pcc-node, with the crypto extra
pcc-node runs next to the device. It registers the kernel, signs its evidence and runs jobs. The `crypto` extra (pynacl) is **not optional**: without it the node cannot register a signing key or sign evidence, so its work can never verify.

```bash
python3 -m pip install 'pcc-node[crypto]>=0.1.1'
```
Until 0.1.1 is on PyPI (0.1.0 was withdrawn for security fixes), install the release commit instead:
```bash
python3 -m pip install 'pcc-node[crypto] @ git+https://github.com/LamaSu/physical-capability-cloud@dcc44db9a4065985207b2739fa3cce11f54a6ff5#subdirectory=packages/pcc-node'
```
**Check:**
```bash
pcc-node --version                                   # pcc-node, version 0.1.1 (or later)
python3 -c "import nacl.signing" && echo "signing OK"
```

## 3. The node's signing key, made here and never sent
The node signs its evidence with an Ed25519 key. Make it now, on this machine, and give PCC only its public half. That way no private key ever travels: a provisioning request without a public key gets a server-made private key back in the response.
```bash
umask 077
python3 - <<'EOF' > .pcc/node-public-key
import nacl.signing                                 # refuses here if the crypto extra is missing
from pcc_node.crypto import load_or_create_keys
public_hex, _ = load_or_create_keys(".pcc/node-keys.json")
print(public_hex, end="")
EOF
chmod 600 .pcc/node-keys.json
```
**Check:** `.pcc/node-public-key` holds 64 hex characters. `.pcc/node-keys.json` holds the private half; never print it or copy it anywhere.

## 4. An operator API key, captured without logging it
**Ask the human** (class C): "Which email should this operator account be registered under?"

**Payouts: tell, don't ask.** PCC does not yet pay a wallet you name. Today settlement pays a wallet the gateway generates and holds for the account, or the gateway's own signer, and nothing lets you bind or check another destination. So this runbook takes no job that carries money, and no money moves in phases 6 and 7. On the current gateway it runs no job at all: the test job waits for a queue-only submission (phase 6). Tell the human that, don't ask for a payout wallet, and promise no payouts. Paid operation waits for a gateway that pays a wallet the human confirms (a gateway row).

Write the human's answer into `.pcc/operator.json` with your file-writing tool, not with `echo` or `printf`: a command's text can be read by other users of this machine while it runs (`ps`). For example: `{"email": "operator@example.org", "name": "Bench plate reader"}`. The request below is built from that file, sent from a private file, and deleted.

The response contains your **API key**. Write it straight to a private file, and **never print it, echo it, or paste it into the conversation**.

```bash
umask 077
python3 - <<'EOF' > .pcc/provision-request.json
import json
operator = json.load(open(".pcc/operator.json"))
print(json.dumps({"publicKey": open(".pcc/node-public-key").read().strip(),
                  "email": operator["email"], "name": operator["name"]}))
EOF
curl -s -X POST "$(cat .pcc/base)/api/auth/provision" -H 'Content-Type: application/json' \
  --data-binary @.pcc/provision-request.json > .pcc/provision.json
rm -f .pcc/provision-request.json
python3 - <<'EOF'
import json
key = json.load(open(".pcc/provision.json"))["api_key"]
open(".pcc/api-key", "w").write(key)
open(".pcc/auth.header", "w").write("Authorization: Bearer " + key + "\n")
EOF
chmod 600 .pcc/api-key .pcc/auth.header .pcc/provision.json
```
Every later call sends the key with `curl -H @.pcc/auth.header`. That keeps it off the command line, where other users of this machine could read it (`ps`). The key can do everything the account can, so treat it like a password. Keep `.pcc/` out of any repository or chat. Delete `.pcc/provision.json` once `.pcc/api-key` is written.

**Check:**
```bash
curl -s "$(cat .pcc/base)/api/auth/validate" -H @.pcc/auth.header
# → {"valid": true, ...}
```

## 5. Open the attempt and report
Every phase ends with one report, whether it worked or not. The first call creates `.pcc/attempt.json`, holding this attempt's `sessionId`.
```bash
export PCC_HARNESS=claude-code      # or codex, pcc-hosted, other
bin/pcc-report prerequisites ok "gateway healthy, pcc-node 0.1.1 with crypto, key valid"
```
If something failed, report it with `failed` or `blocked` and what you saw. Then stop or continue as the phase says. Reports never block the onboarding.

On the current gateway, `/api/feedback` keeps only each report's summary and detail. The phase, outcome and attempt fields are stored once painpoints' #458 merges, so write summaries that make sense on their own.

**Next:** [identify](01-identify.md).
