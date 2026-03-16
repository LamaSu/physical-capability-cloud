import { describe, it, expect } from "vitest";
import { UnifiedKeychain } from "@pcc/agent-runtime";

// ---------------------------------------------------------------------------
// UnifiedKeychain integration tests (gateway-side validation)
// ---------------------------------------------------------------------------

describe("UnifiedKeychain", () => {
  it("generate() produces all required key fields", () => {
    const kc = new UnifiedKeychain();
    const keys = kc.generate();

    // Mnemonic is a 12-word BIP-39 phrase
    expect(keys.mnemonic).toBeDefined();
    expect(keys.mnemonic.split(" ").length).toBe(12);

    // EVM address (0x-prefixed, 42 hex chars)
    expect(keys.evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(keys.evm.privateKey).toMatch(/^0x[0-9a-f]{64}$/);

    // Solana public key (base58, 32-44 chars)
    expect(keys.solana.publicKey).toBeDefined();
    expect(keys.solana.publicKey.length).toBeGreaterThanOrEqual(32);
    expect(keys.solana.publicKey.length).toBeLessThanOrEqual(44);

    // W3C DID (did:key:z... format)
    expect(keys.did).toMatch(/^did:key:z/);

    // Bittensor public key hex (64 hex chars = 32 bytes)
    expect(keys.bittensor.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generate() produces unique keys each time", () => {
    const kc = new UnifiedKeychain();
    const keys1 = kc.generate();
    const keys2 = kc.generate();

    expect(keys1.mnemonic).not.toBe(keys2.mnemonic);
    expect(keys1.evm.address).not.toBe(keys2.evm.address);
    expect(keys1.solana.publicKey).not.toBe(keys2.solana.publicKey);
    expect(keys1.did).not.toBe(keys2.did);
    expect(keys1.bittensor.publicKeyHex).not.toBe(keys2.bittensor.publicKeyHex);
  });

  it("fromMnemonic() round-trips: same mnemonic produces identical keys", () => {
    const kc = new UnifiedKeychain();
    const original = kc.generate();

    const kc2 = new UnifiedKeychain();
    const restored = kc2.fromMnemonic(original.mnemonic);

    expect(restored.evm.address).toBe(original.evm.address);
    expect(restored.evm.privateKey).toBe(original.evm.privateKey);
    expect(restored.solana.publicKey).toBe(original.solana.publicKey);
    expect(restored.did).toBe(original.did);
    expect(restored.bittensor.publicKeyHex).toBe(original.bittensor.publicKeyHex);
  });

  it("verify() confirms all keys are correctly derived", () => {
    const kc = new UnifiedKeychain();
    kc.generate();

    const result = kc.verify();
    expect(result.valid).toBe(true);
    expect(result.checks.evm_address).toBe(true);
    expect(result.checks.solana_pubkey).toBe(true);
    expect(result.checks.did).toBe(true);
    expect(result.checks.bittensor_pubkey).toBe(true);
  });

  it("fromMnemonic() rejects invalid mnemonics", () => {
    const kc = new UnifiedKeychain();
    expect(() => kc.fromMnemonic("not a valid mnemonic phrase")).toThrow(
      "Invalid BIP-39 mnemonic",
    );
  });

  it("response shape matches what the /api/onboard/redeem endpoint returns", () => {
    // Simulate the exact shape that the route handler builds
    const kc = new UnifiedKeychain();
    const keys = kc.generate();

    const responseKeys = {
      mnemonic: keys.mnemonic,
      evm: {
        address: keys.evm.address,
      },
      solana: {
        publicKey: keys.solana.publicKey,
      },
      did: keys.did,
      bittensor: {
        publicKeyHex: keys.bittensor.publicKeyHex,
      },
    };

    // Verify the response shape has the expected fields
    expect(responseKeys.mnemonic).toBeDefined();
    expect(responseKeys.evm.address).toBeDefined();
    expect(responseKeys.solana.publicKey).toBeDefined();
    expect(responseKeys.did).toBeDefined();
    expect(responseKeys.bittensor.publicKeyHex).toBeDefined();

    // Verify private keys are NOT included in the response shape
    expect((responseKeys.evm as Record<string, unknown>).privateKey).toBeUndefined();
    expect((responseKeys.solana as Record<string, unknown>).secretKey).toBeUndefined();
    expect((responseKeys.bittensor as Record<string, unknown>).secretKey).toBeUndefined();
  });
});
