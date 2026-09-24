import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  COMPROMISED_DEVICE_PUBLIC_KEYS,
  PRINCIPAL_ID_CONTRACT,
  PrincipalIdError,
  devicePrincipalMatchesSigner,
  formatDevicePrincipalId,
  formatOperatorPrincipalId,
  isCompromisedDevicePublicKey,
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
