import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LitEncryptionService } from "../lit-encryption-service.js";
import type {
  UnifiedAccessControlCondition,
  AccessControlConditionOperator,
  AccessControlConditionChain,
  LitAuthSig,
} from "../lit-encryption-service.js";
import type { EvidenceBundle, Address, SHA256, Signature } from "@pcc/spec";

// ── Test helpers ────────────────────────────────────────────────────

function makeMockBundle(): EvidenceBundle {
  return {
    id: "bun_lit_test_001",
    jobId: "job_lit_test_001",
    stepId: "step_lit_test_001",
    kernelId: "kernel_lit_test_001",
    assuranceTier: 2,
    events: [
      {
        id: "ev_lit_001",
        type: "execution_completed",
        timestamp: new Date().toISOString(),
        source: { deviceId: "dev_001", deviceType: "controller", kernelId: "kernel_lit_test_001" },
        payload: { success: true, duration: 1800 },
        hash: "sha256:aaaa111111111111111111111111111111111111111111111111111111111111" as SHA256,
      },
    ],
    bundleHash: "sha256:bbbb222222222222222222222222222222222222222222222222222222222222" as SHA256,
    kernelSignature: {
      signer: "0x0000000000000000000000000000000000000000" as Address,
      algorithm: "secp256k1",
      value: "mock_kernel_sig",
    } as Signature,
    createdAt: new Date().toISOString(),
  };
}

function makeMockAuthSig(): LitAuthSig {
  return {
    sig: "0xmocksignature1234567890abcdef",
    derivedVia: "web3.eth.personal.sign",
    signedMessage: "I am proving my identity for Lit Protocol decryption",
    address: "0x1234567890abcdef1234567890abcdef12345678",
  };
}

const ESCROW_ADDRESS = "0xabcdef1234567890abcdef1234567890abcdef12" as Address;
const JOB_ID = "job_lit_test_001";

// ── Tests ───────────────────────────────────────────────────────────

