/**
 * N1 (Gate A): custodial key sealing. Unit tests for custody-seal.ts.
 *
 * Every key, address and KEK here is random bytes generated in the test. The
 * blob format and the AAD are pinned by an INDEPENDENT node:crypto sealer and
 * unsealer below, so these tests do not just prove the module agrees with
 * itself.
 */

import { describe, it, expect } from "vitest";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { inspect } from "node:util";
import {
  CUSTODY_KEK_ENV,
  CUSTODY_KEK_ID_ENV,
  CustodyKek,
  CustodySealError,
  CustodyKekUnavailableError,
  CustodyKekIdMismatchError,
  CustodyBlobMalformedError,
  CustodyUnsealError,
  CustodyInputError,
  resolveCustodyKek,
  requireCustodyKek,
  sealCustodialKey,
  unsealCustodialKey,
} from "../custody-seal.js";

const randKeyHex = () => `0x${randomBytes(32).toString("hex")}`;
const randAddress = () => `0x${randomBytes(20).toString("hex")}`;
const kekEnv = (bytes: Buffer, id = "k1") => ({
  [CUSTODY_KEK_ENV]: bytes.toString("base64"),
  [CUSTODY_KEK_ID_ENV]: id,
});

/** AES-256-GCM sealer written straight from the spec, not from custody-seal.ts. */
function independentSeal(
  keyHex: string,
  kek: Buffer,
  kekId: string,
  rowId: string,
  address: string,
): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kek, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(`api_keys:${rowId}:${address.toLowerCase()}`, "utf8"));
  const ct = Buffer.concat([c.update(keyHex, "utf8"), c.final()]);
  return [
    "pcc-seal",
    "v1",
    kekId,
    iv.toString("base64url"),
    c.getAuthTag().toString("base64url"),
    ct.toString("base64url"),
  ].join(":");
}

