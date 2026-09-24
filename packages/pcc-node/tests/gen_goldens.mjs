/**
 * Golden generator for Python<->TS hash parity (evidence #52 log chain).
 *
 * The `canonicalize` function below is copied VERBATIM (logic-for-logic) from
 * `packages/spec/src/util/canonical.ts` -- only the TypeScript type annotations
 * (erased at runtime) are dropped so it runs as plain ESM. It MUST stay a
 * byte-for-byte behavioral copy; if canonical.ts changes, re-copy it here and
 * regenerate goldens.json.
 *
 * `computeEntryHash` mirrors `computeLogEntryHash` in
 * `packages/spec/src/evidence/verifiers/log-chain.ts:76`:
 *   sha256(canonicalize({ capturedAt, rawContent, source }))  -> "sha256:"+hex.
 *
 * Emits tests/goldens.json with these sections:
 *   - entry_hash: [{name, rawContent, source, capturedAt, expected}]  (money seam)
 *   - canonical:  [{name, value, expected}]  (raw canonical STRING, structural)
 *   - signing_preimage / session_delegation / session_revocation: the LO-EV-1
 *     signing byte contract (`pcc.evidence.signing-preimage.v1`), mirroring
 *     packages/spec/src/evidence/signing-preimage.ts, with deterministic
 *     RFC 8032 Ed25519 signatures from fixed, labelled TEST seeds. Both the TS
 *     helper and pcc_node/signing_preimage.py are checked against them.
 *
 * Tricky fixture strings (quote, backslash, control chars) are built from
 * explicit code points via String.fromCharCode so there are NO raw control
 * chars or ambiguous backslash escapes in this source file.
 *
 * Run:  node packages/pcc-node/tests/gen_goldens.mjs
 */

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// --- VERBATIM copy of canonicalize() from spec/src/util/canonical.ts ---------
// (TypeScript types stripped; every runtime operation preserved exactly.)
function canonicalize(value) {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const pairs = keys
      .filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonicalize(value[k]));
    return "{" + pairs.join(",") + "}";
  }
  return String(value);
}
// -----------------------------------------------------------------------------

// sha256() from canonical.ts: SHA-256 over UTF-8 bytes, lowercase hex, prefixed.
function sha256(input) {
  return "sha256:" + createHash("sha256").update(input, "utf8").digest("hex");
}

// computeLogEntryHash() from log-chain.ts:76.
function computeEntryHash(rawContent, source, capturedAt) {
  return sha256(canonicalize({ capturedAt, rawContent, source }));
}

// Explicit code points -- avoids any raw control char / backslash ambiguity.
const CC = String.fromCharCode;
const BS = CC(92); // backslash  \
const DQ = CC(34); // double quote  "

// A string exercising every JSON escape shortcut (\b \t \n \f \r) AND the
// non-shortcut control chars that must go to \u00xx: bell U+0007,
// vertical-tab U+000B, unit-separator U+001F.
const CONTROL_STR =
  "tab" + CC(9) + "nl" + CC(10) + "cr" + CC(13) +
  "bell" + CC(7) + "vt" + CC(11) + "ff" + CC(12) +
  "bs" + CC(8) + "us" + CC(31) + "end";

// --- Fixture inputs ----------------------------------------------------------
// Coverage required by the wire contract: plain ASCII; embedded " and \;
// \n + tab + control chars; a non-ASCII string; an emoji. The first vector is
// ALSO the oracle's existing golden (log-chain-parity.test.ts): rawContent
// "hello", source "cups://job-1", capturedAt "2026-07-09T00:00:00.000Z" ->
// sha256:c31408369756b766d5ee02b1403cbee4ab64ed39f9c3de0b7bee4605fdf3d9cd.
const ENTRY_HASH_FIXTURES = [
  {
    name: "ascii_oracle_shared_vector",
    rawContent: "hello",
    source: "cups://job-1",
    capturedAt: "2026-07-09T00:00:00.000Z",
  },
  {
    name: "quote_and_backslash",
    rawContent: "she said " + DQ + "hi" + DQ + " then a back" + BS + "slash " + BS + " done",
    source: "cups://job-2",
    capturedAt: "2026-07-09T00:01:00.000Z",
  },
  {
    name: "newline_tab_control",
    rawContent: CONTROL_STR,
    source: "serial://tty0",
    capturedAt: "2026-07-09T00:02:00.000Z",
  },
  {
    name: "non_ascii",
    rawContent: "café ☕ 日本語 — naïve",
    source: "mdns://kettle.local",
    capturedAt: "2026-07-09T00:03:00.000Z",
  },
  {
    name: "emoji_zwj",
    rawContent: "done ✅ launch 🚀 family 👨‍👩‍👧 flag 🇺🇸",
    source: "octoprint://printer-1",
    capturedAt: "2026-07-09T00:04:00.000Z",
  },
];

