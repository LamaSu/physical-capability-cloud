import { describe, it, expect } from "vitest";
import { resolvePKH, parsePKHIdentifier } from "../methods/pkh.js";
import { parseDID } from "../did.js";
import { DIDResolutionError } from "../types.js";

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const BASE_CHAIN_ID = "8453";

describe("parsePKHIdentifier", () => {
  it("parses eip155 + Base chain", () => {
    const result = parsePKHIdentifier(`eip155:${BASE_CHAIN_ID}:${VITALIK}`, "did:pkh:eip155:8453:0x");
    expect(result.namespace).toBe("eip155");
    expect(result.chainReference).toBe(BASE_CHAIN_ID);
    expect(result.address).toBe(VITALIK);
  });

  it("rejects non-numeric eip155 chain reference", () => {
    expect(() => parsePKHIdentifier(`eip155:base:${VITALIK}`, "did")).toThrow(DIDResolutionError);
  });

  it("rejects invalid eip155 address", () => {
    expect(() => parsePKHIdentifier(`eip155:1:notanaddress`, "did")).toThrow(DIDResolutionError);
  });

  it("rejects unsupported namespace", () => {
    expect(() => parsePKHIdentifier(`klaytn:1000:0x${"a".repeat(40)}`, "did")).toThrow(DIDResolutionError);
  });

  it("rejects wrong segment count", () => {
    expect(() => parsePKHIdentifier(`eip155:1`, "did")).toThrow(DIDResolutionError);
  });
});

describe("resolvePKH", () => {
  it("resolves a Base mainnet did:pkh to a DIDDocument", async () => {
    const did = `did:pkh:eip155:${BASE_CHAIN_ID}:${VITALIK}`;
    const parsed = parseDID(did);
    const doc = await resolvePKH(parsed);
    expect(doc.id).toBe(did);
    expect(doc["@context"]).toContain("https://www.w3.org/ns/did/v1");
    expect(doc.verificationMethod).toHaveLength(1);
    const vm = doc.verificationMethod![0]!;
    expect(vm.type).toBe("EcdsaSecp256k1RecoveryMethod2020");
    expect(vm.controller).toBe(did);
    expect(vm.blockchainAccountId).toBe(`eip155:${BASE_CHAIN_ID}:${VITALIK}`);
    expect(doc.authentication).toEqual([vm.id]);
    expect(doc.assertionMethod).toEqual([vm.id]);
  });

  it("checksums lowercase Ethereum addresses in blockchainAccountId", async () => {
    const lower = VITALIK.toLowerCase();
    const did = `did:pkh:eip155:${BASE_CHAIN_ID}:${lower}`;
    const parsed = parseDID(did);
    const doc = await resolvePKH(parsed);
    // The vm.blockchainAccountId should be the EIP-55 checksum, not lowercase
    expect(doc.verificationMethod![0]!.blockchainAccountId).toBe(`eip155:${BASE_CHAIN_ID}:${VITALIK}`);
  });

  it("uses the requested DID as the document id", async () => {
    const did = `did:pkh:eip155:1:${VITALIK}`;
    const parsed = parseDID(did);
    const doc = await resolvePKH(parsed);
    expect(doc.id).toBe(did);
  });

  it("rejects non-pkh DIDs", async () => {
    const parsed = parseDID("did:web:example.com");
    await expect(resolvePKH(parsed)).rejects.toThrow(DIDResolutionError);
  });

  it("includes blockchain-2021 security context", async () => {
    const parsed = parseDID(`did:pkh:eip155:1:${VITALIK}`);
    const doc = await resolvePKH(parsed);
    expect(doc["@context"]).toContain("https://w3id.org/security/suites/blockchain-2021/v1");
  });
});
