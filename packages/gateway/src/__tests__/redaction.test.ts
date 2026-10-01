import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect } from "vitest";
import { redactSecrets, redactOrNull } from "../redaction.js";

/**
 * Secret scrubbing for the public feedback sink (Phase 2). Conservative: redacts
 * clearly-secret shapes, never a public wallet address, low false-positive on prose.
 */
describe("redactSecrets", () => {
  it("redacts an Authorization bearer token", () => {
    const out = redactSecrets("got 401 with Authorization: Bearer eyabc.DEF_ghijklmnop123");
    expect(out).not.toContain("eyabc.DEF_ghijklmnop123");
    expect(out).toContain("Bearer [redacted]");
  });

  it("redacts a PCC live/test key but keeps the prefix", () => {
    expect(redactSecrets("my key is pcc_live_ABCdef0123456789")).toBe("my key is pcc_live_redacted");
    expect(redactSecrets("pcc_test_ZZZ99988877")).toBe("pcc_test_redacted");
  });

  it("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJI.eyJzdWIiOiI1NTU".concat(".QsWpV7cSignatureHere");
    expect(redactSecrets(`token=${jwt}`)).toContain("[redacted-jwt]");
    expect(redactSecrets(`token=${jwt}`)).not.toContain("eyJhbGciOiJI");
  });

  it("redacts a 64-hex private key WITH 0x/0X/no-prefix, but NOT a 40-hex address (review #2/#3)", () => {
    const pk = "0x" + "a".repeat(64);
    const upper = "0X" + "d".repeat(64); // uppercase 0X prefix (round 2 #3)
    const bare = "c".repeat(64); // private key pasted without the 0x prefix
    const addr = "0x" + "b".repeat(40);
    const out = redactSecrets(`pk=${pk} up=${upper} bare=${bare} addr=${addr}`);
    expect(out).toContain("[redacted-hex]");
    expect(out).not.toContain("a".repeat(64));
    expect(out).not.toContain("d".repeat(64)); // 0X-prefixed key caught
    expect(out).not.toContain("c".repeat(64)); // unprefixed key caught
    expect(out).toContain(addr); // public address (40 hex) must survive
  });

  it("fully redacts a PCC key containing separators (review #2)", () => {
    // the secret body may contain _ or - — must not leave a trailing fragment.
    const out = redactSecrets("key pcc_live_abc_def-ghi123456 here");
    expect(out).toBe("key pcc_live_redacted here");
  });

  it("redacts common + modern vendor key shapes incl. sk-proj- (review #2)", () => {
    expect(redactSecrets("sk-" + "a".repeat(24))).toContain("[redacted-key]");
    expect(redactSecrets("sk-proj-" + "a".repeat(24))).toContain("[redacted-key]"); // modern OpenAI
    expect(redactSecrets("sk-proj-" + "a".repeat(24))).not.toContain("aaaa");
    expect(redactSecrets("ghp_" + "b".repeat(30))).toContain("[redacted-key]");
    expect(redactSecrets("AKIAABCDEFGHIJKLMNOP")).toContain("[redacted-key]");
  });

  it("leaves ordinary prose + short hex untouched (low false-positive)", () => {
    const prose = "POST /api/build/contract returned 500; the tier field was missing at 0xdeadbeef.";
    expect(redactSecrets(prose)).toBe(prose); // 0xdeadbeef is 8 hex — not a key
  });

  it("redacts a key adjacent to underscores / word chars — not shielded by \\b (review r3 #1)", () => {
    const hex = "0x" + "f".repeat(64);
    const out = redactSecrets(`trace_${hex}_suffix`);
    expect(out).not.toContain("f".repeat(64)); // \b would have missed this; lookarounds catch it
    expect(out).toContain("[redacted-hex]");
    // pcc key embedded right after an underscore
    expect(redactSecrets("prefix_pcc_live_SECRETBODY99")).not.toContain("SECRETBODY99");
  });

  it("does NOT over-redact a key prefix embedded in an ordinary word (review r4 #1)", () => {
    // "task-scheduler-abcdefghijklmnop" contains "sk-<16+>" — must survive (the alnum
    // neighbor blocks it) while a real key with a separator neighbor is still caught.
    const innocent = "restart the task-scheduler-abcdefghijklmnop service";
    expect(redactSecrets(innocent)).toBe(innocent);
    expect(redactSecrets("key: sk-" + "a".repeat(20))).toContain("[redacted-key]");
    expect(redactSecrets("_sk-" + "a".repeat(20))).toContain("[redacted-key]"); // underscore-adjacent caught
  });

  it("is idempotent on already-redacted text", () => {
    const once = redactSecrets("pcc_live_SECRETSECRET");
    expect(redactSecrets(once)).toBe(once);
  });

  it("redactOrNull passes null through", () => {
    expect(redactOrNull(null)).toBeNull();
    expect(redactOrNull("pcc_live_XXXXXXXX")).toBe("pcc_live_redacted");
  });

  it("runs in linear time on adversarial public input (WP-D R1: the JWT regex was quadratic)", () => {
    // /api/feedback is public and bounds each field to 64,000 chars before redaction;
    // the old JWT regex spent ~1 s on one such field of '-eyJ'. 200 KB here.
    redactSecrets("warm up eyJhbGciOiJI.eyJzdWIiOiI1NTU.QsWpV7cSignatureHere");
    for (const unit of ["-eyJ", "-eyJaaaaaa.", "_eyJabcdef.ghijkl.", "-sk-", "Bearer ", "a".repeat(63) + "g"]) {
      const input = unit.repeat(Math.ceil((200 * 1024) / unit.length));
      const t0 = performance.now();
      redactSecrets(input);
      const ms = performance.now() - t0;
      expect(ms, `${JSON.stringify(unit)}: ${ms.toFixed(1)} ms`).toBeLessThan(100);
    }
  });

  it("still redacts a JWT after '-' or '_' exactly as the regex did", () => {
    const jwt = "eyJhbGciOiJI.eyJzdWIiOiI1NTU.QsWpV7cSignatureHere";
    expect(redactSecrets(`x-${jwt} y_${jwt}`)).toBe("x-[redacted-jwt] y_[redacted-jwt]");
    expect(redactSecrets(`x${jwt}`)).toBe(`x${jwt}`); // an alphanumeric neighbour still shields it
  });
});

