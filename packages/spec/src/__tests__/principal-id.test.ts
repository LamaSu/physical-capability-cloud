import { createHash } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3";
import { describe, it, expect } from "vitest";
import { ID_PATTERN } from "../csd/composition-commitment.js";
import vectors from "../evidence/principal-id.vectors.json" with { type: "json" };
import {
  COMPROMISED_DEVICE_PUBLIC_KEYS,
  DEVICE_PRINCIPAL_ID_PATTERN,
  KERNEL_ID_PATTERN,
  OPERATOR_PRINCIPAL_ID_PATTERN,
  PRINCIPAL_ID_CONTRACT,
  PrincipalIdError,
  RESERVED_KERNEL_ID_PREFIXES,
  devicePrincipalMatchesSigner,
  formatDevicePrincipalId,
  formatOperatorPrincipalId,
  isCompromisedDevicePublicKey,
  isValidKernelId,
  operatorPrincipalMatchesSigner,
  parseDevicePrincipalId,
  parseOperatorPrincipalId,
  principalFromRegistry,
  principalTupleWord,
  authorizedTuple,
} from "../evidence/principal-id.js";

const ADDR_MIXED = "0x52908400098527886E0F7030069857D2E4169EE7"; // an EIP-55 checksummed address
const ADDR = ADDR_MIXED.toLowerCase();
const KEY = "0x" + "7a".repeat(32);
const LEAKED = [...COMPROMISED_DEVICE_PUBLIC_KEYS][0]!;

describe("principal ids — the pinned forms", () => {
  it("names its contract", () => {
    expect(PRINCIPAL_ID_CONTRACT).toBe("pcc.evidence.principal-id.v1");
  });

  it("formats lowercase CAIP-10 operators and ed25519 devices", () => {
    expect(formatOperatorPrincipalId(84532, ADDR_MIXED)).toBe(`eip155:84532:${ADDR}`);
    expect(formatDevicePrincipalId(KEY.toUpperCase().replace("0X", "0x"))).toBe(`ed25519:${KEY}`);
    expect(formatDevicePrincipalId(KEY.slice(2))).toBe(`ed25519:${KEY}`);
  });

  it("parses only the exact pinned forms", () => {
    expect(parseOperatorPrincipalId(`eip155:84532:${ADDR}`)).toEqual({ chainId: 84532, address: ADDR });
    expect(parseDevicePrincipalId(`ed25519:${KEY}`)).toEqual({ publicKey: KEY });
    for (const bad of [
      `eip155:84532:${ADDR_MIXED}`, // checksum case drifts the digest
      `eip155:084532:${ADDR}`,
      `eip155:0:${ADDR}`,
      `eip155:84532:${ADDR.slice(2)}`,
      `EIP155:84532:${ADDR}`,
      ` eip155:84532:${ADDR}`,
      `eip155:84532:${ADDR}\n`,
    ]) {
      expect(parseOperatorPrincipalId(bad), bad).toBeNull();
    }
    for (const bad of [`ed25519:${KEY.toUpperCase().replace("0X", "0x")}`, `ed25519:${KEY.slice(2)}`, `ed25519:${KEY}00`, `ED25519:${KEY}`]) {
      expect(parseDevicePrincipalId(bad), bad).toBeNull();
    }
  });

  it("refuses malformed inputs when formatting", () => {
    expect(() => formatOperatorPrincipalId(0, ADDR)).toThrow(PrincipalIdError);
    expect(() => formatOperatorPrincipalId(1.5, ADDR)).toThrow(PrincipalIdError);
    expect(() => formatOperatorPrincipalId(1, ADDR.slice(0, -1))).toThrow(PrincipalIdError);
    expect(() => formatDevicePrincipalId(KEY + "0")).toThrow(PrincipalIdError);
  });
});

