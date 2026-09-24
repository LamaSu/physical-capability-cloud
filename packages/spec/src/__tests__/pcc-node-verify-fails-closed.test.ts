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
import importlib.util, json, os, sys
sys.modules["nacl"] = None  # PyNaCl unavailable
spec = importlib.util.spec_from_file_location("pcc_node_crypto", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
home = os.path.expanduser("~")
print(json.dumps({
    "hasNacl": m._HAS_NACL,
    "verifiesWithoutPynacl": m.verify_signature({"a": 1}, "00" * 64, "11" * 32),
    "compromisedKeys": len(m.COMPROMISED_PUBLIC_KEYS),
    "defaultKeyPathUnderHome": m.default_key_path().startswith(home + os.sep),
}))
`;

describe("pcc-node verify_signature fails closed (N35b)", () => {
  it("without PyNaCl no signature verifies, and the key file default is outside the checkout", () => {
    const out = JSON.parse(
      execFileSync("python3", ["-c", PROBE, CRYPTO_PY], {
        encoding: "utf8",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      }),
    );
    expect(out).toEqual({
      hasNacl: false,
      verifiesWithoutPynacl: false,
      compromisedKeys: 1,
      defaultKeyPathUnderHome: true,
    });
  });

  it("no key file is committed in the pcc-node package", () => {
    expect(existsSync(COMMITTED_KEY_FILE)).toBe(false);
  });
});