/** The matching independent unsealer. */
function independentUnseal(blob: string, kek: Buffer, rowId: string, address: string): string {
  const [prefix, version, , iv, tag, ct] = blob.split(":");
  expect(prefix).toBe("pcc-seal");
  expect(version).toBe("v1");
  const d = createDecipheriv("aes-256-gcm", kek, Buffer.from(iv, "base64url"), { authTagLength: 16 });
  d.setAAD(Buffer.from(`api_keys:${rowId}:${address.toLowerCase()}`, "utf8"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

/** Flip one bit of the base64url part at index `part` (3 iv, 4 tag, 5 ciphertext). */
function tamper(blob: string, part: number, byteIndex = 0): string {
  const parts = blob.split(":");
  const bytes = Buffer.from(parts[part], "base64url");
  bytes[byteIndex] ^= 0x01;
  parts[part] = bytes.toString("base64url");
  return parts.join(":");
}

describe("N1 custody seal: KEK resolution", () => {
  it("accepts a standard-base64 32-byte KEK with an id, re-reading the env on every call", () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    const r1 = resolveCustodyKek(kekEnv(a, "k1"));
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.kek.id).toBe("k1");
    const r2 = resolveCustodyKek(kekEnv(b, "k2"));
    expect(r2.ok && r2.kek.id).toBe("k2");
    // The process env is the default source and is not frozen at import time.
    const saved = { ...process.env };
    try {
      process.env[CUSTODY_KEK_ENV] = a.toString("base64");
      process.env[CUSTODY_KEK_ID_ENV] = "from-env";
      expect(requireCustodyKek().id).toBe("from-env");
      process.env[CUSTODY_KEK_ID_ENV] = "changed";
      expect(requireCustodyKek().id).toBe("changed");
      delete process.env[CUSTODY_KEK_ENV];
      expect(() => requireCustodyKek()).toThrow(CustodyKekUnavailableError);
    } finally {
      for (const k of [CUSTODY_KEK_ENV, CUSTODY_KEK_ID_ENV]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it("trims surrounding whitespace on the KEK and the id", () => {
    const k = randomBytes(32);
    const r = resolveCustodyKek({
      [CUSTODY_KEK_ENV]: `  ${k.toString("base64")}\n`,
      [CUSTODY_KEK_ID_ENV]: " k1 ",
    });
    expect(r.ok && r.kek.id).toBe("k1");
  });

  const good = randomBytes(32).toString("base64");
  // base64 of 32 bytes ends "...=" with the last data char carrying only 4 bits:
  // 'B' has a non-zero low bit pair where a canonical encoding must have zeros.
  const nonCanonical = `${good.slice(0, 42)}${good[42] === "B" ? "C" : "B"}=`;
  const secretish = "S3CRET-LOOKING-VALUE-that-is-not-a-kek";
  const invalid: Array<[string, Record<string, string | undefined>]> = [
    ["KEK unset", { [CUSTODY_KEK_ID_ENV]: "k1" }],
    ["KEK blank", { [CUSTODY_KEK_ENV]: "", [CUSTODY_KEK_ID_ENV]: "k1" }],
    ["KEK whitespace only", { [CUSTODY_KEK_ENV]: "   \n", [CUSTODY_KEK_ID_ENV]: "k1" }],
    ["KEK 31 bytes", { [CUSTODY_KEK_ENV]: randomBytes(31).toString("base64"), [CUSTODY_KEK_ID_ENV]: "k1" }],
    ["KEK 33 bytes", { [CUSTODY_KEK_ENV]: randomBytes(33).toString("base64"), [CUSTODY_KEK_ID_ENV]: "k1" }],
    ["KEK 16 bytes", { [CUSTODY_KEK_ENV]: randomBytes(16).toString("base64"), [CUSTODY_KEK_ID_ENV]: "k1" }],
    ["KEK 64 bytes", { [CUSTODY_KEK_ENV]: randomBytes(64).toString("base64"), [CUSTODY_KEK_ID_ENV]: "k1" }],
    ["KEK 32 bytes as hex", { [CUSTODY_KEK_ENV]: randomBytes(32).toString("hex"), [CUSTODY_KEK_ID_ENV]: "k1" }],
    ["KEK unpadded base64", { [CUSTODY_KEK_ENV]: good.replace(/=+$/, ""), [CUSTODY_KEK_ID_ENV]: "k1" }],
    ["KEK base64url alphabet", { [CUSTODY_KEK_ENV]: `${good.slice(0, 10)}-_${good.slice(12)}`, [CUSTODY_KEK_ID_ENV]: "k1" }],
    ["KEK not base64 at all", { [CUSTODY_KEK_ENV]: secretish, [CUSTODY_KEK_ID_ENV]: "k1" }],
    ["KEK right length, bad chars", { [CUSTODY_KEK_ENV]: `${"!".repeat(43)}=`, [CUSTODY_KEK_ID_ENV]: "k1" }],
    ["KEK non-canonical trailing bits", { [CUSTODY_KEK_ENV]: nonCanonical, [CUSTODY_KEK_ID_ENV]: "k1" }],
    ["id unset", { [CUSTODY_KEK_ENV]: good }],
    ["id blank", { [CUSTODY_KEK_ENV]: good, [CUSTODY_KEK_ID_ENV]: "  " }],
    ["id with a colon", { [CUSTODY_KEK_ENV]: good, [CUSTODY_KEK_ID_ENV]: "k:1" }],
    ["id with a space", { [CUSTODY_KEK_ENV]: good, [CUSTODY_KEK_ID_ENV]: "k 1" }],
    ["id 33 chars", { [CUSTODY_KEK_ENV]: good, [CUSTODY_KEK_ID_ENV]: "k".repeat(33) }],
    ["id non-ascii", { [CUSTODY_KEK_ENV]: good, [CUSTODY_KEK_ID_ENV]: "ké1" }],
    ["both unset", {}],
  ];

  it.each(invalid)("[neg] %s counts as ABSENT, with a static problem and no value echoed", (_n, env) => {
    const r = resolveCustodyKek(env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.length).toBeGreaterThan(0);
    const text = JSON.stringify(r);
    for (const v of Object.values(env)) {
      if (v && v.trim().length >= 4) expect(text).not.toContain(v.trim());
    }
    expect(() => requireCustodyKek(env)).toThrow(CustodyKekUnavailableError);
    try {
      requireCustodyKek(env);
    } catch (e) {
      expect(e).toBeInstanceOf(CustodySealError);
      expect((e as CustodySealError).code).toBe("KEK_UNAVAILABLE");
      expect((e as CustodyKekUnavailableError).problems).toEqual(r.problems);
      for (const v of Object.values(env)) {
        if (v && v.trim().length >= 4) expect(String((e as Error).message)).not.toContain(v.trim());
      }
    }
  });

  it("names the env var that is wrong, per variable", () => {
    const noKek = resolveCustodyKek({ [CUSTODY_KEK_ID_ENV]: "k1" });
    expect(!noKek.ok && noKek.problems.join(" ")).toContain(CUSTODY_KEK_ENV);
    const noId = resolveCustodyKek({ [CUSTODY_KEK_ENV]: good });
    expect(!noId.ok && noId.problems.join(" ")).toContain(CUSTODY_KEK_ID_ENV);
  });

  it("a CustodyKek holds nothing but its id, and never exposes its bytes to JSON, inspect or String()", () => {
    const bytes = randomBytes(32);
    const kek = new CustodyKek("k1", bytes);
    // Nothing but the id lives on the instance: no key, no Buffer, no symbol-keyed slot.
    expect(Object.getOwnPropertyNames(kek)).toEqual(["id"]);
    expect(Object.getOwnPropertySymbols(kek)).toEqual([]);
    const shown = [
      JSON.stringify(kek),
      inspect(kek, { showHidden: true, depth: 5 }),
      String(kek),
      `${kek}`,
      JSON.stringify({ kek }),
    ].join("\n");
    // Every common rendering of the key: encodings, a JSON-serialised Buffer (decimal array)
    // and util.inspect's "<Buffer 01 02 ...>" (space-separated hex).
    const head = [...bytes.subarray(0, 8)];
    const renderings = [
      bytes.toString("base64"),
      bytes.toString("hex"),
      bytes.toString("base64url"),
      head.join(","),
      head.map((b) => b.toString(16).padStart(2, "0")).join(" "),
    ];
    for (const r of renderings) expect(shown).not.toContain(r);
    expect(shown).toContain("k1");
  });

  it("[neg] CustodyKek refuses a wrong-length key or a bad id", () => {
    expect(() => new CustodyKek("k1", randomBytes(31))).toThrow(CustodyInputError);
    expect(() => new CustodyKek("k1", randomBytes(33))).toThrow(CustodyInputError);
    expect(() => new CustodyKek("k:1", randomBytes(32))).toThrow(CustodyInputError);
    expect(() => new CustodyKek("", randomBytes(32))).toThrow(CustodyInputError);
  });
});

describe("N1 custody seal: seal and unseal", () => {
  const kekBytes = randomBytes(32);
  const kek = new CustodyKek("k1", kekBytes);
  const rowId = `row-${randomBytes(6).toString("hex")}`;
  const address = randAddress();
  const ctx = { rowId, address };

  it("round-trips the exact key string (0x-prefixed and bare)", () => {
    const withPrefix = randKeyHex();
    const bare = randomBytes(32).toString("hex");
    expect(unsealCustodialKey(sealCustodialKey(withPrefix, ctx, kek), ctx, kek)).toBe(withPrefix);
    expect(unsealCustodialKey(sealCustodialKey(bare, ctx, kek), ctx, kek)).toBe(bare);
    // Mixed-case hex keeps its exact casing: the plaintext is not normalised.
    const mixed = `0x${randomBytes(32).toString("hex").toUpperCase()}`;
    expect(unsealCustodialKey(sealCustodialKey(mixed, ctx, kek), ctx, kek)).toBe(mixed);
  });

  it("produces pcc-seal:v1:<kekId>:<iv>:<tag>:<ct>, every part base64url, with the right sizes", () => {
    const key = randKeyHex();
    const blob = sealCustodialKey(key, ctx, kek);
    const parts = blob.split(":");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("pcc-seal");
    expect(parts[1]).toBe("v1");
    expect(parts[2]).toBe("k1");
    for (const p of parts.slice(3)) expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(parts[3], "base64url")).toHaveLength(12); // 96-bit IV
    expect(Buffer.from(parts[4], "base64url")).toHaveLength(16); // GCM tag
    expect(Buffer.from(parts[5], "base64url")).toHaveLength(66); // "0x" + 64 hex chars
    // Nothing of the key survives in the clear.
    const bareKey = key.slice(2).toLowerCase();
    expect(blob.toLowerCase()).not.toContain(bareKey);
    expect(Buffer.from(parts[5], "base64url").toString("utf8")).not.toBe(key);
  });

  it("names the KEK that sealed it: the blob carries that KEK's id, whatever it is", () => {
    const key = randKeyHex();
    for (const id of ["k1", "rot_2-A", "x", "k".repeat(32)]) {
      const other = new CustodyKek(id, randomBytes(32));
      const blob = sealCustodialKey(key, ctx, other);
      expect(blob.split(":")[2]).toBe(id);
      expect(unsealCustodialKey(blob, ctx, other)).toBe(key);
    }
  });

  it("matches the spec independently: AAD is api_keys:<rowId>:<lowercased address>", () => {
    const key = randKeyHex();
    const mixedAddress = `0x${randomBytes(20).toString("hex").toUpperCase()}`;
    const c = { rowId, address: mixedAddress };
    const blob = sealCustodialKey(key, c, kek);
    // An independent decrypt with that exact AAD recovers the key...
    expect(independentUnseal(blob, kekBytes, rowId, mixedAddress.toLowerCase())).toBe(key);
    // ...and a blob made by the independent sealer is accepted by unseal.
    const foreign = independentSeal(key, kekBytes, "k1", rowId, mixedAddress);
    expect(unsealCustodialKey(foreign, c, kek)).toBe(key);
    // A different AAD shape does NOT authenticate (the AAD really is in play).
    const wrongShape = createDecipheriv(
      "aes-256-gcm",
      kekBytes,
      Buffer.from(blob.split(":")[3], "base64url"),
      { authTagLength: 16 },
    );
    wrongShape.setAAD(Buffer.from(`${rowId}:${mixedAddress.toLowerCase()}`, "utf8"));
    wrongShape.setAuthTag(Buffer.from(blob.split(":")[4], "base64url"));
    expect(() => {
      wrongShape.update(Buffer.from(blob.split(":")[5], "base64url"));
      wrongShape.final();
    }).toThrow();
  });

  it("treats the address case-insensitively (lowercased into the AAD)", () => {
    const key = randKeyHex();
    const blob = sealCustodialKey(key, { rowId, address: address.toLowerCase() }, kek);
    const upper = `0x${address.slice(2).toUpperCase()}`;
    expect(unsealCustodialKey(blob, { rowId, address: upper }, kek)).toBe(key);
  });

  it("uses a fresh random 96-bit IV every time", () => {
    const key = randKeyHex();
    const ivs = new Set<string>();
    const cts = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const p = sealCustodialKey(key, ctx, kek).split(":");
      ivs.add(p[3]);
      cts.add(p[5]);
    }
    expect(ivs.size).toBe(64);
    expect(cts.size).toBe(64);
  });

  it("works for row ids that contain colons (the address cannot, so the AAD is unambiguous)", () => {
    const key = randKeyHex();
    const odd = { rowId: "a:b:c", address };
    expect(unsealCustodialKey(sealCustodialKey(key, odd, kek), odd, kek)).toBe(key);
  });

  // ── refusals ───────────────────────────────────────────────────────
  it("[neg] a wrong KEK (same id, other bytes) is refused with CustodyUnsealError", () => {
    const blob = sealCustodialKey(randKeyHex(), ctx, kek);
    const other = new CustodyKek("k1", randomBytes(32));
    expect(() => unsealCustodialKey(blob, ctx, other)).toThrow(CustodyUnsealError);
  });

  it("[neg] a wrong kekId is refused with CustodyKekIdMismatchError, even with the SAME key bytes", () => {
    const blob = sealCustodialKey(randKeyHex(), ctx, kek);
    const sameBytesOtherId = new CustodyKek("k2", kekBytes);
    let caught: unknown;
    try {
      unsealCustodialKey(blob, ctx, sameBytesOtherId);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CustodyKekIdMismatchError);
    expect((caught as CustodyKekIdMismatchError).code).toBe("KEK_ID_MISMATCH");
    expect((caught as CustodyKekIdMismatchError).blobKekId).toBe("k1");
    expect((caught as CustodyKekIdMismatchError).configuredKekId).toBe("k2");
  });

  it("[neg] a blob moved to another row is refused", () => {
    const blob = sealCustodialKey(randKeyHex(), ctx, kek);
    expect(() => unsealCustodialKey(blob, { rowId: `${rowId}x`, address }, kek)).toThrow(CustodyUnsealError);
    expect(() => unsealCustodialKey(blob, { rowId: "other", address }, kek)).toThrow(CustodyUnsealError);
  });

  it("[neg] a blob paired with another address is refused", () => {
    const blob = sealCustodialKey(randKeyHex(), ctx, kek);
    expect(() => unsealCustodialKey(blob, { rowId, address: randAddress() }, kek)).toThrow(CustodyUnsealError);
    // One hex digit different is enough.
    const flipped = `${address.slice(0, -1)}${address.endsWith("0") ? "1" : "0"}`;
    expect(() => unsealCustodialKey(blob, { rowId, address: flipped }, kek)).toThrow(CustodyUnsealError);
  });

  it.each([
    ["iv", 3, 0],
    ["iv (last byte)", 3, 11],
    ["tag", 4, 0],
    ["tag (last byte)", 4, 15],
    ["ciphertext (first byte)", 5, 0],
    ["ciphertext (middle)", 5, 33],
    ["ciphertext (last byte)", 5, 65],
  ])("[neg] a tampered %s is refused", (_n, part, idx) => {
    const blob = sealCustodialKey(randKeyHex(), ctx, kek);
    expect(() => unsealCustodialKey(tamper(blob, part, idx), ctx, kek)).toThrow(CustodyUnsealError);
  });

  it("[neg] parts swapped in from another blob are refused", () => {
    const a = sealCustodialKey(randKeyHex(), ctx, kek).split(":");
    const b = sealCustodialKey(randKeyHex(), ctx, kek).split(":");
    for (const part of [3, 4, 5]) {
      const mixed = [...a];
      mixed[part] = b[part];
      expect(() => unsealCustodialKey(mixed.join(":"), ctx, kek)).toThrow(CustodyUnsealError);
    }
  });

  const good = sealCustodialKey(randKeyHex(), ctx, kek);
  const gp = good.split(":");
  // A 16-byte tag is 22 base64url chars carrying 132 bits: the last char holds 2
  // data bits and 4 that must be zero. Bumping it to the next alphabet char sets
  // stray bits yet decodes (leniently) to the SAME 16 bytes.
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const tagLast = gp[4][gp[4].length - 1];
  const nonCanonicalTag = `${gp[4].slice(0, -1)}${ALPHABET[ALPHABET.indexOf(tagLast) + 1]}`;
  const malformed: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { blob: good }],
    ["empty", ""],
    ["plaintext key", randKeyHex()],
    ["wrong prefix", good.replace(/^pcc-seal/, "pcc-sealed")],
    ["unsupported version", good.replace(":v1:", ":v2:")],
    ["5 parts", gp.slice(0, 5).join(":")],
    ["7 parts", `${good}:extra`],
    ["empty kek id", [gp[0], gp[1], "", gp[3], gp[4], gp[5]].join(":")],
    ["kek id with a space", [gp[0], gp[1], "k 1", gp[3], gp[4], gp[5]].join(":")],
    ["iv not base64url", [gp[0], gp[1], gp[2], "!!!!!!!!!!!!!!!!", gp[4], gp[5]].join(":")],
    ["iv padded", [gp[0], gp[1], gp[2], `${gp[3]}=`, gp[4], gp[5]].join(":")],
    ["iv 11 bytes", [gp[0], gp[1], gp[2], randomBytes(11).toString("base64url"), gp[4], gp[5]].join(":")],
    ["iv 13 bytes", [gp[0], gp[1], gp[2], randomBytes(13).toString("base64url"), gp[4], gp[5]].join(":")],
    ["tag 15 bytes", [gp[0], gp[1], gp[2], gp[3], randomBytes(15).toString("base64url"), gp[5]].join(":")],
    ["tag 17 bytes", [gp[0], gp[1], gp[2], gp[3], randomBytes(17).toString("base64url"), gp[5]].join(":")],
    ["tag empty", [gp[0], gp[1], gp[2], gp[3], "", gp[5]].join(":")],
    ["ciphertext empty", [gp[0], gp[1], gp[2], gp[3], gp[4], ""].join(":")],
    ["ciphertext not base64url", [gp[0], gp[1], gp[2], gp[3], gp[4], "not base64url!"].join(":")],
    ["ciphertext standard-base64 chars", [gp[0], gp[1], gp[2], gp[3], gp[4], "ab+/ab+/"].join(":")],
    ["ciphertext too big", [gp[0], gp[1], gp[2], gp[3], gp[4], randomBytes(300).toString("base64url")].join(":")],
    ["blob far too long", `${good}${"A".repeat(2000)}`],
    ["non-canonical base64url tag (same bytes, stray trailing bits)", [gp[0], gp[1], gp[2], gp[3], nonCanonicalTag, gp[5]].join(":")],
  ];

  it.each(malformed)("[neg] a malformed blob (%s) is refused with CustodyBlobMalformedError", (_n, value) => {
    let caught: unknown;
    try {
      unsealCustodialKey(value as string, ctx, kek);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CustodyBlobMalformedError);
    expect((caught as CustodyBlobMalformedError).code).toBe("BLOB_MALFORMED");
    expect(typeof (caught as CustodyBlobMalformedError).reason).toBe("string");
    // The refusal never repeats the blob back.
    if (typeof value === "string" && value.length > 20) {
      expect(String((caught as Error).message)).not.toContain(value.slice(0, 20));
    }
  });

  it("control: the non-canonical tag above decodes LENIENTLY to the same bytes (so only strictness refuses it)", () => {
    expect(nonCanonicalTag).not.toBe(gp[4]);
    expect(Buffer.from(nonCanonicalTag, "base64url").equals(Buffer.from(gp[4], "base64url"))).toBe(true);
    // The untouched blob still unseals; only the textual form differs.
    expect(unsealCustodialKey(good, ctx, kek)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("every refusal is a CustodySealError carrying its own code", () => {
    const blob = sealCustodialKey(randKeyHex(), ctx, kek);
    const cases: Array<[() => unknown, string]> = [
      [() => unsealCustodialKey(blob, { rowId: "x", address }, kek), "UNSEAL_FAILED"],
      [() => unsealCustodialKey(blob, ctx, new CustodyKek("zz", kekBytes)), "KEK_ID_MISMATCH"],
      [() => unsealCustodialKey("nonsense", ctx, kek), "BLOB_MALFORMED"],
      [() => sealCustodialKey("not a key", ctx, kek), "INVALID_INPUT"],
      [() => unsealCustodialKey(blob, ctx, requireCustodyKek({})), "KEK_UNAVAILABLE"],
    ];
    for (const [fn, code] of cases) {
      let caught: unknown;
      try {
        fn();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CustodySealError);
      expect((caught as CustodySealError).code).toBe(code);
    }
  });

  it("[neg] seal refuses an unusable key, row id or address (CustodyInputError)", () => {
    const badKeys = [
      "",
      "0x",
      "0x1234",
      randomBytes(31).toString("hex"),
      `${randomBytes(32).toString("hex")}00`,
      `0x${"zz".repeat(32)}`,
      `0x${randomBytes(32).toString("hex")}\n`,
      undefined,
      null,
      123,
    ];
    for (const k of badKeys) {
      expect(() => sealCustodialKey(k as unknown as string, ctx, kek)).toThrow(CustodyInputError);
    }
    for (const bad of [
      { rowId: "", address },
      { rowId, address: "" },
      { rowId, address: "0x123" },
      { rowId, address: randomBytes(20).toString("hex") }, // no 0x
      { rowId, address: `${address}00` },
      { rowId, address: "0x" + "g".repeat(40) },
      { rowId: undefined as unknown as string, address },
    ]) {
      expect(() => sealCustodialKey(randKeyHex(), bad, kek)).toThrow(CustodyInputError);
      expect(() => unsealCustodialKey(good, bad, kek)).toThrow(CustodyInputError);
    }
  });

  it("with no KEK configured, sealing refuses and produces nothing (fail closed)", () => {
    const saved = { k: process.env[CUSTODY_KEK_ENV], i: process.env[CUSTODY_KEK_ID_ENV] };
    delete process.env[CUSTODY_KEK_ENV];
    delete process.env[CUSTODY_KEK_ID_ENV];
    try {
      expect(() => sealCustodialKey(randKeyHex(), ctx)).toThrow(CustodyKekUnavailableError);
      expect(() => unsealCustodialKey(good, ctx)).toThrow(CustodyKekUnavailableError);
    } finally {
      if (saved.k !== undefined) process.env[CUSTODY_KEK_ENV] = saved.k;
      if (saved.i !== undefined) process.env[CUSTODY_KEK_ID_ENV] = saved.i;
    }
  });

  it("no refusal ever carries the key, the KEK, or the plaintext in its message or fields", () => {
    const key = randKeyHex();
    const blob = sealCustodialKey(key, ctx, kek);
    const secrets = [
      key,
      key.slice(2),
      kekBytes.toString("base64"),
      kekBytes.toString("hex"),
      kekBytes.toString("base64url"),
    ];
    const attempts: Array<() => unknown> = [
      () => unsealCustodialKey(blob, { rowId: "x", address }, kek),
      () => unsealCustodialKey(tamper(blob, 5), ctx, kek),
      () => unsealCustodialKey(blob, ctx, new CustodyKek("k1", randomBytes(32))),
      () => unsealCustodialKey(blob, ctx, new CustodyKek("other", kekBytes)),
      () => unsealCustodialKey(key, ctx, kek),
      () => sealCustodialKey(`${key}zz`, ctx, kek),
      () => requireCustodyKek({ [CUSTODY_KEK_ENV]: kekBytes.toString("base64").slice(0, -4), [CUSTODY_KEK_ID_ENV]: "k1" }),
    ];
    for (const attempt of attempts) {
      let caught: unknown;
      try {
        attempt();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CustodySealError);
      const everything = [
        (caught as Error).message,
        (caught as Error).stack ?? "",
        JSON.stringify(caught, Object.getOwnPropertyNames(caught as object)),
        inspect(caught, { depth: 6 }),
      ].join("\n");
      for (const s of secrets) expect(everything).not.toContain(s);
    }
  });
});
