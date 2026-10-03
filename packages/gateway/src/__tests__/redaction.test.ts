import { generateKeyPairSync, type KeyObject } from "node:crypto";
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
});

describe("redactSecrets: private keys in the forms /api/auth/provision returns (N89)", () => {
  // Real keys, generated at test time, so no key literal sits in source. The Ed25519
  // key is drawn until its base64url form holds both - and _, so the base64url cases
  // are never accidentally plain base64.
  const pkcs8 = (k: KeyObject) => k.export({ format: "der", type: "pkcs8" }) as Buffer;
  let ed = generateKeyPairSync("ed25519");
  while (!/-/.test(pkcs8(ed.privateKey).toString("base64url")) || !/_/.test(pkcs8(ed.privateKey).toString("base64url"))) ed = generateKeyPairSync("ed25519");
  const b64 = pkcs8(ed.privateKey).toString("base64");
  const b64url = pkcs8(ed.privateKey).toString("base64url");
  const pem = ed.privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const spki = (ed.publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
  const ec = pkcs8(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey).toString("base64");
  const rsa = pkcs8(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey).toString("base64");
  const hexKey = "9f".repeat(32);
  const wrap = (v: string, n: number, sep = "\n") => v.match(new RegExp(`.{1,${n}}`, "g"))!.join(sep);
  // True when any 8-character window of the secret (stride 4) is still in the output.
  const leaks = (out: string, secret: string) => {
    for (let i = 0; i + 8 <= secret.length; i += 4) if (out.includes(secret.slice(i, i + 8))) return true;
    return false;
  };

  it("redacts a PKCS#8 key in base64 or base64url, whole, in prose, after a label or in a non-secret field", () => {
    for (const key of [b64, b64url]) {
      for (const input of [key, `provision gave me ${key} as the key`, `key=${key}`, JSON.stringify({ material: key })]) {
        const out = redactSecrets(input);
        expect(leaks(out, key)).toBe(false);
        expect(out).toContain("[redacted-private-key]");
      }
    }
    expect(redactSecrets(`provision gave me ${b64} as the key`)).toBe("provision gave me [redacted-private-key] as the key");
  });

  it("redacts a wrapped PKCS#8 key: newlines, CRLF, indentation, JSON-escaped newlines, short space groups", () => {
    for (const key of [b64, b64url]) {
      for (const input of [
        `key=${wrap(key, 32)}`,
        `key=\n${wrap(key, 16, "\r\n")}`,
        `private_key: |\n  ${wrap(key, 20, "\n  ")}\nnext: line`,
        JSON.stringify({ note: `key:\n${wrap(key, 32)}` }),
        `key ${wrap(key, 8, " ")} end`,
      ]) {
        expect(leaks(redactSecrets(input), key)).toBe(false);
      }
    }
    expect(redactSecrets(`private_key: |\n  ${wrap(b64, 20, "\n  ")}\nnext: line`)).toBe("private_key: |\n  [redacted-private-key]\nnext: line");
  });

  it("redacts long-form PKCS#8 keys (EC P-256 and RSA-2048), whole and wrapped at 64", () => {
    for (const key of [ec, rsa]) {
      expect(leaks(redactSecrets(`k=${key}`), key)).toBe(false);
      expect(leaks(redactSecrets(`k=\n${wrap(key, 64)}\nafter`), key)).toBe(false);
      expect(redactSecrets(`k=\n${wrap(key, 64)}\nafter`)).toBe("k=\n[redacted-private-key]\nafter");
    }
  });

  it("redacts a truncated PKCS#8 key, double-encoded JSON and an unterminated field", () => {
    expect(redactSecrets(`cut: ${b64.slice(0, 30)}`)).toBe("cut: [redacted-private-key]");
    const doubled = JSON.stringify({ payload: JSON.stringify({ private_key_pkcs8_base64: b64url, password: "hunter2pass" }) });
    const out = redactSecrets(doubled);
    expect(leaks(out, b64url)).toBe(false);
    expect(out).not.toContain("hunter2pass");
    expect(out).toContain('\\"password\\":\\"[redacted]\\"');
    expect(leaks(redactSecrets(`{"private_key_pkcs8_base64":"${b64url}`), b64url)).toBe(false);
    expect(redactSecrets('{"password":"hunter2pass')).toBe('{"password":"[redacted]');
  });

  it("redacts a PEM private-key block in any letter case, whole or cut off", () => {
    expect(redactSecrets(`key:\n${pem}after`)).toBe("key:\n[redacted-private-key]\nafter");
    const body = pem.split("\n").slice(1, -2).join("");
    const lower = ["-----begin ", "private key-----\n", wrap(body, 32), "\n-----end ", "private key-----"].join("");
    expect(redactSecrets(`x ${lower} y`)).toBe("x [redacted-private-key] y");
    const cut = pem.split("\n").slice(0, 2).join("\n");
    expect(redactSecrets(`x ${cut}`)).toBe("x [redacted-private-key]");
  });

  it("redacts a hex key wrapped across lines, with or without 0x, real or JSON-escaped newlines", () => {
    for (const input of [
      `private_key=0x${hexKey.slice(0, 32)}\n${hexKey.slice(32)}`,
      `k=${wrap(hexKey, 16)}`,
      JSON.stringify({ note: `k=\n${wrap(hexKey, 32)}` }),
    ]) {
      const out = redactSecrets(input);
      expect(leaks(out, hexKey)).toBe(false);
    }
    expect(redactSecrets(`private_key=0x${hexKey.slice(0, 32)}\n${hexKey.slice(32)}`)).toBe("private_key=[redacted-hex]");
    // Two 32-hex ids on one line are not joined.
    expect(redactSecrets(`a ${hexKey.slice(0, 32)} b ${hexKey.slice(32)}`)).toBe(`a ${hexKey.slice(0, 32)} b ${hexKey.slice(32)}`);
  });

  it("redacts secret-named values in JSON, YAML, quoted, unquoted and key=value forms", () => {
    const cases: Array<[string, string]> = [
      ['{"private_key":"hunter2pass"}', '{"private_key":"[redacted]"}'],
      ["private_key: hunter2pass", "private_key: [redacted]"],
      ["'password': 'hunter2pass'", "'password': '[redacted]'"],
      ["{password: 'hunter2pass'}", "{password: '[redacted]'}"],
      ["{'api_key': 'hunter2pass'}", "{'api_key': '[redacted]'}"],
      ["password=hunter2pass&next=1", "password=[redacted]&next=1"],
      ["--client-secret=abc next", "--client-secret=[redacted] next"],
      ['{"privateKey":"a b c","apiKey":"k","x-api-key":"k2","seed_phrase":"w w w","MNEMONIC":"w"}', '{"privateKey":"[redacted]","apiKey":"[redacted]","x-api-key":"[redacted]","seed_phrase":"[redacted]","MNEMONIC":"[redacted]"}'],
      ['{"password":"say \\"hi\\" twice"}', '{"password":"[redacted]"}'],
    ];
    for (const [input, expected] of cases) expect(redactSecrets(input)).toBe(expected);
  });

  it("keeps innocent names, prose, public identifiers and public keys", () => {
    for (const keep of [
      '{"seedling":"arabidopsis-123","secretary":"alice","keyboard":"us","public_key":"see-record"}',
      "the password: wrong, try again",
      "wallet So11111111111111111111111111111111111111112",
      "wallet 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 paid",
      `public key ${spki}`,
      "My Machine Model Mounts Many Motors",
      "POST /api/build/contract returned 500 with no hint",
      "/api/capabilities/templates/match?limit=10",
      "6f1c2a4e-8b7d-4c3f-9a21-0d5e6b7c8f90",
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      "ids:\na1b2c3d4e5f60718\n293a4b5c6d7e8f90", // wrapped hex under 64 digits
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0123456789",
    ]) {
      expect(redactSecrets(keep)).toBe(keep);
    }
  });

  it("still redacts a 64-hex value labeled as a transaction hash: a private key has the same shape", () => {
    expect(redactSecrets(`tx=0x${hexKey}`)).toBe("tx=[redacted-hex]");
  });

  it("leaves no key material in a whole pasted provisioning response", () => {
    const response = JSON.stringify(
      {
        api_key: "pcc_live_" + "z".repeat(24),
        ed25519: { public_key: "ab".repeat(32), private_key: hexKey, private_key_pkcs8_base64: b64 },
        operator_wallet: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", private_key: "0x" + "9".repeat(64) },
        pem,
      },
      null,
      2,
    );
    const out = redactSecrets(`here is what provision returned:\n${response}`);
    for (const secret of [b64, hexKey, "9".repeat(64), "z".repeat(24), pem.split("\n")[1]!]) expect(leaks(out, secret)).toBe(false);
    expect(out).toContain("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  it("is idempotent", () => {
    const input = `k=${wrap(b64, 32)} {"password":"x1"} private_key=0x${hexKey} ${lowerPemSample()}`;
    const once = redactSecrets(input);
    expect(redactSecrets(once)).toBe(once);
    function lowerPemSample() {
      return ["-----begin ", "private key-----\nAAAA\n-----end ", "private key-----"].join("");
    }
  });

  // ── Round 2 (pp-n89-478-redaction-r2-0548028e) ──────────────────────────────

  it("redacts a PKCS#8 key right after a / or - (round 2 C1)", () => {
    for (const input of [`POST /debug/${b64}`, `id-${b64}`, `x_${b64url}`, `a+${b64}`]) {
      expect(leaks(redactSecrets(input), input.slice(-b64.length))).toBe(false);
    }
    expect(redactSecrets(`POST /debug/${b64}`)).toBe("POST /debug/[redacted-private-key]");
  });

  it("redacts a key wrapped with deep indentation or wider inline gaps (round 2 C2a, C2d)", () => {
    const deep = `private_key_pkcs8_base64: |\n         ${wrap(b64, 8, "\n         ")}`;
    expect(leaks(redactSecrets(deep), b64)).toBe(false);
    // Under a name that isn't secret, only the PKCS#8 reader can catch it.
    expect(leaks(redactSecrets(`material: |\n         ${wrap(b64, 8, "\n         ")}`), b64)).toBe(false);
    expect(leaks(redactSecrets(`k ${wrap(b64, 8, "   ")}`), b64)).toBe(false);
    expect(leaks(redactSecrets(`k ${wrap(b64, 8, "\t\t")}`), b64)).toBe(false);
  });

  it("redacts a hex key printed in groups: spaced, a hexdump, a Buffer, 0x bytes, wrapped (round 2 C2b)", () => {
    const bytes = hexKey.match(/.{2}/g)!;
    for (const input of [
      `wallet ${hexKey.match(/.{1,8}/g)!.join(" ")}`,
      `private_key: ${hexKey.match(/.{1,8}/g)!.join(" ")}`,
      `<Buffer ${bytes.join(" ")}>`,
      `[${bytes.map((x) => "0x" + x).join(", ")}]`,
      `k:\n  ${wrap(hexKey, 16, "\n  ")}`,
    ]) {
      expect(leaks(redactSecrets(input), hexKey)).toBe(false);
    }
  });

  it("redacts a YAML key's whole value: the rest of the line, a block body, continuation lines (round 2 C2c)", () => {
    expect(redactSecrets("password: correct horse battery staple")).toBe("password: [redacted]");
    expect(redactSecrets("db:\n  password: correct horse\n  user: bob")).toBe("db:\n  password: [redacted]\n  user: bob");
    expect(redactSecrets("secret: |\n  line one\n  line two\nnext: 1")).toBe("secret: |\n  [redacted]\nnext: 1");
    expect(redactSecrets("- api_key: abc def\n- other: x")).toBe("- api_key: [redacted]\n- other: x");
    // An inline map keeps token semantics.
    expect(redactSecrets("{password: hunter2, user: bob}")).toBe("{password: [redacted], user: bob}");
  });

  it("keeps status words and decimal id lists; malformed DER is not a key (round 2 M2, M3, M4)", () => {
    for (const keep of [
      "validation returned password=required",
      "password: null,",
      "ids:\n1111111111111111\n2222222222222222\n3333333333333333\n4444444444444444",
      "latencies 120 340 560 780 120 340 560 780 120 340 560 780 120 340 560 780 120 340 560 780 120 340 560 780",
      "MAACAQAwAEFBQUFB",
    ]) {
      expect(redactSecrets(keep)).toBe(keep);
    }
    expect(redactSecrets("password=hunter")).toBe("password=[redacted]");
  });

  it("still redacts hex ids with letters on adjacent lines that reach 64 digits: a wrapped key has the same shape", () => {
    expect(redactSecrets(`ids:\n${wrap(hexKey, 16)}`)).toBe("ids:\n[redacted-hex]");
  });

  it("redacts a secret in JSON encoded four times (round 2: more than three backslashes)", () => {
    const s4 = JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify({ password: "hunter2pass" }))));
    expect(redactSecrets(s4)).not.toContain("hunter2pass");
  });

  // ── Round 3 (pp-n89-478-redaction-r3-9b14b68f) ──────────────────────────────

  it("redacts a PKCS#8 key split by any amount of whitespace (round 3 Ca, Cb)", () => {
    for (const input of [
      `material: ${b64.slice(0, 8)}         ${b64.slice(8)}`,
      `material: ${b64.slice(0, 8)}${" ".repeat(40)}${b64.slice(8)}`,
      `material: ${wrap(b64, 8, "\t\t\t")}`,
      `material:\n${b64.slice(0, 16)}\n\n\n${b64.slice(16)}`,
      JSON.stringify({ note: `k:\n${b64.slice(0, 16)}\n\n${b64.slice(16)}` }),
    ]) {
      expect(leaks(redactSecrets(input), b64)).toBe(false);
    }
    expect(redactSecrets(`private_key_pkcs8_base64: ${b64.slice(0, 16)}\n\n${b64.slice(16)}`)).toBe("private_key_pkcs8_base64: [redacted-private-key]");
  });

  it("redacts a hex key split by any run of spaces, tabs, line breaks, commas or colons (round 3 Cc)", () => {
    for (const input of [
      `material: ${hexKey.match(/.{1,8}/g)!.join("   ")}`,
      `material: ${hexKey.match(/.{2}/g)!.join(":")}`,
      `material: ${hexKey.match(/.{1,16}/g)!.join("\n\n")}`,
      `material: ${hexKey.match(/.{1,8}/g)!.join("\t")}`,
    ]) {
      expect(leaks(redactSecrets(input), hexKey)).toBe(false);
    }
  });

  it("redacts a secret label at any depth of JSON escaping (round 3 Cd)", () => {
    let s5: string = JSON.stringify({ password: "hunter2pass" });
    for (let i = 0; i < 4; i++) s5 = JSON.stringify(s5);
    expect(redactSecrets(s5)).not.toContain("hunter2pass");
  });

  it("redacts a YAML value whose marker is followed by more material", () => {
    expect(redactSecrets(`password: ${"ab".repeat(32)} hunter2`)).toBe("password: [redacted]");
    expect(redactSecrets(`private_key=[redacted-hex]tail`)).toBe("private_key=[redacted]");
  });

  it("does not treat a DER prefix without the algorithm OID and the key OCTET STRING as a key (round 3 M3)", () => {
    for (const keep of ["MAcCAQAwAAUAQUFB", "MAACAQAwAEFBQUFB"]) expect(redactSecrets(keep)).toBe(keep);
    // Each check alone: NULL where the OCTET STRING belongs, no OID tag, and an
    // OCTET STRING longer than the declared outer length.
    const der = (hex: string) => Buffer.from(hex + "41414141", "hex").toString("base64");
    for (const hex of ["300c020100300506032b65700500", "300c020100300505032b65700400", "300c020100300506032b65700405"]) {
      expect(redactSecrets(der(hex))).toBe(der(hex));
    }
    expect(redactSecrets(der("300c020100300506032b65700400"))).toMatch(/^\[redacted-private-key\]/);
  });

  it("keeps a hex word inside a longer word, and the label in front of a hex run", () => {
    expect(redactSecrets("cdefghij is a word")).toBe("cdefghij is a word");
    expect(redactSecrets(`${hexKey.match(/.{2}/g)!.join(" ")} cafeteria`)).toBe("[redacted-hex] cafeteria");
    expect(redactSecrets(`sha256: ${hexKey.match(/.{2}/g)!.join(" ")}`)).toBe("sha256: [redacted-hex]");
  });

  it("still redacts 32 bytes of hex labeled as a digest, and a line-leading 'Password:' value: both have a secret's shape", () => {
    // Kept by decision (round 3 M1, M2): a public digest's bytes and a private key's
    // bytes look the same, and a line-leading "Password:" can carry the password.
    expect(redactSecrets("sha256: 9f 86 d0 81 88 4c 7d 65 9a 2f ea a0 c5 5a d0 15 a3 bf 4f 1b 2b 0b 82 2c d1 5d 6c 15 b0 f0 0a 08")).toBe("sha256: [redacted-hex]");
    expect(redactSecrets("Password: must be at least 12 characters")).toBe("Password: [redacted]");
  });

  // ── Round 4 (pp-n89-478-redaction-r4-af5d96da) ──────────────────────────────

  it("redacts a PKCS#8 key split by any non-base64 character (round 4 C1)", () => {
    for (const sep of ["|", ",", ";", "#", "] [", ") (", " | ", " "]) {
      const input = `key=${b64.slice(0, 8)}${sep}${b64.slice(8, 30)}${sep}${b64.slice(30)}`;
      expect(leaks(redactSecrets(input), b64)).toBe(false);
    }
  });

  it("redacts a PKCS#8 key split across quoted code concatenations (round 4 C2)", () => {
    const [p1, p2, p3] = [b64.slice(0, 8), b64.slice(8, 40), b64.slice(40)];
    for (const input of [
      `key="${p1}" + "${p2}" + "${p3}"`,
      `key='${p1}' + '${p2}' + '${p3}'`,
      `key = "${p1}"\n    + "${p2}"\n    + "${p3}"`,
      `key = ("${p1}" "${p2}" "${p3}")`,
      `key := '${p1}' || '${p2}' || '${p3}'`,
      `$key = "${p1}" . "${p2}" . "${p3}";`,
    ]) {
      expect(leaks(redactSecrets(input), b64)).toBe(false);
    }
  });

  it("joins two quoted base64 runs across + only when quotes flank it (round 4 C2)", () => {
    // Both sides quoted: the key splits across the concatenation and is caught.
    const [p1, p2] = [b64.slice(0, 24), b64.slice(24)];
    expect(leaks(redactSecrets(`k = "${p1}" + "${p2}"`), b64)).toBe(false);
    // A + flanked by a quote and a plain word is ordinary prose, left intact.
    expect(redactSecrets('comment: "looks good" + ship it')).toBe('comment: "looks good" + ship it');
  });

  it("keeps a '+' that belongs to the key's own data", () => {
    let ed2 = generateKeyPairSync("ed25519");
    while (!/\+/.test(pkcs8(ed2.privateKey).toString("base64"))) ed2 = generateKeyPairSync("ed25519");
    const withPlus = pkcs8(ed2.privateKey).toString("base64");
    for (const input of [`k=${withPlus}`, `k="${withPlus}"`, `k=${wrap(withPlus, 16)}`]) {
      expect(leaks(redactSecrets(input), withPlus)).toBe(false);
    }
  });

  it("redacts a hex key split by any punctuation, or with its first group glued to a word (round 4 C3)", () => {
    const bytes = hexKey.match(/.{2}/g)!;
    for (const input of [
      `key=x${bytes[0]} ${bytes.slice(1).join(" ")}`,
      `key=${bytes.join("|")}`,
      `key="${hexKey.slice(0, 32)}" + "${hexKey.slice(32)}"`,
      `key=(${hexKey.match(/.{1,8}/g)!.join(")(")})`,
      // the first group glued to a word (as the reviewer's case): 62 digits left, still caught
      `key=x${hexKey.match(/.{2}/g)![0]} ${hexKey.match(/.{2}/g)!.slice(1).join(" ")}`,
    ]) {
      expect(leaks(redactSecrets(input), hexKey)).toBe(false);
    }
  });

  it("redacts 48+ hex digits but keeps a shorter id list (round 4 floor)", () => {
    const fifty = "9f".repeat(25); // 50 digits, with letters
    expect(redactSecrets(`v=${fifty.match(/.{1,8}/g)!.join(" ")}`)).toContain("[redacted-hex]");
    const forty = "9f".repeat(20); // 40 digits
    expect(redactSecrets(`v=${forty.match(/.{1,8}/g)!.join(" ")}`)).not.toContain("[redacted-hex]");
    expect(redactSecrets("ids 1a2b 3c4d 5e6f 7a8b")).toBe("ids 1a2b 3c4d 5e6f 7a8b");
  });

  it("rejects an OID longer than its AlgorithmIdentifier and non-minimal DER lengths (round 4 M2)", () => {
    const der = (hex: string) => Buffer.from(hex + "41414141", "hex").toString("base64");
    for (const keep of [
      "MAwCAQAwBQZ/K2VwBABBQUFB", // OID length 0x7f
      der("30810c020100300506032b65700400"), // outer length 0x0c written as 0x81 0x0c
      der("300d020100300506032b6570048100"), // OCTET length 0 written as 0x81 0x00
    ]) {
      expect(redactSecrets(keep)).toBe(keep);
    }
  });

  it("stays linear on hostile input", () => {
    const hostile = [
      '"password": "' + '\\"'.repeat(30_000),
      '\\"password\\":\\"'.repeat(4_000),
      "password=".repeat(7_000),
      '"x":"'.repeat(12_000),
      ("a.".repeat(40) + "b ").repeat(700),
      ["-----BEGIN ", "PRIVATE KEY-----"].join("").repeat(2_000),
      "M ".repeat(30_000),
      "MIIB ".repeat(12_000),
      ("0123456789abcdef".repeat(1) + "\n").repeat(3_500),
      "aB3".repeat(20_000),
      ("ab ".repeat(30) + "\n").repeat(700),
      ("M\n" + " ".repeat(200)).repeat(300),
      ("password: x\n" + "  y\n".repeat(20)).repeat(200),
      ('\\\\\\\"password\\\\\\\":\\\\\\\"').repeat(2_000),
      "Mx ".repeat(21_000),
      ("M" + " ".repeat(1_000)).repeat(60),
      ("ab" + " ".repeat(1_000) + "x").repeat(60),
      ("9f:".repeat(30) + "zz\n").repeat(600),
      "MAwCAQAwBQYDK2VwBABBQUFB".repeat(2_666),
      ('"ab" + '.repeat(8) + "x\n").repeat(800),
    ];
    for (const input of hostile) {
      const t0 = performance.now();
      redactSecrets(input.slice(0, 64_000));
      expect(performance.now() - t0).toBeLessThan(250);
    }
  });
});