describe("principal ids — bound to the signatures the verifier checks", () => {
  it("D1: the operator's address is the D1 signer, in any signer case, on the unit's chain", () => {
    const id = formatOperatorPrincipalId(84532, ADDR_MIXED);
    expect(operatorPrincipalMatchesSigner(id, ADDR_MIXED)).toBe(true);
    expect(operatorPrincipalMatchesSigner(id, ADDR, 84532)).toBe(true);
    expect(operatorPrincipalMatchesSigner(id, ADDR, 1)).toBe(false);
    expect(operatorPrincipalMatchesSigner(id, "0x" + "11".repeat(20))).toBe(false);
    expect(operatorPrincipalMatchesSigner(`eip155:84532:${ADDR_MIXED}`, ADDR_MIXED)).toBe(false);
  });

  it("D2: the device's key is the D2 signer, in any signer case", () => {
    const id = formatDevicePrincipalId(KEY);
    expect(devicePrincipalMatchesSigner(id, KEY)).toBe(true);
    expect(devicePrincipalMatchesSigner(id, KEY.slice(2).toUpperCase())).toBe(true);
    expect(devicePrincipalMatchesSigner(id, "0x" + "7b".repeat(32))).toBe(false);
  });
});

describe("principal ids — a key whose secret is public is never a device principal (N35)", () => {
  it("the denylist holds the key committed with pcc-node, pinned by fingerprint", () => {
    const fingerprints = [...COMPROMISED_DEVICE_PUBLIC_KEYS].map((k) =>
      createHash("sha256").update(k.slice(2)).digest("hex").slice(0, 16),
    );
    expect(fingerprints).toContain("e3b726020a9bb4a5"); // the same entry as pcc-node's denylist
    expect(isCompromisedDevicePublicKey(LEAKED.toUpperCase().replace("0X", "0x"))).toBe(true);
  });

  it("it cannot be formatted, bound to D2, or read out of the registry", () => {
    expect(() => formatDevicePrincipalId(LEAKED)).toThrow(PrincipalIdError);
    const forged = `ed25519:${LEAKED}`; // well formed, but naming a leaked key
    expect(parseDevicePrincipalId(forged)).not.toBeNull();
    expect(devicePrincipalMatchesSigner(forged, LEAKED)).toBe(false);
    expect(principalFromRegistry({ algorithm: "ed25519", publicKey: LEAKED }, 84532)).toBeNull();
  });
});

describe("principalFromRegistry — the one way to compare a registry signer", () => {
  it("lowercases the registry's EIP-55 address and keeps the ed25519 form", () => {
    expect(principalFromRegistry({ algorithm: "secp256k1", address: ADDR_MIXED }, 84532)).toBe(`eip155:84532:${ADDR}`);
    expect(principalFromRegistry({ algorithm: "ed25519", publicKey: KEY }, 84532)).toBe(`ed25519:${KEY}`);
    expect(principalFromRegistry(ADDR_MIXED, 8453)).toBe(`eip155:8453:${ADDR}`);
  });

  it("returns null for anything the registry could not hold", () => {
    for (const bad of [null, {}, { algorithm: "rsa", publicKey: KEY }, { algorithm: "ed25519", publicKey: "zz" }]) {
      expect(principalFromRegistry(bad, 84532)).toBeNull();
    }
    expect(principalFromRegistry({ algorithm: "secp256k1", address: ADDR }, 0)).toBeNull();
  });
});

describe("principal ids — the bytes32 words of a funded authorizedTuples triple", () => {
  it("each word is keccak256 of the pinned id's UTF-8 (keccak-256, not SHA3-256)", () => {
    // keccak256("a"), the well-known vector.
    expect(principalTupleWord("kernel", "a")).toBe("0x3ac225168df54212a25c1c01fd35bebfea408fdac2e31ddd6f80a4bbf9a5f1cb");
    const op = formatOperatorPrincipalId(84532, ADDR_MIXED);
    const dev = formatDevicePrincipalId(KEY);
    const [o, k, d] = authorizedTuple(op, "kernel-x", dev);
    expect(o).toBe(principalTupleWord("operator", op));
    expect(k).toBe(principalTupleWord("kernel", "kernel-x"));
    expect(d).toBe(principalTupleWord("device", dev));
    for (const w of [o, k, d]) expect(w).toMatch(/^0x[0-9a-f]{64}$/);
    expect(new Set([o, k, d]).size).toBe(3);
  });

  it("refuses ids that are not the pinned forms, an empty kernel, and a leaked device key", () => {
    expect(() => principalTupleWord("operator", `eip155:84532:${ADDR_MIXED}`)).toThrow(PrincipalIdError);
    expect(() => principalTupleWord("device", KEY)).toThrow(PrincipalIdError);
    expect(() => principalTupleWord("kernel", "")).toThrow(PrincipalIdError);
    expect(() => principalTupleWord("device", `ed25519:${LEAKED}`)).toThrow(PrincipalIdError);
  });
});