describe("redactSecrets: private keys in the forms /api/auth/provision returns (N89)", () => {
  // A real Ed25519 key, generated at test time, so no key literal sits in source.
  const { privateKey } = generateKeyPairSync("ed25519");
  const b64 = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const pemBody = pem.split("\n")[1]!;

  it("redacts a base64 PKCS#8 key pasted into free text", () => {
    const out = redactSecrets(`provision gave me ${b64} as the key`);
    expect(out).not.toContain(b64);
    expect(out).toBe("provision gave me [redacted-b64] as the key");
  });

  it("redacts the values of secret-named JSON fields, in any case, and keeps the rest", () => {
    const out = redactSecrets(
      JSON.stringify({
        kernel_id: "k1",
        private_key_pkcs8_base64: b64,
        privateKey: "hunter2hunter2",
        client_secret: "s3cr3t value",
        "x-api-key": "k",
        apiKey: "k2",
        password: 'hun"ter22',
        mnemonic: "word word word",
        public_key: "see-the-kernel-record",
        note: "keep me",
      }),
    );
    for (const name of ["private_key_pkcs8_base64", "privateKey", "client_secret", "x-api-key", "apiKey", "password", "mnemonic"]) {
      expect(out).toContain(`"${name}":"[redacted]"`);
    }
    expect(out).not.toContain(b64);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("ter22");
    expect(out).toContain('"kernel_id":"k1"');
    expect(out).toContain('"public_key":"see-the-kernel-record"');
    expect(out).toContain('"note":"keep me"');
  });

  it("redacts a PEM private-key block, whole or cut off", () => {
    expect(redactSecrets(`key:\n${pem}after`)).toBe("key:\n[redacted-private-key]\nafter");
    const cut = pem.split("\n").slice(0, 2).join("\n");
    expect(redactSecrets(`x ${cut}`)).toBe("x [redacted-private-key]");
  });

  it("leaves no key material in a whole pasted provisioning response", () => {
    const response = JSON.stringify(
      {
        api_key: "pcc_live_" + "z".repeat(24),
        ed25519: { private_key_pkcs8_base64: b64, private_key_pem: pem },
        operator_wallet: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", private_key: "0x" + "9".repeat(64) },
      },
      null,
      2,
    );
    const out = redactSecrets(`here is what provision returned:\n${response}`);
    expect(out).not.toContain(b64);
    expect(out).not.toContain(pemBody);
    expect(out).not.toContain("z".repeat(24));
    expect(out).not.toContain("9".repeat(64));
    expect(out).toContain("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  it("keeps prose, paths, UUIDs, hex ids, checksummed addresses and single-case runs", () => {
    for (const keep of [
      "POST /api/build/contract returned 500 with no hint",
      "/api/capabilities/templates/match?limit=10",
      "6f1c2a4e-8b7d-4c3f-9a21-0d5e6b7c8f90",
      "tr_" + "0123456789abcdef".repeat(2),
      "wallet 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 paid",
      "a".repeat(60),
      "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOP",
      "z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2h1g0", // lower case and digits only
      "ZYXWVUTSRQPONMLKJIHG0123456789ZYXWVUTSRQ", // upper case and digits only
      'the reply was {"status": "failed", "reason": "no device"}',
    ]) {
      expect(redactSecrets(keep)).toBe(keep);
    }
  });

  it("stays linear on hostile input", () => {
    const hostile = [
      '"password": "' + '\\"'.repeat(30_000),
      ('"' + "p".repeat(63) + '"' + " ".repeat(8)).repeat(900),
      '"x":"'.repeat(12_000),
      ["-----BEGIN ", "PRIVATE KEY-----"].join("").repeat(2_000),
      "aB3".repeat(20_000),
    ];
    for (const input of hostile) {
      const t0 = performance.now();
      redactSecrets(input.slice(0, 64_000));
      expect(performance.now() - t0).toBeLessThan(250);
    }
  });
});
