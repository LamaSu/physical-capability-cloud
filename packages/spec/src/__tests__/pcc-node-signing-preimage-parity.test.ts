/**
 * LO-EV-1 Python byte parity, proven where CI runs it. CI has python3 but runs
 * no Python suite yet (N52), so this vitest test loads pcc-node's
 * signing_preimage.py by path (it imports only the standard library) and checks
 * every golden and every accept/reject parity vector in goldens.json, byte for
 * byte, decoding the vectors' JSON text with json.loads. Signature parity needs
 * PyNaCl and stays in test_signing_preimage_parity.py, which fails instead of
 * skipping when PCC_REQUIRE_PYNACL=1. A missing python3 fails this test; it
 * never skips.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MODULE = fileURLToPath(new URL("../../../pcc-node/pcc_node/signing_preimage.py", import.meta.url));
const GOLDENS = fileURLToPath(new URL("../../../pcc-node/tests/goldens.json", import.meta.url));

const PROBE = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("pcc_node_signing_preimage", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
g = json.load(open(sys.argv[2], encoding="utf-8"))
text = lambda b: b.decode("utf-8", "surrogatepass")
bad = []
for v in g["signing_preimage"]:
    if m.signing_preimage(v["digest"]).hex() != v["preimage_hex"]:
        bad.append(v["name"])
for v in g["session_delegation"]:
    s = dict(v["session"])
    s["publicKey"] = bytes.fromhex(s.pop("publicKeyHex"))
    if text(m.session_key_delegation_preimage(s)) != v["preimage_utf8"]:
        bad.append(v["name"])
for v in g["session_revocation"]:
    if text(m.session_revocation_preimage(v["revocation"])) != v["preimage_utf8"]:
        bad.append(v["name"])
for v in g["parity_vectors"]:
    parsed = json.loads(v["json"])
    try:
        if v["kind"] == "revocation":
            got = text(m.session_revocation_preimage(parsed))
        else:
            s = dict(parsed)
            s["publicKey"] = m.parse_ed25519_public_key_hex(s.pop("publicKeyHex", None))
            got = text(m.session_key_delegation_preimage(s))
    except m.SigningPreimageError:
        got = "REJECT"
    if got != ("REJECT" if v.get("reject") else v["preimage_utf8"]):
        bad.append(v["name"])
checked = sum(len(g[k]) for k in ("signing_preimage", "session_delegation", "session_revocation", "parity_vectors"))
print(json.dumps({"checked": checked, "mismatches": bad}))
`;

describe("pcc-node signing_preimage.py byte parity (LO-EV-1, runs in CI)", () => {
  it("reproduces every golden and agrees with every accept/reject vector", () => {
    const goldens = JSON.parse(readFileSync(GOLDENS, "utf8"));
    const expected =
      goldens.signing_preimage.length +
      goldens.session_delegation.length +
      goldens.session_revocation.length +
      goldens.parity_vectors.length;
    const out = JSON.parse(
      execFileSync("python3", ["-c", PROBE, MODULE, GOLDENS], {
        encoding: "utf8",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      }),
    );
    expect(out).toEqual({ checked: expected, mismatches: [] });
    expect(expected).toBeGreaterThanOrEqual(37);
  });
});
