/**
 * N35b, proven where CI runs it. CI executes no Python suite yet (N52), so this
 * vitest test runs pcc-node's crypto.py itself: it loads the module by path with
 * PyNaCl made unimportable and checks that verification fails closed, that the
 * key committed to the repository is on the denylist, and that the default key
 * file is under the user's home, not the checkout.
 *
 * crypto.py imports only the standard library (PyNaCl is optional), so plain
 * python3 is enough. A missing python3 fails this test; it never skips.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CRYPTO_PY = fileURLToPath(new URL("../../../pcc-node/pcc_node/crypto.py", import.meta.url));
const COMMITTED_KEY_FILE = fileURLToPath(new URL("../../../pcc-node/pcc-keys.json", import.meta.url));

const PROBE = `
import hashlib, importlib.util, json, os, sys
sys.modules["nacl"] = None  # PyNaCl unavailable
spec = importlib.util.spec_from_file_location("pcc_node_crypto", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
home = os.path.expanduser("~")
in_checkout = sys.argv[2]  # a path inside this repository's checkout
try:
    m.load_or_create_keys(in_checkout)
    refused_in_checkout = False
except m.KeyFileError:
    refused_in_checkout = True
print(json.dumps({
    "hasNacl": m._HAS_NACL,
    "verifiesWithoutPynacl": m.verify_signature({"a": 1}, "00" * 64, "11" * 32),
    "compromisedKeyFingerprints": sorted(hashlib.sha256(k.encode()).hexdigest()[:16] for k in m.COMPROMISED_PUBLIC_KEYS),
    "defaultKeyPathUnderHome": m.default_key_path().startswith(home + os.sep),
    "refusesKeyFileInCheckout": refused_in_checkout and not os.path.exists(in_checkout),
}))
`;

describe("pcc-node verify_signature fails closed (N35b)", () => {
  it("without PyNaCl no signature verifies, the committed key is denylisted, and no key file is made in the checkout", () => {
    const out = JSON.parse(
      execFileSync("python3", ["-c", PROBE, CRYPTO_PY, COMMITTED_KEY_FILE], {
        encoding: "utf8",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      }),
    );
    expect(out).toEqual({
      hasNacl: false,
      verifiesWithoutPynacl: false,
      // The committed key's entry itself (sha256 of its hex text), not a count.
      compromisedKeyFingerprints: ["e3b726020a9bb4a5"],
      defaultKeyPathUnderHome: true,
      // Creating a key file inside this checkout is refused, and nothing is written.
      refusesKeyFileInCheckout: true,
    });
  });

  it("no key file is committed in the pcc-node package", () => {
    expect(existsSync(COMMITTED_KEY_FILE)).toBe(false);
  });
});
