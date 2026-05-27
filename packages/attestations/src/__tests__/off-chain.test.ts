import { describe, it, expect } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  OffChainSigner,
  OffChainVerifier,
  computeOffChainUID,
  generateSalt,
  parseSignatureHex,
  padHex32,
} from "../off-chain.js";
import {
  ZERO_ADDRESS,
  ZERO_BYTES32,
  OFFCHAIN_ATTESTATION_VERSION,
} from "../constants.js";

const TEST_PRIVKEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

describe("generateSalt", () => {
  it("returns a 32-byte hex string", () => {
    const s = generateSalt();
    expect(s).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it("returns a different salt on each call", () => {
    const a = generateSalt();
    const b = generateSalt();
    expect(a).not.toBe(b);
  });
});

describe("padHex32", () => {
  it("pads short hex strings to 64 chars", () => {
    expect(padHex32("0xabc")).toBe("0x" + "0".repeat(61) + "abc");
  });

  it("accepts non-prefixed hex strings", () => {
    expect(padHex32("abc")).toBe("0x" + "0".repeat(61) + "abc");
  });

  it("rejects values longer than 32 bytes", () => {
    expect(() => padHex32("0x" + "a".repeat(66))).toThrow(/too long/);
  });
});

describe("parseSignatureHex", () => {
  it("splits a 65-byte signature into r/s/v", () => {
    const sig = ("0x" + "a".repeat(64) + "b".repeat(64) + "1c") as `0x${string}`;
    const { r, s, v } = parseSignatureHex(sig);
    expect(r).toBe("0x" + "a".repeat(64));
    expect(s).toBe("0x" + "b".repeat(64));
    expect(v).toBe(0x1c); // 28
  });

  it("throws on wrong-length input", () => {
    expect(() => parseSignatureHex("0xabcd" as `0x${string}`)).toThrow(
      /65-byte/,
    );
  });
});

describe("computeOffChainUID", () => {
  it("is deterministic for fixed inputs", () => {
    const params = {
      version: 2,
      schema: ("0x" + "01".repeat(32)) as `0x${string}`,
      recipient: ZERO_ADDRESS,
      time: 1700000000n,
      expirationTime: 0n,
      revocable: true,
      refUID: ZERO_BYTES32,
      data: "0xdeadbeef" as `0x${string}`,
      salt: ("0x" + "ab".repeat(32)) as `0x${string}`,
    };
    expect(computeOffChainUID(params)).toBe(computeOffChainUID(params));
  });

  it("differs when salt differs", () => {
    const base = {
      version: 2,
      schema: ("0x" + "01".repeat(32)) as `0x${string}`,
      recipient: ZERO_ADDRESS,
      time: 1700000000n,
      expirationTime: 0n,
      revocable: true,
      refUID: ZERO_BYTES32,
      data: "0xdeadbeef" as `0x${string}`,
    };
    const a = computeOffChainUID({
      ...base,
      salt: ("0x" + "00".repeat(32)) as `0x${string}`,
    });
    const b = computeOffChainUID({
      ...base,
      salt: ("0x" + "11".repeat(32)) as `0x${string}`,
    });
    expect(a).not.toBe(b);
  });
});

describe("OffChainSigner constructor", () => {
  it("accepts a privateKey and derives an account", () => {
    const signer = new OffChainSigner({
      chainId: 8453,
      privateKey: TEST_PRIVKEY,
    });
    expect(signer.attester).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("accepts a pre-built account instead", () => {
    const account = privateKeyToAccount(TEST_PRIVKEY);
    const signer = new OffChainSigner({ chainId: 8453, account });
    expect(signer.attester).toBe(account.address);
  });

  it("looks up EAS address by chainId when no override given", () => {
    const signer = new OffChainSigner({
      chainId: 8453,
      privateKey: TEST_PRIVKEY,
    });
    expect(signer.easAddress).toBe(
      "0x4200000000000000000000000000000000000021",
    );
  });

  it("throws if no privateKey or account is supplied", () => {
    expect(
      // @ts-expect-error — testing runtime behavior
      () => new OffChainSigner({ chainId: 8453 }),
    ).toThrow(/account.*privateKey|privateKey.*account/i);
  });

  it("throws on unsupported chainId with no easAddress override", () => {
    expect(
      () =>
        new OffChainSigner({
          chainId: 99999999,
          privateKey: TEST_PRIVKEY,
        }),
    ).toThrow(/EAS not deployed/);
  });
});

describe("OffChainSigner / OffChainVerifier roundtrip", () => {
  it("signs an attestation with pre-encoded hex data and verifies it", async () => {
    const signer = new OffChainSigner({
      chainId: 8453,
      privateKey: TEST_PRIVKEY,
    });

    const att = await signer.attest({
      schema: ("0x" + "01".repeat(32)) as `0x${string}`,
      recipient: "0x1111111111111111111111111111111111111111",
      data: "0xdeadbeef",
    });

    expect(att.uid).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(att.attester).toBe(signer.attester);
    expect(att.signature.r).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(att.signature.s).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(att.signature.v).toBeGreaterThanOrEqual(27);

    const verifier = new OffChainVerifier();
    const result = await verifier.verify(att);
    expect(result.valid).toBe(true);
    expect(result.attester?.toLowerCase()).toBe(signer.attester.toLowerCase());
  });

  it("signs with schema-string data form and verifies it", async () => {
    const signer = new OffChainSigner({
      chainId: 8453,
      privateKey: TEST_PRIVKEY,
    });

    const att = await signer.attest({
      schema: ("0x" + "02".repeat(32)) as `0x${string}`,
      data: {
        schema: "address user,uint256 amount",
        values: {
          user: "0x1111111111111111111111111111111111111111",
          amount: 12345n,
        },
      },
    });

    const verifier = new OffChainVerifier();
    const result = await verifier.verify(att);
    expect(result.valid).toBe(true);
  });

  it("rejects a tampered UID", async () => {
    const signer = new OffChainSigner({
      chainId: 8453,
      privateKey: TEST_PRIVKEY,
    });
    const att = await signer.attest({
      schema: ("0x" + "03".repeat(32)) as `0x${string}`,
      data: "0x",
    });

    const tampered = { ...att, uid: ("0x" + "ff".repeat(32)) as `0x${string}` };
    const verifier = new OffChainVerifier();
    const result = await verifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/UID mismatch/);
  });

  it("rejects a tampered data field (UID then differs)", async () => {
    const signer = new OffChainSigner({
      chainId: 8453,
      privateKey: TEST_PRIVKEY,
    });
    const att = await signer.attest({
      schema: ("0x" + "04".repeat(32)) as `0x${string}`,
      data: "0xdeadbeef",
    });

    // Mutate data without recomputing UID — verifier should reject
    const tampered = { ...att, data: "0xcafebabe" as `0x${string}` };
    const verifier = new OffChainVerifier();
    const result = await verifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/UID mismatch/);
  });

  it("rejects a swap of attester (signer mismatch)", async () => {
    const signer = new OffChainSigner({
      chainId: 8453,
      privateKey: TEST_PRIVKEY,
    });
    const att = await signer.attest({
      schema: ("0x" + "05".repeat(32)) as `0x${string}`,
      data: "0x",
    });

    // Tamper with attester (an imposter trying to claim authorship)
    const imposter = "0x3333333333333333333333333333333333333333" as `0x${string}`;
    const tampered = { ...att, attester: imposter };
    const verifier = new OffChainVerifier();
    const result = await verifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Signer mismatch|recovered/i);
  });

  it("rejects an attestation past its expiration time", async () => {
    const signer = new OffChainSigner({
      chainId: 8453,
      privateKey: TEST_PRIVKEY,
    });
    const past = BigInt(Math.floor(Date.now() / 1000) - 3600);
    const att = await signer.attest({
      schema: ("0x" + "06".repeat(32)) as `0x${string}`,
      data: "0x",
      time: past - 100n,
      expirationTime: past,
    });

    const verifier = new OffChainVerifier();
    const result = await verifier.verify(att);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/expired/i);
  });

  it("accepts a fresh attestation with future expiration", async () => {
    const signer = new OffChainSigner({
      chainId: 8453,
      privateKey: TEST_PRIVKEY,
    });
    const future = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const att = await signer.attest({
      schema: ("0x" + "07".repeat(32)) as `0x${string}`,
      data: "0x",
      expirationTime: future,
    });

    const verifier = new OffChainVerifier();
    const result = await verifier.verify(att);
    expect(result.valid).toBe(true);
  });

  it("two different signers produce different attestations for the same payload", async () => {
    const signerA = new OffChainSigner({
      chainId: 8453,
      privateKey: TEST_PRIVKEY,
    });
    const signerB = new OffChainSigner({
      chainId: 8453,
      privateKey: generatePrivateKey(),
    });

    const fixedSalt = ("0x" + "aa".repeat(32)) as `0x${string}`;
    const fixedTime = 1700000000n;

    const attA = await signerA.attest({
      schema: ("0x" + "08".repeat(32)) as `0x${string}`,
      data: "0x",
      salt: fixedSalt,
      time: fixedTime,
    });
    const attB = await signerB.attest({
      schema: ("0x" + "08".repeat(32)) as `0x${string}`,
      data: "0x",
      salt: fixedSalt,
      time: fixedTime,
    });

    // UID is determined by message only (attester is NOT in the UID per EAS V2
    // — it's hardcoded to zero address). So UIDs are equal even though sigs differ.
    expect(attA.uid).toBe(attB.uid);
    expect(attA.signature.r).not.toBe(attB.signature.r);
    expect(attA.attester).not.toBe(attB.attester);

    const verifier = new OffChainVerifier();
    const ra = await verifier.verify(attA);
    const rb = await verifier.verify(attB);
    expect(ra.valid).toBe(true);
    expect(rb.valid).toBe(true);
    expect(ra.attester?.toLowerCase()).toBe(signerA.attester.toLowerCase());
    expect(rb.attester?.toLowerCase()).toBe(signerB.attester.toLowerCase());
  });

  it("the produced attestation has expected version and zero-recipient default", async () => {
    const signer = new OffChainSigner({
      chainId: 8453,
      privateKey: TEST_PRIVKEY,
    });
    const att = await signer.attest({
      schema: ("0x" + "09".repeat(32)) as `0x${string}`,
      data: "0x",
    });
    expect(att.version).toBe(OFFCHAIN_ATTESTATION_VERSION);
    expect(att.recipient).toBe(ZERO_ADDRESS);
    expect(att.refUID).toBe(ZERO_BYTES32);
    expect(att.expirationTime).toBe(0n);
    expect(att.revocable).toBe(true);
  });

  it("attests with a custom recipient and refUID", async () => {
    const signer = new OffChainSigner({
      chainId: 8453,
      privateKey: TEST_PRIVKEY,
    });
    // Use all-lowercase (viem's typed-data validation requires correct EIP-55 checksum or all-lowercase)
    const recipient = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
    const parent = ("0x" + "fe".repeat(32)) as `0x${string}`;
    const att = await signer.attest({
      schema: ("0x" + "0a".repeat(32)) as `0x${string}`,
      data: "0x",
      recipient,
      refUID: parent,
    });
    expect(att.recipient).toBe(recipient);
    expect(att.refUID).toBe(parent);
    const result = await new OffChainVerifier().verify(att);
    expect(result.valid).toBe(true);
  });
});
