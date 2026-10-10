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
The node signs its evidence with an Ed25519 key. Make it now, on this machine, and give PCC only its public half. That way the node's signing key never travels: a provisioning request without a public key gets a server-made private key back in the response.
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

**Payouts: tell, don't ask.** PCC does not yet pay a wallet you name. Today settlement pays a wallet the gateway generates and holds for the account, or the gateway's own signer, and nothing lets you bind or check another destination. So this runbook runs test jobs only: no money moves in phases 6 and 7. Tell the human that, don't ask for a payout wallet, and promise no payouts. Paid operation waits for a gateway that pays a wallet the human confirms (a gateway row).

Write the human's answer into `.pcc/operator.json` with your file-writing tool, not with `echo` or `printf`: a command's text can be read by other users of this machine while it runs (`ps`). For example: `{"email": "operator@example.org", "name": "Bench plate reader"}`. The request below is built from that file, sent from a private file, and deleted.

The response contains your **API key** three times: in `api_key`, and again inside `usage.header` and `usage.example`. It may also contain `operator_wallet.private_key`, a wallet key the gateway mints and keeps for the account: only when this call registers the account's on-chain identity and the gateway then generates the wallet. A failed on-chain assignment of that wallet afterwards does not remove the key. This runbook never uses it. A request without a `publicKey` would also get back a server-made Ed25519 private key, twice (`ed25519.private_key` and `ed25519.private_key_pkcs8_base64`); the request below always sends your node's public key, so this response carries neither. Write the whole response straight to a private file, and **never print it, echo it, or paste it into the conversation**.

