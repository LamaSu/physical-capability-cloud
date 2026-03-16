import { describe, it, expect } from "vitest";
import { UnifiedKeychain } from "../unified-keychain.js";
import { Keypair } from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";

describe("UnifiedKeychain", () => {
  // ── Generation ──────────────────────────────────────────────

  it("generates a valid 12-word mnemonic and derives all keys", () => {
    const kc = new UnifiedKeychain();
    const keys = kc.generate(128);

    expect(keys.mnemonic.split(" ")).toHaveLength(12);
    expect(keys.evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(keys.evm.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(keys.solana.publicKey).toBeTruthy();
    expect(keys.solana.secretKey).toHaveLength(64); // Ed25519 secret = 64 bytes
    expect(keys.did).toMatch(/^did:key:z/);
    expect(keys.bittensor.publicKey).toHaveLength(32);
    expect(keys.bittensor.secretKey).toHaveLength(64);
  });

  it("generates a valid 24-word mnemonic", () => {
    const kc = new UnifiedKeychain();
    const keys = kc.generate(256);
    expect(keys.mnemonic.split(" ")).toHaveLength(24);
  });

  // ── Determinism ─────────────────────────────────────────────

  it("same mnemonic always produces same keys", () => {
    const kc1 = new UnifiedKeychain();
    const keys1 = kc1.generate();

    const kc2 = new UnifiedKeychain();
    const keys2 = kc2.fromMnemonic(keys1.mnemonic);

    expect(keys2.evm.address).toBe(keys1.evm.address);
    expect(keys2.evm.privateKey).toBe(keys1.evm.privateKey);
    expect(keys2.solana.publicKey).toBe(keys1.solana.publicKey);
    expect(keys2.did).toBe(keys1.did);
    expect(keys2.bittensor.publicKeyHex).toBe(keys1.bittensor.publicKeyHex);
  });

  it("different mnemonics produce different keys", () => {
    const kc = new UnifiedKeychain();
    const keys1 = kc.generate();

    const kc2 = new UnifiedKeychain();
    const keys2 = kc2.generate();

    expect(keys2.evm.address).not.toBe(keys1.evm.address);
    expect(keys2.solana.publicKey).not.toBe(keys1.solana.publicKey);
    expect(keys2.did).not.toBe(keys1.did);
  });

  // ── EVM key validity ────────────────────────────────────────

  it("EVM private key produces valid viem account", () => {
    const kc = new UnifiedKeychain();
    const keys = kc.generate();

    const account = privateKeyToAccount(keys.evm.privateKey);
    expect(account.address).toBe(keys.evm.address);
  });

  it("EVM address is checksummed", () => {
    const kc = new UnifiedKeychain();
    const keys = kc.generate();

    // viem always returns checksummed addresses
    expect(keys.evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Not all lowercase (checksummed has mixed case)
    expect(keys.evm.address).not.toBe(keys.evm.address.toLowerCase());
  });

  // ── Solana key validity ─────────────────────────────────────

  it("Solana keypair is valid and can sign", () => {
    const kc = new UnifiedKeychain();
    const keys = kc.generate();

    expect(keys.solana.keypair).toBeInstanceOf(Keypair);
    expect(keys.solana.keypair.publicKey.toBase58()).toBe(keys.solana.publicKey);

    // Can round-trip through Keypair.fromSecretKey
    const restored = Keypair.fromSecretKey(keys.solana.secretKey);
    expect(restored.publicKey.toBase58()).toBe(keys.solana.publicKey);
  });

  // ── DID validity ────────────────────────────────────────────

  it("DID follows did:key format with z-prefix multibase", () => {
    const kc = new UnifiedKeychain();
    const keys = kc.generate();

    expect(keys.did).toMatch(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/);
    // did:key should be reasonably long (Ed25519 pubkey + multicodec prefix)
    expect(keys.did.length).toBeGreaterThan(40);
  });

  // ── Bittensor key validity ──────────────────────────────────

  it("Bittensor keys are valid Ed25519", () => {
    const kc = new UnifiedKeychain();
    const keys = kc.generate();

    expect(keys.bittensor.publicKey).toHaveLength(32);
    expect(keys.bittensor.secretKey).toHaveLength(64);
    expect(keys.bittensor.publicKeyHex).toHaveLength(64);
  });

  it("Bittensor key is different from Solana key (different path)", () => {
    const kc = new UnifiedKeychain();
    const keys = kc.generate();

    expect(keys.bittensor.publicKeyHex).not.toBe(
      Buffer.from(keys.solana.keypair.publicKey.toBytes()).toString("hex"),
    );
  });

  // ── Verify ──────────────────────────────────────────────────

  it("verify() confirms all keys match the mnemonic", () => {
    const kc = new UnifiedKeychain();
    kc.generate();

    const result = kc.verify();
    expect(result.valid).toBe(true);
    expect(result.checks.evm_address).toBe(true);
    expect(result.checks.solana_pubkey).toBe(true);
    expect(result.checks.did).toBe(true);
    expect(result.checks.bittensor_pubkey).toBe(true);
  });

  // ── Error cases ─────────────────────────────────────────────

  it("rejects invalid mnemonic", () => {
    const kc = new UnifiedKeychain();
    expect(() => kc.fromMnemonic("not a valid mnemonic phrase")).toThrow("Invalid BIP-39 mnemonic");
  });

  it("keys getter throws before initialization", () => {
    const kc = new UnifiedKeychain();
    expect(() => kc.keys).toThrow("not initialized");
  });

  // ── Summary ─────────────────────────────────────────────────

  it("summary() hides secrets but shows public info", () => {
    const kc = new UnifiedKeychain();
    kc.generate();

    const summary = kc.summary();
    expect(summary.evm).toMatch(/^0x/);
    expect(summary.solana).toBeTruthy();
    expect(summary.did).toMatch(/^did:key/);
    expect(summary.bittensor).toMatch(/^0x/);
    // Mnemonic is truncated
    expect(summary.mnemonic).toContain("...");
    expect(summary.mnemonic).toContain("12 words");
    // Full mnemonic not exposed
    expect(summary.mnemonic.split(" ").length).toBeLessThan(12);
  });

  // ── Known mnemonic test vector ──────────────────────────────

  it("produces stable output from a known mnemonic", () => {
    const kc = new UnifiedKeychain();
    const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    const keys1 = kc.fromMnemonic(mnemonic);
    const keys2 = new UnifiedKeychain().fromMnemonic(mnemonic);

    // Same mnemonic → exact same results every time
    expect(keys1.evm.address).toBe(keys2.evm.address);
    expect(keys1.solana.publicKey).toBe(keys2.solana.publicKey);
    expect(keys1.did).toBe(keys2.did);

    // EVM address from "abandon...about" is well-known
    // m/44'/60'/0'/0/0 → 0x9858EfFD232B4033E47d90003D41EC34EcaEda94
    expect(keys1.evm.address).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
  });
});