describe("principal ids — the pinned vectors (principal-id.vectors.json, mirrored by the oracle)", () => {
  it("reproduces every tuple word and tuple", () => {
    for (const v of vectors.words) {
      expect(principalTupleWord(v.kind as "operator" | "kernel" | "device", v.id), v.id).toBe(v.word);
    }
    for (const t of vectors.tuples) {
      expect(authorizedTuple(t.operatorPrincipalId, t.kernelId, t.devicePrincipalId)).toEqual(t.words);
    }
    expect(vectors.words.find((v) => v.id === "a")!.word).toBe(
      "0x3ac225168df54212a25c1c01fd35bebfea408fdac2e31ddd6f80a4bbf9a5f1cb",
    );
  });

  it("refuses every refused vector", () => {
    for (const r of vectors.refused) {
      expect(() => principalTupleWord(r.kind as "operator" | "kernel" | "device", r.id), r.why).toThrow(PrincipalIdError);
    }
  });
});

// The E6 review of PR #399 (cross-family verdict DO-NOT-SHIP): F1 pinned, F2 and F3 fixed.
// Invisible and non-ASCII test characters are built at runtime, so none sits in this source where an editor could
// mangle it. Every assertion that touches the compromised key is a boolean or a toThrow, so a failure can never
// print the key.
const LF = String.fromCharCode(0x0a);
const CR = String.fromCharCode(0x0d);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const TERMINATORS: ReadonlyArray<readonly [string, string]> = [
  ["LF", LF],
  ["CR", CR],
  ["CRLF", CR + LF],
  ["U+2028", LS],
  ["U+2029", PS],
];
const LEAKED_HEX = LEAKED.slice(2);

describe("principal ids — no line terminator is ever part of an id, a signer or a key (E6 F1, pinned)", () => {
  // The reviewer read `$` as Perl or Python do (it also matches before a final newline). In ECMAScript, without the
  // m flag, `$` matches only at the very end of the input, so every anchored pattern refuses a final terminator and
  // F1 does not reproduce. This block pins that on every entry point, so a multiline or PCRE-style change shows up.
  it("the reviewer's exact reproduction", () => {
    const op = formatOperatorPrincipalId(84532, ADDR);
    const aliased = `${op}${LF}`;
    expect(parseOperatorPrincipalId(aliased)).toBeNull();
    expect(operatorPrincipalMatchesSigner(aliased, ADDR, 84532)).toBe(false);
    expect(() => principalTupleWord("operator", aliased)).toThrow(PrincipalIdError);
    expect(() => formatDevicePrincipalId(`${LEAKED}${LF}`)).toThrow(PrincipalIdError);
  });

  it("no anchored id pattern is multiline", () => {
    for (const re of [OPERATOR_PRINCIPAL_ID_PATTERN, DEVICE_PRINCIPAL_ID_PATTERN, KERNEL_ID_PATTERN]) {
      expect(re.multiline).toBe(false);
    }
  });

  describe.each(TERMINATORS)("terminator %s", (_name, t) => {
    const op = formatOperatorPrincipalId(84532, ADDR);
    const dev = formatDevicePrincipalId(KEY);
    const leakedId = `ed25519:${LEAKED}`;

    it("parseOperatorPrincipalId and parseDevicePrincipalId refuse it after or before an id", () => {
      expect(parseOperatorPrincipalId(op + t)).toBeNull();
      expect(parseOperatorPrincipalId(t + op)).toBeNull();
      expect(parseDevicePrincipalId(dev + t)).toBeNull();
      expect(parseDevicePrincipalId(t + dev)).toBeNull();
      expect(parseDevicePrincipalId(leakedId + t) === null).toBe(true);
    });

    it("formatOperatorPrincipalId refuses an address with it", () => {
      expect(() => formatOperatorPrincipalId(84532, ADDR + t)).toThrow(PrincipalIdError);
      expect(() => formatOperatorPrincipalId(84532, ADDR_MIXED + t)).toThrow(PrincipalIdError);
      expect(() => formatOperatorPrincipalId(84532, t + ADDR)).toThrow(PrincipalIdError);
    });

    it("formatDevicePrincipalId refuses a key with it, the compromised key included", () => {
      expect(() => formatDevicePrincipalId(KEY + t)).toThrow(PrincipalIdError);
      expect(() => formatDevicePrincipalId(KEY.slice(2) + t)).toThrow(PrincipalIdError);
      expect(() => formatDevicePrincipalId(LEAKED + t)).toThrow(PrincipalIdError);
      expect(() => formatDevicePrincipalId(LEAKED_HEX + t)).toThrow(PrincipalIdError);
    });

    it("the D1 and D2 bindings refuse it in the id and in the signer", () => {
      expect(operatorPrincipalMatchesSigner(op + t, ADDR, 84532)).toBe(false);
      expect(operatorPrincipalMatchesSigner(op, ADDR + t, 84532)).toBe(false);
      expect(operatorPrincipalMatchesSigner(op + t, ADDR + t, 84532)).toBe(false);
      expect(devicePrincipalMatchesSigner(dev + t, KEY)).toBe(false);
      expect(devicePrincipalMatchesSigner(dev, KEY + t)).toBe(false);
      expect(devicePrincipalMatchesSigner(dev + t, KEY + t)).toBe(false);
      expect(devicePrincipalMatchesSigner(leakedId + t, LEAKED + t)).toBe(false);
    });

    it("a terminator-suffixed leaked key is not a key (false), and nothing downstream takes it", () => {
      expect(isCompromisedDevicePublicKey(LEAKED + t)).toBe(false);
      expect(() => formatDevicePrincipalId(LEAKED + t)).toThrow(PrincipalIdError);
      expect(principalFromRegistry({ algorithm: "ed25519", publicKey: LEAKED + t }, 84532) === null).toBe(true);
    });

    it("principalTupleWord refuses operator and device ids carrying it", () => {
      expect(() => principalTupleWord("operator", op + t)).toThrow(PrincipalIdError);
      expect(() => principalTupleWord("device", dev + t)).toThrow(PrincipalIdError);
      expect(() => principalTupleWord("device", leakedId + t)).toThrow(PrincipalIdError);
    });
  });
});