```bash
set -euo pipefail
umask 077
fail() { printf '%s\n' "$1" >&2; exit 1; }
python3 -c 'import sys' 2>/dev/null || fail 'Python3 is required; request refused.'
python3 - <<'PY' 2>/dev/null || fail 'Unsafe private directory; request refused.'
import os, stat
s = os.lstat(".pcc")
if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid(): raise SystemExit(1)
PY
chmod 700 .pcc || fail 'Private directory permissions failed.'
python3 - <<'PY' 2>/dev/null || fail 'Existing operator credentials; archive them inside .pcc/archive/ before retrying.'
import os
if any(os.path.lexists(".pcc/" + n) for n in ("provision.json", "api-key", "auth.header")): raise SystemExit(1)
if any(n.startswith("capture.") for n in os.listdir(".pcc")): raise SystemExit(1)
PY
python3 - <<'PY' 2>/dev/null || fail 'Invalid gateway base file; request refused.'
import os, re, stat, sys
from pathlib import Path
from urllib.parse import urlsplit
p = Path(".pcc/base"); s = p.lstat()
if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid(): raise SystemExit(1)
b = p.read_bytes().decode().rstrip("\n"); u = urlsplit(b)
(b and not b.endswith("/") and not re.search(r"[\s@?#]", b) and (u.port is None or 1 <= u.port <= 65535) and ((u.scheme == "https" and re.fullmatch(r"(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(?::[0-9]+)?", u.netloc)) or (u.scheme == "http" and not u.path and re.fullmatch(r"(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?", u.netloc)))) or sys.exit(1)
PY
python3 - <<'PY' 2>/dev/null || fail 'Invalid operator input or public key; request refused.'
import json, os, re, stat
from pathlib import Path
for name in ("operator.json", "node-public-key", "base"):
    s = os.lstat(".pcc/" + name)
    if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid(): raise SystemExit(1)
operator = json.loads(Path(".pcc/operator.json").read_text())
if not isinstance(operator, dict) or not isinstance(operator.get("email"), str) or len(operator["email"]) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", operator["email"]): raise SystemExit(1)
if "name" in operator and not isinstance(operator["name"], str): raise SystemExit(1)
if not re.fullmatch(r"[a-fA-F0-9]{64}", Path(".pcc/node-public-key").read_text().strip()): raise SystemExit(1)
for name in ("operator.json", "node-public-key", "base"): Path(".pcc", name).chmod(0o600)
PY
in_git=0
if git rev-parse --git-dir >/dev/null 2>&1; then
    in_git=1
    tracked=$(git ls-files -- .pcc 2>/dev/null) || fail 'Git index verification failed.'
    [ -z "$tracked" ] || fail 'Private state has tracked paths; remove them from the index before retrying.'
    needs_exclude=0
    for credential in .pcc/provision.json .pcc/api-key .pcc/auth.header .pcc/capture.probe/provision.json; do git check-ignore -q -- "$credential" 2>/dev/null || needs_exclude=1; done
    if [ "$needs_exclude" = 1 ]; then
        exclude=$(git rev-parse --git-path info/exclude 2>/dev/null) || fail 'Git exclusion setup failed.'
        python3 -c 'import sys; from pathlib import Path; p = Path(sys.argv[1]); d = p.read_bytes() if p.exists() else b""; open(p, "ab").write((b"\n" if d and not d.endswith(b"\n") else b"") + b".pcc/\n")' "$exclude" 2>/dev/null || fail 'Git exclusion setup failed.'
    fi
    # Defence in depth: verify final destinations before any response can contain credentials.
    for credential in .pcc/provision.json .pcc/api-key .pcc/auth.header; do
        git check-ignore -q -- "$credential" 2>/dev/null || fail 'Git exclusion verification failed; capture refused.'
    done
else
    python3 - <<'PY' 2>/dev/null || fail 'Git repository detection failed; request refused.'
import os
from pathlib import Path
cwd = Path.cwd()
if os.environ.get("GIT_DIR") or any((os.path.islink(p / ".git") or (p / ".git").is_file() or os.path.lexists(p / ".git" / "HEAD")) for p in (cwd, *cwd.parents)): raise SystemExit(1)
PY
    printf '%s\n' 'Outside a Git repository; private state uses filesystem permissions.'
fi
capture_dir=$(mktemp -d .pcc/capture.XXXXXXXX) || fail 'Private capture setup failed.'
request_started=0
cleanup_unissued() { if [ "$request_started" = 0 ]; then rm -rf -- "$capture_dir"; fi; }
trap cleanup_unissued EXIT
if [ "$in_git" = 1 ]; then
    for credential in "$capture_dir/provision.json" "$capture_dir/auth.header" "$capture_dir/api-key" "$capture_dir/provision-request.json" "$capture_dir/response.headers" "$capture_dir/curl.stderr"; do
        git check-ignore -q -- "$credential" 2>/dev/null || fail 'Git capture exclusion verification failed; capture refused.'
    done
fi
python3 - "$capture_dir" <<'PY' 2>/dev/null || { rm -rf -- "$capture_dir"; fail 'Private request setup failed.'; }
import json, sys
from pathlib import Path
operator = json.loads(Path(".pcc/operator.json").read_text())
request = {"email": operator["email"], "publicKey": Path(".pcc/node-public-key").read_text().strip()}
if "name" in operator: request["name"] = operator["name"]
with open(Path(sys.argv[1]) / "provision-request.json", "x") as f: json.dump(request, f)
PY
request_started=1
if http_status=$(curl -s --connect-timeout 15 --max-time 600 -X POST "$(cat .pcc/base)/api/auth/provision" -H 'Content-Type: application/json' --data-binary @"$capture_dir/provision-request.json" --output "$capture_dir/provision.json" --dump-header "$capture_dir/response.headers" --write-out '%{http_code}' 2> "$capture_dir/curl.stderr"); then :; else
    curl_status=$?
    case "$curl_status" in 1|3|6|7) request_started=0; fail 'Provision request not sent; no key was issued.';; esac
    [ "$curl_status" != 28 ] || fail 'Provision request timed out; a key may have been issued and cannot be recovered; it counts toward the 5-key cap. Report the failure once; archive the capture with the archive command, then provision again at most once; stop and report if that fails too. Revoke the orphan key later from an authenticated session.'
    fail 'Provision request failed; a key may have been issued and cannot be recovered; it counts toward the 5-key cap. Report the failure once; archive the capture with the archive command, then provision again at most once; stop and report if that fails too. Revoke the orphan key later from an authenticated session.'
fi
if [ "$http_status" != 201 ]; then
    python3 - "$capture_dir" "$http_status" <<'PY' 2>/dev/null || { rm -rf -- "$capture_dir"; fail 'Provision request rejected; response projection failed.'; }
import json, re, sys
from pathlib import Path
stage = Path(sys.argv[1])
try: r = json.loads((stage / "provision.json").read_text())
except Exception: r = {}
if not isinstance(r, dict): r = {}
codes = {"rate_limited", "invalid_type", "invalid_wallet_address", "invalid_email", "identifier_required", "provision_failed", "too_many_keys", "invalid_public_key"}
print("http_status: " + (sys.argv[2] if re.fullmatch(r"[0-9]{3}", sys.argv[2]) else "unrecognised"))
print("error: " + (r.get("error") if isinstance(r.get("error"), str) and r["error"] in codes else "unrecognised"))
retry = r.get("retry_after_seconds")
headers = (stage / "response.headers").read_text().splitlines()
if not isinstance(retry, int) or isinstance(retry, bool): retry = next((int(value.strip()) for name, _, value in (line.partition(":") for line in headers) if name.lower() == "retry-after" and re.fullmatch(r"[0-9]+", value.strip())), None)
if isinstance(retry, int) and not isinstance(retry, bool): print("retry_after_seconds: " + str(retry))
trace = r.get("trace_id")
if not isinstance(trace, str) or not re.fullmatch(r"tr_[0-9a-f]{16,32}", trace):
    trace = None
    for line in headers:
        name, _, value = line.partition(":")
        if name.lower() == "x-pcc-trace-id" and re.fullmatch(r"tr_[0-9a-f]{16,32}", value.strip()): trace = value.strip()
print("trace_id: " + json.dumps(trace, ensure_ascii=True))
PY
    rm -rf -- "$capture_dir" || fail 'Rejected request cleanup failed.'
    case "$http_status" in 5[0-9][0-9]) fail 'Provision server failure; a key may exist server-side and counts toward the 5-key cap; report once with the printed trace_id; do not loop.';; 429) fail 'Provision request limited; honor retry_after_seconds; do not loop.';; esac
    fail 'Provision request rejected; no credentials were published. Correct the request before retrying.'
fi
if [ "$in_git" = 1 ]; then
    for credential in "$capture_dir/provision.json" .pcc/provision.json .pcc/api-key .pcc/auth.header; do
        git check-ignore -q -- "$credential" 2>/dev/null || fail 'Git exclusion verification failed after capture; keep private state and stop.'
    done
fi
python3 - "$capture_dir" <<'PY' 2>/dev/null || fail 'Provision capture refused; preserve the private capture and archive it inside .pcc/archive/ before retrying.'
import json, os, re, sys
from pathlib import Path
stage = Path(sys.argv[1])
r = json.loads((stage / "provision.json").read_text())
if not isinstance(r, dict) or r.get("error") or not isinstance(r.get("key_id"), str) or not r["key_id"]: raise SystemExit(1)
ed = r.get("ed25519")
if not isinstance(ed, dict) or ed.get("source") != "byok" or any("private_key" in k for k in ed): raise SystemExit(1)
k = r.get("api_key")
if not isinstance(k, str) or not re.fullmatch(r"pcc_live_[a-f0-9]{64}", k): raise SystemExit(1)
names = ("provision.json", "api-key", "auth.header")
if any(os.path.lexists(Path(".pcc") / name) for name in names): raise SystemExit(1)
for name, value in (("api-key", k), ("auth.header", "Authorization: Bearer " + k + "\n")):
    with open(stage / name, "x") as f: f.write(value)
for name in names: os.chmod(stage / name, 0o600)
published = []
try:
    for name in names:
        os.link(stage / name, Path(".pcc") / name)
        published.append(name)
except Exception:
    for name in published:
        final = Path(".pcc") / name
        if os.path.samestat(os.lstat(stage / name), os.lstat(final)): os.unlink(final)
    raise
PY
rm -rf -- "$capture_dir" || fail 'Private capture cleanup failed.'
printf '%s\n' 'provision_status: provisioned'
```
The recipe requires owned regular input files and validates them before private staging. In a Git repository it refuses tracked private state and verifies that every credential destination is ignored, including after the response arrives. Outside a repository it prints one fixed note and continues with `.pcc/` at 0700. The request can await on-chain registration and wallet assignment, so curl waits up to 600 seconds. HTTP 201 is required before importing a BYOK response. A rejection prints only `http_status`, an allowlisted fixed `error` code or `unrecognised`, an integer `retry_after_seconds` from the body or an ASCII-digit Retry-After header, and a validated JSON-escaped `trace_id`; its private staging is removed. For 5xx, a key may exist server-side and counts toward the 5-key cap: report once with the printed trace_id and do not loop. For 429, honor retry_after_seconds and do not loop. Correct every other rejected request before retrying. Curl exits 1, 3, 6 and 7 remove staging because the request was not sent and no key was issued. Every other transport failure or an invalid 201 preserves its capture: a key may have been issued and cannot be recovered, and it counts toward the 5-key cap. Report the failure once; archive the capture with the archive command, then provision again at most once; stop and report if that fails too. Revoke the orphan key later from an authenticated session. Never print the response or its diagnostics.

