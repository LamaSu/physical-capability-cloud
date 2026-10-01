/**
 * N35b, proven where CI runs it. CI executes no Python suite yet (N52), so this
 * vitest test runs pcc-node's crypto.py itself: it loads the module by path with
 * PyNaCl made unimportable and checks that verification fails closed, that no
 * key is created, loaded or used, that the key committed to the repository is
 * on the denylist, that a key location inside a checkout is refused, and that
 * the default key file is under the user's home. It works in a synthetic
 * checkout under the temp directory, never in this repository.
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
import hashlib, importlib.util, json, os, shutil, sys, tempfile
sys.modules["nacl"] = None  # PyNaCl unavailable
spec = importlib.util.spec_from_file_location("pcc_node_crypto", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
os.environ.pop("PCC_NODE_KEY_PATH", None)
home = os.path.expanduser("~")
# A synthetic checkout in the temp directory: this test never points the key
# code at this repository, so a regression cannot leave a secret in the tree.
tmp = tempfile.mkdtemp(prefix="pcc-n35b-")
try:
    os.makedirs(os.path.join(tmp, "repo", ".git"))
    in_checkout = os.path.join(tmp, "repo", "packages", "pcc-node", "pcc-keys.json")
    outside = os.path.join(tmp, "outside", "keys.json")
    # The checkout check is decided from an open directory, so give it one.
    os.makedirs(os.path.dirname(in_checkout))
    checkout_dir = os.open(os.path.dirname(in_checkout), os.O_RDONLY | os.O_DIRECTORY)
    try:
        m._refuse_checkout(checkout_dir, in_checkout)
        checkout_refused = False
    except m.KeyFileError:
        checkout_refused = True
    finally:
        os.close(checkout_dir)
    refused = 0
    for attempt in (lambda: m.load_or_create_keys(outside), lambda: m.load_or_create_keys(in_checkout),
                    lambda: m.generate_node_keys(), lambda: m.sign_announcement({"a": 1}, "11" * 32)):
        try:
            attempt()
        except m.CryptoUnavailableError:
            refused += 1
    wrote_nothing = not os.path.exists(in_checkout) and not os.path.exists(outside)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print(json.dumps({
    "hasNacl": m._HAS_NACL,
    "verifiesWithoutPynacl": m.verify_signature({"a": 1}, "00" * 64, "11" * 32),
    "compromisedKeyFingerprints": sorted(hashlib.sha256(k.encode()).hexdigest()[:16] for k in m.COMPROMISED_PUBLIC_KEYS),
    "defaultKeyPathUnderHome": m.default_key_path().startswith(home + os.sep),
    "refusesKeyFileInCheckout": checkout_refused,
    "keyOperationsRefusedWithoutPynacl": refused,
    "wroteNothing": wrote_nothing,
}))
`;

describe("pcc-node verify_signature fails closed (N35b)", () => {
  it("without PyNaCl nothing verifies and no key is used; the committed key is denylisted; a checkout location is refused", () => {
    const out = JSON.parse(
      execFileSync("python3", ["-c", PROBE, CRYPTO_PY], {
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
      // A key location inside a (synthetic) checkout is refused.
      refusesKeyFileInCheckout: true,
      // Without PyNaCl no key is created, loaded or used (cross-family A02), and nothing is written.
      keyOperationsRefusedWithoutPynacl: 4,
      wroteNothing: true,
    });
  });

  it("no key file is committed in the pcc-node package", () => {
    expect(existsSync(COMMITTED_KEY_FILE)).toBe(false);
  });
});