describe("principal ids — kernel ids reserve their own namespace (E6 F2)", () => {
  const op = formatOperatorPrincipalId(84532, ADDR_MIXED);
  const dev = formatDevicePrincipalId(KEY);
  const wordOf = (id: string): string => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(id))).toString("hex");

  it("the kernel id grammar is the accepted deal's id rule, so every id a deal names can be hashed", () => {
    expect(KERNEL_ID_PATTERN.source).toBe(ID_PATTERN.source);
    expect(KERNEL_ID_PATTERN.flags).toBe(ID_PATTERN.flags);
  });

  it("reserves exactly the two principal namespaces, and those are the real id prefixes", () => {
    expect([...RESERVED_KERNEL_ID_PREFIXES].sort()).toEqual(["ed25519:", "eip155:"]);
    expect(op.startsWith("eip155:")).toBe(true);
    expect(dev.startsWith("ed25519:")).toBe(true);
  });

  it("a kernel id equal to a valid operator or device id is refused, so the kinds cannot share a word", () => {
    expect(() => principalTupleWord("kernel", op)).toThrow(PrincipalIdError);
    expect(() => principalTupleWord("kernel", dev)).toThrow(PrincipalIdError);
    // the words those same strings get as their own kind are untouched
    expect(principalTupleWord("operator", op)).toBe(wordOf(op));
    expect(principalTupleWord("device", dev)).toBe(wordOf(dev));
  });

  it("no pinned operator or device id is a valid kernel id, across chains, addresses and keys", () => {
    const ids: string[] = [];
    for (const chainId of [1, 8453, 84532, Number.MAX_SAFE_INTEGER]) {
      for (const address of [ADDR, "0x" + "00".repeat(20), "0x" + "ff".repeat(20)]) {
        ids.push(formatOperatorPrincipalId(chainId, address));
      }
    }
    for (const key of [KEY, "0x" + "00".repeat(32), "0x" + "ff".repeat(32)]) ids.push(formatDevicePrincipalId(key));
    expect(ids).toHaveLength(15);
    for (const id of ids) expect(isValidKernelId(id), id).toBe(false);
  });

  it("the reviewer's collision: two ids TextEncoder turns into the same bytes are both refused", () => {
    const loneSurrogate = String.fromCharCode(0xd800);
    const replacement = String.fromCodePoint(0xfffd);
    expect(new TextEncoder().encode(loneSurrogate)).toEqual(new TextEncoder().encode(replacement));
    expect(() => principalTupleWord("kernel", loneSurrogate)).toThrow(PrincipalIdError);
    expect(() => principalTupleWord("kernel", replacement)).toThrow(PrincipalIdError);
  });

  const REFUSED_KERNEL_IDS: ReadonlyArray<readonly [string, string]> = [
    ["nothing (empty)", ""],
    ["a space inside", "kernel x"],
    ["a leading space", " kernel-x"],
    ["a trailing space", "kernel-x "],
    ["a tab", "kernel" + String.fromCharCode(9) + "x"],
    ["a trailing LF", "kernel-x" + LF],
    ["a trailing CR", "kernel-x" + CR],
    ["a trailing CRLF", "kernel-x" + CR + LF],
    ["a trailing U+2028", "kernel-x" + LS],
    ["a trailing U+2029", "kernel-x" + PS],
    ["NUL", "kernel" + String.fromCharCode(0) + "x"],
    ["DEL", "kernel" + String.fromCharCode(0x7f) + "x"],
    ["a non-ASCII letter (NFC e-acute)", "kernel-" + String.fromCodePoint(0xe9)],
    ["the same letter decomposed (NFD)", "kernel-e" + String.fromCodePoint(0x301)],
    ["an astral character", "kernel-" + String.fromCodePoint(0x1f600)],
    ["a lone high surrogate", String.fromCharCode(0xd800)],
    ["a lone low surrogate", String.fromCharCode(0xdc00)],
    ["U+FFFD", String.fromCodePoint(0xfffd)],
    ["129 characters (the cap is 128)", "a".repeat(129)],
  ];
  it.each(REFUSED_KERNEL_IDS)("refuses a kernel id with %s", (_why, id) => {
    expect(isValidKernelId(id)).toBe(false);
    expect(() => principalTupleWord("kernel", id)).toThrow(PrincipalIdError);
  });

  it.each([
    "eip155:",
    "eip155:1",
    "EIP155:1",
    "Eip155:84532:0x",
    "eIp155:x",
    "ed25519:",
    "ed25519:abc",
    "ED25519:abc",
    "Ed25519:x",
    "eD25519:x",
  ])("refuses %s: the operator and device namespaces are reserved in any ASCII case", (id) => {
    expect(isValidKernelId(id)).toBe(false);
    expect(() => principalTupleWord("kernel", id)).toThrow(PrincipalIdError);
  });

  it("accepts the boundary cases and look-alikes, each word being keccak256 of the id's UTF-8 (the preimage is unchanged)", () => {
    const accepted = [
      "a",
      "!",
      "~",
      "a".repeat(128),
      "kernel-reference-1",
      "eip155",
      "ed25519",
      "eip1555:x",
      "ed2551:x",
      "xeip155:1",
      "kernel-eip155:1",
      "kernel-ed25519:x",
      "gateway:local",
      "1:2:3",
      "eip155-x",
      "ed25519_x",
    ];
    for (const id of accepted) {
      expect(isValidKernelId(id), id).toBe(true);
      expect(principalTupleWord("kernel", id), id).toBe(wordOf(id));
    }
  });

  it("every kernel id format the repo actually uses is still accepted (db seeds, gateway-minted ids, fixtures)", () => {
    const real = [
      // packages/db/src/seed/kernels.ts
      "kernel-nyc",
      "kernel-sf",
      "kernel-la",
      "kernel-biolab-01",
      "kernel-neurolab",
      "kernel-bioanalytica",
      "kernel-frontier-4f",
      "kernel-nanoclaw",
      // gateway-minted shapes: kernel_<base36>_<base36>, and kernel_wizard_ or kernel_trilobio_ plus Date.now()
      "kernel_mqfmpq8u_pk81",
      "kernel_wizard_1759312345678",
      "kernel_trilobio_1759312345678",
      // fixtures and the vectors file
      "kernel-reference-1",
      "kernel_test",
      "kernel-test-001",
      "k1",
      "k-1",
      "kern-9",
      "gateway:local",
    ];
    for (const id of real) {
      expect(isValidKernelId(id), id).toBe(true);
      expect(principalTupleWord("kernel", id), id).toBe(wordOf(id));
    }
  });

  it("isValidKernelId is false for anything that is not a string", () => {
    for (const bad of [undefined, null, 0, 1, true, {}, ["a"]]) expect(isValidKernelId(bad)).toBe(false);
  });

  it("the vectors agree with the grammar: every positive kernel id is valid, every refused one is not", () => {
    const positive = [
      ...vectors.words.filter((v) => v.kind === "kernel").map((v) => v.id),
      ...vectors.tuples.map((t) => t.kernelId),
    ];
    expect(positive.length).toBeGreaterThanOrEqual(3);
    for (const id of positive) expect(isValidKernelId(id), id).toBe(true);
    const refused = vectors.refused.filter((r) => r.kind === "kernel");
    expect(refused.length).toBeGreaterThanOrEqual(10);
    for (const r of refused) expect(isValidKernelId(r.id), r.why).toBe(false);
  });
});