Every later call sends the key with `curl -H @.pcc/auth.header`. That keeps it off the command line, where other users of this machine could read it (`ps`). The key can do everything the account can, so treat it like a password. Keep `.pcc/` out of any repository or chat. Delete `.pcc/provision.json` once `.pcc/api-key` is written. Existing credentials are never overwritten. If you need to set them aside, keep the node signing key, public key, operator input and gateway in place; archive only the API credentials and captures inside the same ignored directory with this command, then verify the archive remains ignored when working in Git:

```bash
python3 -c 'exec("import os, shutil, stat, subprocess, uuid\nfrom datetime import datetime, timezone\nfrom pathlib import Path\ndef secure(path):\n    s = path.lstat()\n    if s.st_uid != os.getuid() or not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)): raise SystemExit(1)\n    path.chmod(0o700 if stat.S_ISDIR(s.st_mode) else 0o600)\nroot = Path(\".pcc\")\nsecure(root)\nif not root.is_dir(): raise SystemExit(1)\nin_git = bool(shutil.which(\"git\")) and subprocess.run([\"git\", \"rev-parse\", \"--git-dir\"], capture_output=True).returncode == 0\ncwd = Path.cwd()\nif not in_git and (os.environ.get(\"GIT_DIR\") or any((os.path.islink(p / \".git\") or (p / \".git\").is_file() or os.path.lexists(p / \".git\" / \"HEAD\")) for p in (cwd, *cwd.parents))): raise SystemExit(1)\nif in_git and subprocess.run([\"git\", \"ls-files\", \"--\", \".pcc\"], check=True, capture_output=True).stdout: raise SystemExit(1)\narchive = root / \"archive\"\nif not archive.exists(): archive.mkdir(mode=0o700)\nsecure(archive)\nif not archive.is_dir(): raise SystemExit(1)\ndest = archive / (datetime.now(timezone.utc).strftime(\"%Y%m%dT%H%M%SZ-\") + uuid.uuid4().hex)\nin_git and subprocess.run([\"git\", \"check-ignore\", \"-q\", \"--\", str(dest)], check=True, capture_output=True)\ndest.mkdir(mode=0o700)\nfor path in root.iterdir():\n    if path.name not in (\"provision.json\", \"api-key\", \"auth.header\", \"ed25519-private.pem\") and not path.name.startswith((\"capture.\", \"auth.header.\")): continue\n    secure(path)\n    if path.is_dir():\n        for base, dirs, files in os.walk(path):\n            for name in dirs + files: secure(Path(base) / name)\n    target = dest / path.name\n    in_git and subprocess.run([\"git\", \"check-ignore\", \"-q\", \"--\", str(target)], check=True, capture_output=True)\n    if target.exists(): raise SystemExit(1)\n    path.rename(target)\nprint(\"Private state archived inside .pcc/archive; validate recovered keys before provisioning.\")\n")' 2>/dev/null || { printf '%s\n' 'Private archive refused; verify owned private state and Git exclusions.' >&2; exit 1; }
```

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