// Structural fixtures: compare the raw canonical STRING (keys sorted, escaping,
// numbers, booleans, null, arrays, nested) -- proves the mirror beyond hashes.
const CANONICAL_FIXTURES = [
  { name: "key_sort", value: { b: 2, a: 1, c: 3 } },
  { name: "nested", value: { z: { y: 1, x: 2 }, a: [3, 2, 1] } },
  { name: "mixed_array", value: [1, true, false, null, "s"] },
  { name: "null_value_included", value: { k: null, a: 1 } },
  { name: "bool_num", value: { t: true, f: false, n: 42, neg: -7, zero: 0 } },
  { name: "floats", value: { pi: 3.14, half: 1.5 } },
  { name: "string_escapes", value: { q: "a" + DQ + "b", bs: "a" + BS + "b", ws: CONTROL_STR } },
  { name: "unicode_key_val", value: { "café": "☕", emoji: "🚀", ascii: "z" } },
  { name: "slash_not_escaped", value: { url: "cups://job/1?x=2" } },
];

// --- LO-EV-1 signing byte contract ------------------------------------------
// Logic mirror of packages/spec/src/evidence/signing-preimage.ts. The spec
// test and the Python test both check these outputs, so a drift in any of the
// three copies fails CI.
function signingPreimage(digest) {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("not a tagged digest: " + digest);
  return Buffer.from(digest, "utf8");
}

function sessionKeyDelegationPreimage(sk) {
  const body = {
    sessionId: sk.sessionId,
    parentAgentId: sk.parentAgentId,
    publicKey: sk.publicKeyHex,
    issuedAt: sk.issuedAt,
    expiresAt: sk.expiresAt,
    scope: {
      allowedActions: [...sk.scope.allowedActions].sort(),
      contractIds: [...sk.scope.contractIds].sort(),
      maxSignatures: sk.scope.maxSignatures,
    },
  };
  if (sk.derivationPath !== undefined) body.derivationPath = sk.derivationPath;
  return Buffer.from(JSON.stringify(body), "utf8");
}

function sessionRevocationPreimage(r) {
  return Buffer.from(JSON.stringify({ sessionId: r.sessionId, revokedAt: r.revokedAt, reason: r.reason }), "utf8");
}

// Ed25519 (RFC 8032) is deterministic: a fixed seed + message gives a fixed
// signature in node:crypto and pynacl alike. Seeds are derived from public
// labels -- these are TEST keys and sign nothing real.
const PKCS8_ED25519_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function testKey(label) {
  const seed = createHash("sha256").update("pcc-lo-ev-1-test-key:" + label, "utf8").digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_SEED_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return {
    seedHex: seed.toString("hex"),
    publicKeyHex: publicKey.toString("hex"),
    sign: (bytes) => sign(null, bytes, privateKey).toString("hex"),
  };
}

const KERNEL_KEY = testKey("kernel");
const PRINCIPAL_KEY = testKey("principal");

const SIGNING_PREIMAGE_FIXTURES = [
  {
    // The oracle shared vector's entry hash (first entry_hash fixture).
    name: "oracle_shared_entry_hash",
    digest: computeEntryHash("hello", "cups://job-1", "2026-07-09T00:00:00.000Z"),
  },
  { name: "genesis", digest: "sha256:" + "0".repeat(64) },
  {
    // A bundle hash: sha256(canonicalize(sorted event hashes)), as hashBundle().
    name: "bundle_hash",
    digest: sha256(
      canonicalize(
        [
          computeEntryHash("start", "cups://job-7", "2026-09-24T00:00:00.000Z"),
          computeEntryHash("done", "cups://job-7", "2026-09-24T00:00:05.000Z"),
        ].sort(),
      ),
    ),
  },
];

const SESSION_BASE = {
  sessionId: "sess-001",
  parentAgentId: "eip155:84532:0x1111111111111111111111111111111111111111",
  publicKeyHex: KERNEL_KEY.publicKeyHex,
  issuedAt: 1727200000,
  expiresAt: 1727203600,
  scope: {
    allowedActions: ["workflow_step_complete", "evidence_submit"],
    contractIds: ["job-b", "job-a"],
    maxSignatures: 100,
  },
};