describe("principal ids — the registry and the D1/D2 bindings read a signer the same way (E6 F3)", () => {
  const HEX = "7a".repeat(32);
  const A40 = ADDR.slice(2);
  const spellingsOf = (hex: string): string[] => ["0x", "0X", ""].flatMap((p) => [p + hex, p + hex.toUpperCase()]);

  it("the reviewer's case: a 0X ed25519 signer that principalFromRegistry accepts also satisfies D2", () => {
    const upperPrefix = `0X${HEX}`;
    const id = principalFromRegistry({ algorithm: "ed25519", publicKey: upperPrefix }, 84532)!;
    expect(id).toBe(`ed25519:${KEY}`);
    expect(devicePrincipalMatchesSigner(id, upperPrefix)).toBe(true);
  });

  it("a 0X secp256k1 signer that principalFromRegistry accepts also satisfies D1, on its chain only", () => {
    const upperPrefix = `0X${A40}`;
    const id = principalFromRegistry({ algorithm: "secp256k1", address: upperPrefix }, 84532)!;
    expect(id).toBe(`eip155:84532:${ADDR}`);
    expect(operatorPrincipalMatchesSigner(id, upperPrefix, 84532)).toBe(true);
    expect(operatorPrincipalMatchesSigner(id, upperPrefix, 1)).toBe(false);
  });

  it("every spelling the registry accepts binds: 0x, 0X or no prefix, lower, upper and EIP-55 case", () => {
    for (const s of [...spellingsOf(HEX), "0x" + "7a7A".repeat(16), "0X" + "7a7A".repeat(16)]) {
      expect(devicePrincipalMatchesSigner(`ed25519:${KEY}`, s), s).toBe(true);
      expect(principalFromRegistry({ algorithm: "ed25519", publicKey: s }, 84532), s).toBe(`ed25519:${KEY}`);
    }
    for (const s of [...spellingsOf(A40), ADDR_MIXED, "0X" + ADDR_MIXED.slice(2), ADDR_MIXED.slice(2)]) {
      expect(operatorPrincipalMatchesSigner(`eip155:84532:${ADDR}`, s, 84532), s).toBe(true);
      expect(principalFromRegistry({ algorithm: "secp256k1", address: s }, 84532), s).toBe(`eip155:84532:${ADDR}`);
    }
  });

  it("a different key or address does not bind under any spelling", () => {
    for (const s of spellingsOf("7b".repeat(32))) expect(devicePrincipalMatchesSigner(`ed25519:${KEY}`, s), s).toBe(false);
    for (const s of spellingsOf("11".repeat(20))) {
      expect(operatorPrincipalMatchesSigner(`eip155:84532:${ADDR}`, s, 84532), s).toBe(false);
    }
  });

  // A small deterministic generator (mulberry32), so the agreement check needs no fixture and cannot flake.
  function rng(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const HEX_DIGITS = "0123456789abcdefABCDEF";
  const PREFIXES = ["0x", "0X", "", "0x", "0X", "", "x0", "0y", "00x", " 0x", "0x0x", "0Xx"];
  function spelling(rand: () => number, digits: number): string {
    let body = "";
    for (let i = 0; i < digits; i++) body += HEX_DIGITS[Math.floor(rand() * HEX_DIGITS.length)];
    let s = PREFIXES[Math.floor(rand() * PREFIXES.length)] + body;
    const r = rand();
    if (r < 0.08) s = s.slice(0, -1); // one digit short
    else if (r < 0.16) s += "a"; // one digit long
    else if (r < 0.24) s += TERMINATORS[Math.floor(rand() * TERMINATORS.length)]![1]; // a trailing line terminator
    else if (r < 0.28) s = s.slice(0, 4) + "g" + s.slice(5); // a non-hex character
    return s;
  }

  it("over generated spellings the registry accepts an Ed25519 signer exactly when the D2 binding does", () => {
    const rand = rng(0xe6f3);
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 400; i++) {
      const s = spelling(rand, 64);
      const id = principalFromRegistry({ algorithm: "ed25519", publicKey: s }, 84532);
      if (id !== null) {
        accepted++;
        expect(devicePrincipalMatchesSigner(id, s), JSON.stringify(s)).toBe(true);
      } else {
        refused++;
        expect(devicePrincipalMatchesSigner(`ed25519:${KEY}`, s), JSON.stringify(s)).toBe(false);
      }
    }
    expect(accepted).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(50);
  });

  it("over generated spellings the registry accepts a secp256k1 signer exactly when the D1 binding does", () => {
    const rand = rng(0xd1d1);
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 400; i++) {
      const s = spelling(rand, 40);
      const id = principalFromRegistry({ algorithm: "secp256k1", address: s }, 84532);
      if (id !== null) {
        accepted++;
        expect(operatorPrincipalMatchesSigner(id, s, 84532), JSON.stringify(s)).toBe(true);
      } else {
        refused++;
        expect(operatorPrincipalMatchesSigner(`eip155:84532:${ADDR}`, s, 84532), JSON.stringify(s)).toBe(false);
      }
    }
    expect(accepted).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(50);
  });

  it("principal ids stay lowercase-pinned: parse refuses 0X inside an id, and format emits the lowercase form", () => {
    expect(parseOperatorPrincipalId(`eip155:84532:0X${A40}`)).toBeNull();
    expect(parseDevicePrincipalId(`ed25519:0X${HEX}`)).toBeNull();
    expect(formatOperatorPrincipalId(84532, `0X${A40.toUpperCase()}`)).toBe(`eip155:84532:${ADDR}`);
    expect(formatOperatorPrincipalId(84532, A40)).toBe(`eip155:84532:${ADDR}`);
    expect(formatDevicePrincipalId(`0X${HEX.toUpperCase()}`)).toBe(`ed25519:${KEY}`);
  });

  describe("the denylist holds under the shared normalization (N35)", () => {
    const leakedSpellings = spellingsOf(LEAKED_HEX);

    it("every entry of the denylist is in the canonical form its own lookup produces", () => {
      for (const entry of COMPROMISED_DEVICE_PUBLIC_KEYS) expect(isCompromisedDevicePublicKey(entry)).toBe(true);
    });

    it("every spelling the registry accepts of a leaked key is recognized as one", () => {
      expect(leakedSpellings).toHaveLength(6);
      for (const s of leakedSpellings) expect(isCompromisedDevicePublicKey(s)).toBe(true);
    });

    it("formatDevicePrincipalId refuses each spelling for the denylist reason, not as malformed", () => {
      for (const s of leakedSpellings) expect(() => formatDevicePrincipalId(s)).toThrow(/secret half is public/);
    });

    it("no spelling satisfies D2, enters a registry principal, or gets a device tuple word", () => {
      const forged = `ed25519:${LEAKED}`;
      for (const s of leakedSpellings) {
        expect(devicePrincipalMatchesSigner(forged, s)).toBe(false);
        expect(principalFromRegistry({ algorithm: "ed25519", publicKey: s }, 84532) === null).toBe(true);
      }
      expect(() => principalTupleWord("device", forged)).toThrow(PrincipalIdError);
    });

    it("a key that is not on the denylist is not flagged under any spelling, and non-keys are not keys", () => {
      for (const s of spellingsOf(HEX)) expect(isCompromisedDevicePublicKey(s)).toBe(false);
      for (const bad of [undefined, null, 0, {}, "", "0x", LEAKED_HEX.slice(1), LEAKED_HEX + "0", " " + LEAKED_HEX]) {
        expect(isCompromisedDevicePublicKey(bad)).toBe(false);
      }
    });
  });
});

describe("principalTupleWord — only the three kinds", () => {
  it("refuses a kind outside operator, kernel and device, even for a valid principal id", () => {
    const op = `eip155:84532:0x${"ab".repeat(20)}`;
    for (const kind of ["bogus", "", "Operator", "OPERATOR", "kernel ", undefined, null, 1]) {
      expect(() => principalTupleWord(kind as never, op), String(kind)).toThrow(PrincipalIdError);
    }
    expect(principalTupleWord("operator", op)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