describe("LitEncryptionService", () => {
  let service: LitEncryptionService;

  beforeAll(async () => {
    service = new LitEncryptionService({
      network: "datil-test",
      chain: "baseSepolia",
      mock: true,
    });
    await service.connect();
  });

  afterAll(async () => {
    await service.disconnect();
  });

  // ── Initialization ──────────────────────────────────────────────

  describe("initialization", () => {
    it("reports connected after connect()", () => {
      expect(service.isConnected()).toBe(true);
    });

    it("reports disconnected after disconnect()", async () => {
      const tempService = new LitEncryptionService();
      await tempService.connect();
      expect(tempService.isConnected()).toBe(true);
      await tempService.disconnect();
      expect(tempService.isConnected()).toBe(false);
    });

    it("throws on encrypt before connect", async () => {
      const unconnected = new LitEncryptionService();
      const bundle = makeMockBundle();
      await expect(
        unconnected.encryptBundle(bundle, ESCROW_ADDRESS, JOB_ID),
      ).rejects.toThrow("not connected");
    });

    it("throws on decrypt before connect", async () => {
      const unconnected = new LitEncryptionService();
      await expect(
        unconnected.decryptBundle(
          { litDataToEncryptHash: "test", litCiphertext: "test" } as any,
          makeMockAuthSig(),
        ),
      ).rejects.toThrow("not connected");
    });
  });

  // ── Access Condition Generation ─────────────────────────────────

  describe("access condition generation", () => {
    it("produces a valid condition chain with buyer + verifier conditions", () => {
      const conditions = service.buildAccessConditions(ESCROW_ADDRESS, JOB_ID);

      expect(conditions).toHaveLength(3);

      // First: buyer condition
      const buyerCond = conditions[0] as UnifiedAccessControlCondition;
      expect(buyerCond.conditionType).toBe("evmContract");
      expect(buyerCond.contractAddress).toBe(ESCROW_ADDRESS);
      expect(buyerCond.chain).toBe("baseSepolia");
      expect(buyerCond.functionName).toBe("getBuyer");
      expect(buyerCond.functionParams).toContain(JOB_ID);
      expect(buyerCond.returnValueTest.comparator).toBe("=");
      expect(buyerCond.returnValueTest.value).toBe(":userAddress");
    });

    it("has an OR operator between conditions", () => {
      const conditions = service.buildAccessConditions(ESCROW_ADDRESS, JOB_ID);
      const op = conditions[1] as AccessControlConditionOperator;
      expect(op.operator).toBe("or");
    });

    it("has a verifier reputation condition requiring >= 100", () => {
      const conditions = service.buildAccessConditions(ESCROW_ADDRESS, JOB_ID);
      const verifierCond = conditions[2] as UnifiedAccessControlCondition;

      expect(verifierCond.conditionType).toBe("evmContract");
      expect(verifierCond.contractAddress).toBe(ESCROW_ADDRESS);
      expect(verifierCond.functionName).toBe("getVerifierReputation");
      expect(verifierCond.functionParams).toContain(":userAddress");
      expect(verifierCond.returnValueTest.comparator).toBe(">=");
      expect(verifierCond.returnValueTest.value).toBe("100");
    });

    it("includes function ABI for each condition", () => {
      const conditions = service.buildAccessConditions(ESCROW_ADDRESS, JOB_ID);
      const buyerCond = conditions[0] as UnifiedAccessControlCondition;
      const verifierCond = conditions[2] as UnifiedAccessControlCondition;

      expect(buyerCond.functionAbi).toBeDefined();
      expect((buyerCond.functionAbi as any).name).toBe("getBuyer");
      expect(verifierCond.functionAbi).toBeDefined();
      expect((verifierCond.functionAbi as any).name).toBe("getVerifierReputation");
    });

    it("uses the configured chain", () => {
      const customService = new LitEncryptionService({ chain: "ethereum" });
      const conditions = customService.buildAccessConditions(ESCROW_ADDRESS, JOB_ID);
      const cond = conditions[0] as UnifiedAccessControlCondition;
      expect(cond.chain).toBe("ethereum");
    });
  });

  // ── Access Condition Validation ─────────────────────────────────

  describe("access condition validation", () => {
    it("validates a correct condition chain", () => {
      const conditions = service.buildAccessConditions(ESCROW_ADDRESS, JOB_ID);
      const result = service.validateAccessConditions(conditions);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects an empty condition array", () => {
      const result = service.validateAccessConditions([]);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Conditions array is empty");
    });

    it("rejects a non-array", () => {
      const result = service.validateAccessConditions("not_array" as any);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Conditions must be an array");
    });

    it("rejects condition missing conditionType", () => {
      const bad: AccessControlConditionChain = [
        { chain: "baseSepolia", returnValueTest: { comparator: "=", value: "1" } } as any,
      ];
      const result = service.validateAccessConditions(bad);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("conditionType"))).toBe(true);
    });

    it("rejects condition missing chain", () => {
      const bad: AccessControlConditionChain = [
        { conditionType: "evmBasic", returnValueTest: { comparator: "=", value: "1" } } as any,
      ];
      const result = service.validateAccessConditions(bad);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("chain"))).toBe(true);
    });

    it("rejects condition missing returnValueTest", () => {
      const bad: AccessControlConditionChain = [
        { conditionType: "evmBasic", chain: "baseSepolia" } as any,
      ];
      const result = service.validateAccessConditions(bad);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("returnValueTest"))).toBe(true);
    });

    it("rejects invalid operator", () => {
      const bad: AccessControlConditionChain = [
        {
          conditionType: "evmBasic",
          chain: "baseSepolia",
          returnValueTest: { comparator: "=", value: "1" },
        } as UnifiedAccessControlCondition,
        { operator: "xor" } as any,
        {
          conditionType: "evmBasic",
          chain: "baseSepolia",
          returnValueTest: { comparator: "=", value: "2" },
        } as UnifiedAccessControlCondition,
      ];
      const result = service.validateAccessConditions(bad);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('"and" or "or"'))).toBe(true);
    });
  });

  // ── Encryption ──────────────────────────────────────────────────

  describe("encryption", () => {
    it("encrypts a bundle and produces Lit fields", async () => {
      const bundle = makeMockBundle();
      const encrypted = await service.encryptBundle(bundle, ESCROW_ADDRESS, JOB_ID);

      expect(encrypted.id).toMatch(/^bun_/);
      expect(encrypted.bundleId).toBe(bundle.id);
      expect(encrypted.litCiphertext).toBeTruthy();
      expect(encrypted.litDataToEncryptHash).toBeTruthy();
      expect(encrypted.litAccessConditions).toHaveLength(3);
      expect(encrypted.litNetwork).toBe("datil-test");
    });

    it("populates backwards-compatible fields", async () => {
      const bundle = makeMockBundle();
      const encrypted = await service.encryptBundle(bundle, ESCROW_ADDRESS, JOB_ID);

      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.authTag).toBeTruthy();
      expect(encrypted.encryptedAt).toBeTruthy();
      expect(encrypted.bundleHash).toMatch(/^sha256:/);
    });

    it("produces different ciphertext for different bundles", async () => {
      const bundle1 = makeMockBundle();
      const bundle2 = makeMockBundle();
      bundle2.id = "bun_lit_test_002";

      const enc1 = await service.encryptBundle(bundle1, ESCROW_ADDRESS, JOB_ID);
      const enc2 = await service.encryptBundle(bundle2, ESCROW_ADDRESS, JOB_ID);

      expect(enc1.litCiphertext).not.toBe(enc2.litCiphertext);
      expect(enc1.litDataToEncryptHash).not.toBe(enc2.litDataToEncryptHash);
    });

    it("uses empty capsules array (Lit uses conditions instead)", async () => {
      const bundle = makeMockBundle();
      const encrypted = await service.encryptBundle(bundle, ESCROW_ADDRESS, JOB_ID);
      expect(encrypted.capsules).toHaveLength(0);
    });
  });

  // ── Decryption ──────────────────────────────────────────────────

  describe("decryption", () => {
    it("round-trips encrypt and decrypt", async () => {
      const bundle = makeMockBundle();
      const encrypted = await service.encryptBundle(bundle, ESCROW_ADDRESS, JOB_ID);
      const decrypted = await service.decryptBundle(encrypted, makeMockAuthSig());

      expect(decrypted.id).toBe(bundle.id);
      expect(decrypted.jobId).toBe(bundle.jobId);
      expect(decrypted.events).toHaveLength(1);
      expect(decrypted.events[0].type).toBe("execution_completed");
    });

    it("rejects decryption with missing litDataToEncryptHash", async () => {
      const bad = { ciphertext: "test", litCiphertext: "test" } as any;
      await expect(
        service.decryptBundle(bad, makeMockAuthSig()),
      ).rejects.toThrow("missing litDataToEncryptHash");
    });

    it("rejects decryption with missing litCiphertext", async () => {
      const bad = { litDataToEncryptHash: "test" } as any;
      await expect(
        service.decryptBundle(bad, makeMockAuthSig()),
      ).rejects.toThrow("missing litCiphertext");
    });

    it("rejects decryption with invalid auth sig (missing sig)", async () => {
      const bundle = makeMockBundle();
      const encrypted = await service.encryptBundle(bundle, ESCROW_ADDRESS, JOB_ID);
      const badAuth = { ...makeMockAuthSig(), sig: "" };
      await expect(
        service.decryptBundle(encrypted, badAuth),
      ).rejects.toThrow("missing sig");
    });

    it("rejects decryption with invalid auth sig (missing address)", async () => {
      const bundle = makeMockBundle();
      const encrypted = await service.encryptBundle(bundle, ESCROW_ADDRESS, JOB_ID);
      const badAuth = { ...makeMockAuthSig(), address: "" };
      await expect(
        service.decryptBundle(encrypted, badAuth),
      ).rejects.toThrow("missing address");
    });

    it("fails for unknown dataToEncryptHash (e.g., after disconnect)", async () => {
      const bundle = makeMockBundle();
      const encrypted = await service.encryptBundle(bundle, ESCROW_ADDRESS, JOB_ID);

      // Create a new service (no stored keys)
      const freshService = new LitEncryptionService();
      await freshService.connect();
      await expect(
        freshService.decryptBundle(encrypted, makeMockAuthSig()),
      ).rejects.toThrow("no key material found");
      await freshService.disconnect();
    });
  });

  // ── getAccessConditions ─────────────────────────────────────────

  describe("getAccessConditions", () => {
    it("returns conditions from an encrypted bundle", async () => {
      const bundle = makeMockBundle();
      const encrypted = await service.encryptBundle(bundle, ESCROW_ADDRESS, JOB_ID);
      const conditions = service.getAccessConditions(encrypted);

      expect(conditions).not.toBeNull();
      expect(conditions).toHaveLength(3);
    });

    it("returns null for bundles without Lit conditions", () => {
      const nonLit = { id: "test", litAccessConditions: undefined } as any;
      const conditions = service.getAccessConditions(nonLit);
      expect(conditions).toBeNull();
    });
  });

  // ── getStatus (telemetry) ──────────────────────────────────────

  describe("getStatus", () => {
    it("returns mock-aes mode", () => {
      const status = service.getStatus();

      expect(status.connected).toBe(true);
      expect(status.mode).toBe("mock-aes");
      expect(status.network).toBe("datil-test");
      expect(status.hasPKP).toBe(false);
      expect(status.apiKeyPresent).toBe(false);
    });

    it("tracks encryptCount and decryptCount", async () => {
      // Create a fresh service to isolate count tracking
      const freshService = new LitEncryptionService({ network: "datil-test", chain: "baseSepolia", mock: true });
      await freshService.connect();

      const statusBefore = freshService.getStatus();
      expect(statusBefore.encryptCount).toBe(0);
      expect(statusBefore.decryptCount).toBe(0);

      const bundle = makeMockBundle();
      const encrypted = await freshService.encryptBundle(bundle, ESCROW_ADDRESS, JOB_ID);

      const statusAfterEncrypt = freshService.getStatus();
      expect(statusAfterEncrypt.encryptCount).toBe(1);

      await freshService.decryptBundle(encrypted, makeMockAuthSig());

      const statusAfterDecrypt = freshService.getStatus();
      expect(statusAfterDecrypt.decryptCount).toBe(1);

      await freshService.disconnect();
    });

    it("tracks lastError on failure", async () => {
      const unconnected = new LitEncryptionService();
      try {
        await unconnected.encryptBundle(makeMockBundle(), ESCROW_ADDRESS, JOB_ID);
      } catch {
        // expected
      }

      const status = unconnected.getStatus();
      expect(status.lastError).toContain("not connected");
    });

    it("returns disconnected state after disconnect", async () => {
      const tempService = new LitEncryptionService();
      await tempService.connect();
      expect(tempService.getStatus().connected).toBe(true);
      await tempService.disconnect();
      expect(tempService.getStatus().connected).toBe(false);
    });

    it("is synchronous (does not return a Promise)", () => {
      const result = service.getStatus();
      expect(result).not.toBeInstanceOf(Promise);
      expect(typeof result.connected).toBe("boolean");
    });
  });
});