const SESSION_DELEGATION_FIXTURES = [
  { name: "fresh_session", session: SESSION_BASE },
  { name: "derived_session", session: { ...SESSION_BASE, derivationPath: "m/44'/60'/0'/0'/7'" } },
  // Non-ASCII pins ensure_ascii=False on the Python side.
  { name: "unicode_session_id", session: { ...SESSION_BASE, sessionId: "sesión-ü-" + CC(0x65e5) } },
];

// The sorted-key (canonicalize) form of a session: NOT the contract. Kept as a
// negative control -- its bytes differ and its signature must not verify.
function sortedKeyDelegation(sk) {
  return Buffer.from(
    canonicalize({
      sessionId: sk.sessionId,
      parentAgentId: sk.parentAgentId,
      publicKey: sk.publicKeyHex,
      issuedAt: sk.issuedAt,
      expiresAt: sk.expiresAt,
      scope: {
        allowedActions: [...sk.scope.allowedActions].sort(),
        contractIds: [...sk.scope.contractIds].sort(),
        maxSignatures: sk.scope.maxSignatures,
      },
    }),
    "utf8",
  );
}

const goldens = {
  _comment:
    "Generated by tests/gen_goldens.mjs from the VERBATIM canonicalize() of " +
    "packages/spec/src/util/canonical.ts. entry_hash = computeLogEntryHash " +
    "parity (money seam); canonical = raw canonicalize() string parity; " +
    "signing_preimage / session_delegation / session_revocation = the LO-EV-1 " +
    "signing byte contract (pcc.evidence.signing-preimage.v1) with deterministic " +
    "Ed25519 test-key signatures. Regenerate if canonical.ts or " +
    "evidence/signing-preimage.ts changes.",
  entry_hash: ENTRY_HASH_FIXTURES.map((f) => ({
    ...f,
    expected: computeEntryHash(f.rawContent, f.source, f.capturedAt),
  })),
  canonical: CANONICAL_FIXTURES.map((f) => ({
    name: f.name,
    value: f.value,
    expected: canonicalize(f.value),
  })),
  signing_preimage: SIGNING_PREIMAGE_FIXTURES.map((f) => {
    const preimage = signingPreimage(f.digest);
    const raw32 = Buffer.from(f.digest.slice("sha256:".length), "hex");
    return {
      name: f.name,
      digest: f.digest,
      preimage_hex: preimage.toString("hex"),
      signer_seed_hex: KERNEL_KEY.seedHex,
      signer_public_key_hex: KERNEL_KEY.publicKeyHex,
      signature_hex: KERNEL_KEY.sign(preimage),
      // Negative control: the same key over the 32 raw digest bytes.
      raw32_signature_hex: KERNEL_KEY.sign(raw32),
    };
  }),
  session_delegation: SESSION_DELEGATION_FIXTURES.map((f) => {
    const preimage = sessionKeyDelegationPreimage(f.session);
    const sorted = sortedKeyDelegation(f.session);
    return {
      name: f.name,
      session: f.session,
      preimage_utf8: preimage.toString("utf8"),
      principal_seed_hex: PRINCIPAL_KEY.seedHex,
      principal_public_key_hex: PRINCIPAL_KEY.publicKeyHex,
      parent_signature_hex: PRINCIPAL_KEY.sign(preimage),
      // Negative control: the sorted-key form and a signature over it.
      sorted_key_preimage_utf8: sorted.toString("utf8"),
      sorted_key_signature_hex: PRINCIPAL_KEY.sign(sorted),
    };
  }),
  session_revocation: [
    { name: "rotated", revocation: { sessionId: "sess-001", revokedAt: 1727201000, reason: "rotated" } },
  ].map((f) => {
    const preimage = sessionRevocationPreimage(f.revocation);
    return {
      name: f.name,
      revocation: f.revocation,
      preimage_utf8: preimage.toString("utf8"),
      principal_public_key_hex: PRINCIPAL_KEY.publicKeyHex,
      parent_signature_hex: PRINCIPAL_KEY.sign(preimage),
    };
  }),
};

const outPath = join(dirname(fileURLToPath(import.meta.url)), "goldens.json");
writeFileSync(outPath, JSON.stringify(goldens, null, 2) + "\n", "utf8");
console.log("wrote " + outPath);
console.log("oracle shared vector -> " + goldens.entry_hash[0].expected);
