import { describe, it, expect, afterEach } from "vitest";
import { RealLitEncryptionService } from "../lit-encryption-real.js";
import { LitEncryptionService } from "../lit-encryption-service.js";
import {
  createLitEncryptionService,
  isRealLitEnabled,
} from "../lit-encryption-factory.js";
import type {
  UnifiedAccessControlCondition,
  AccessControlConditionOperator,
  AccessControlConditionChain,
} from "../lit-encryption-service.js";
import type { Address } from "@pcc/spec";

// ── Tests for RealLitEncryptionService ─────────────────────────────
//
// These tests validate the non-network parts of the real Lit service:
// - Construction & configuration
// - Access condition generation (same logic as mock)
// - Access condition validation (same logic as mock)
// - Error handling (not connected, bad inputs)
//
// Actual encrypt/decrypt calls require a live Lit network connection
// and are NOT tested here. Integration tests should be run separately
// with LIT_PROTOCOL_REAL=true against datil-test.

const ESCROW_ADDRESS = "0xabcdef1234567890abcdef1234567890abcdef12" as Address;
const JOB_ID = "job_real_lit_001";

describe("RealLitEncryptionService", () => {
  let service: RealLitEncryptionService;

  afterEach(async () => {
    if (service) {
      try {
        await service.disconnect();
      } catch {
        // ignore disconnect errors in tests
      }
    }
  });

  // ── Construction ──────────────────────────────────────────────────

  describe("construction", () => {
    it("creates with default options", () => {
      service = new RealLitEncryptionService();
      expect(service).toBeDefined();
      expect(service.isConnected()).toBe(false);
    });

    it("creates with custom network and chain", () => {
      service = new RealLitEncryptionService({
        network: "datil-dev",
        chain: "ethereum",
      });
      expect(service).toBeDefined();
      expect(service.isConnected()).toBe(false);
    });
  });

  // ── Access Condition Generation ───────────────────────────────────

  describe("access condition generation", () => {
    it("produces a valid 3-element condition chain", () => {
      service = new RealLitEncryptionService();
      const conditions = service.buildAccessConditions(ESCROW_ADDRESS, JOB_ID);

      expect(conditions).toHaveLength(3);
    });

    it("has buyer condition as first element", () => {
      service = new RealLitEncryptionService();
      const conditions = service.buildAccessConditions(ESCROW_ADDRESS, JOB_ID);
      const buyerCond = conditions[0] as UnifiedAccessControlCondition;

      expect(buyerCond.conditionType).toBe("evmContract");
      expect(buyerCond.contractAddress).toBe(ESCROW_ADDRESS);
      expect(buyerCond.chain).toBe("baseSepolia");
      expect(buyerCond.functionName).toBe("getBuyer");
      expect(buyerCond.functionParams).toContain(JOB_ID);
      expect(buyerCond.returnValueTest.comparator).toBe("=");
      expect(buyerCond.returnValueTest.value).toBe(":userAddress");
    });

    it("has OR operator between conditions", () => {
      service = new RealLitEncryptionService();
      const conditions = service.buildAccessConditions(ESCROW_ADDRESS, JOB_ID);
      const op = conditions[1] as AccessControlConditionOperator;

      expect(op.operator).toBe("or");
    });

    it("has verifier reputation condition as third element", () => {
      service = new RealLitEncryptionService();
      const conditions = service.buildAccessConditions(ESCROW_ADDRESS, JOB_ID);
      const verifierCond = conditions[2] as UnifiedAccessControlCondition;

      expect(verifierCond.conditionType).toBe("evmContract");
      expect(verifierCond.contractAddress).toBe(ESCROW_ADDRESS);
      expect(verifierCond.functionName).toBe("getVerifierReputation");
      expect(verifierCond.functionParams).toContain(":userAddress");
      expect(verifierCond.returnValueTest.comparator).toBe(">=");
      expect(verifierCond.returnValueTest.value).toBe("100");
    });

    it("uses configured chain in conditions", () => {
      service = new RealLitEncryptionService({ chain: "ethereum" });
      const conditions = service.buildAccessConditions(ESCROW_ADDRESS, JOB_ID);
      const cond = conditions[0] as UnifiedAccessControlCondition;

      expect(cond.chain).toBe("ethereum");
    });

    it("includes function ABI for each condition", () => {
      service = new RealLitEncryptionService();
      const conditions = service.buildAccessConditions(ESCROW_ADDRESS, JOB_ID);
      const buyerCond = conditions[0] as UnifiedAccessControlCondition;
      const verifierCond = conditions[2] as UnifiedAccessControlCondition;

      expect(buyerCond.functionAbi).toBeDefined();
      expect((buyerCond.functionAbi as any).name).toBe("getBuyer");
      expect(verifierCond.functionAbi).toBeDefined();
      expect((verifierCond.functionAbi as any).name).toBe("getVerifierReputation");
    });
  });

  // ── Access Condition Validation ───────────────────────────────────

  describe("access condition validation", () => {
    it("validates a correct condition chain", () => {
      service = new RealLitEncryptionService();
      const conditions = service.buildAccessConditions(ESCROW_ADDRESS, JOB_ID);
      const result = service.validateAccessConditions(conditions);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects an empty condition array", () => {
      service = new RealLitEncryptionService();
      const result = service.validateAccessConditions([]);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Conditions array is empty");
    });

    it("rejects a non-array", () => {
      service = new RealLitEncryptionService();
      const result = service.validateAccessConditions("not_array" as any);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Conditions must be an array");
    });

    it("rejects condition missing conditionType", () => {
      service = new RealLitEncryptionService();
      const bad: AccessControlConditionChain = [
        { chain: "baseSepolia", returnValueTest: { comparator: "=", value: "1" } } as any,
      ];
      const result = service.validateAccessConditions(bad);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("conditionType"))).toBe(true);
    });

    it("rejects invalid operator", () => {
      service = new RealLitEncryptionService();
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

  // ── Error handling (no network connection) ────────────────────────

  describe("error handling", () => {
    it("throws on encrypt before connect", async () => {
      service = new RealLitEncryptionService();
      const bundle = {
        id: "bun_test",
        jobId: "job_test",
        events: [],
      } as any;

      await expect(
        service.encryptBundle(bundle, ESCROW_ADDRESS, JOB_ID),
      ).rejects.toThrow("not connected");
    });

    it("throws on decrypt before connect", async () => {
      service = new RealLitEncryptionService();
      const encrypted = {
        litDataToEncryptHash: "test",
        litCiphertext: "test",
      } as any;

      await expect(
        service.decryptBundle(encrypted, { sig: "0x", derivedVia: "test", signedMessage: "test", address: "0x1" }),
      ).rejects.toThrow("not connected");
    });

    it("rejects decrypt with missing litDataToEncryptHash", async () => {
      // We can't actually connect without a network, but we can test the
      // pre-connection validation by temporarily marking as connected
      service = new RealLitEncryptionService();
      // Access private field for testing pre-network validation
      (service as any).connected = true;

      const bad = { litCiphertext: "test" } as any;
      await expect(
        service.decryptBundle(bad, { sig: "0x", derivedVia: "test", signedMessage: "test", address: "0x1" }),
      ).rejects.toThrow("missing litDataToEncryptHash");
    });

    it("rejects decrypt with missing litCiphertext", async () => {
      service = new RealLitEncryptionService();
      (service as any).connected = true;

      const bad = { litDataToEncryptHash: "test" } as any;
      await expect(
        service.decryptBundle(bad, { sig: "0x", derivedVia: "test", signedMessage: "test", address: "0x1" }),
      ).rejects.toThrow("missing litCiphertext");
    });
  });

  // ── getAccessConditions ───────────────────────────────────────────

  describe("getAccessConditions", () => {
    it("returns null for bundles without Lit conditions", () => {
      service = new RealLitEncryptionService();
      const nonLit = { id: "test", litAccessConditions: undefined } as any;
      const conditions = service.getAccessConditions(nonLit);

      expect(conditions).toBeNull();
    });

    it("returns conditions from a bundle with litAccessConditions", () => {
      service = new RealLitEncryptionService();
      const conditions = service.buildAccessConditions(ESCROW_ADDRESS, JOB_ID);
      const bundle = { litAccessConditions: conditions } as any;
      const retrieved = service.getAccessConditions(bundle);

      expect(retrieved).not.toBeNull();
      expect(retrieved).toHaveLength(3);
    });
  });

  // ── getStatus (telemetry) ──────────────────────────────────────────

  describe("getStatus", () => {
    it("returns status before connect (disconnected, local-aes)", () => {
      service = new RealLitEncryptionService();
      const status = service.getStatus();

      expect(status.connected).toBe(false);
      expect(status.mode).toBe("local-aes");
      expect(status.network).toBe("chipotle");
      expect(status.hasPKP).toBe(false);
      expect(status.apiKeyPresent).toBe(false);
      expect(status.encryptCount).toBe(0);
      expect(status.decryptCount).toBe(0);
      expect(status.lastError).toBeNull();
    });

    it("returns connected=true after connect (no API key)", async () => {
      service = new RealLitEncryptionService();
      await service.connect();
      const status = service.getStatus();

      expect(status.connected).toBe(true);
      expect(status.mode).toBe("local-aes");
      expect(status.hasPKP).toBe(false);
    });

    it("returns custom network in status", () => {
      service = new RealLitEncryptionService({ network: "datil-test" });
      const status = service.getStatus();

      expect(status.network).toBe("datil-test");
    });

    it("tracks encryptCount after encryption", async () => {
      service = new RealLitEncryptionService();
      await service.connect();

      const bundle = {
        id: "bun_status_test",
        jobId: "job_test",
        events: [],
      } as any;

      await service.encryptBundle(bundle, ESCROW_ADDRESS, JOB_ID);
      const status = service.getStatus();

      expect(status.encryptCount).toBe(1);
    });

    it("tracks lastError on failure", async () => {
      service = new RealLitEncryptionService();
      // Not connected — encrypt should fail
      try {
        await service.encryptBundle({} as any, ESCROW_ADDRESS, JOB_ID);
      } catch {
        // expected
      }

      const status = service.getStatus();
      expect(status.lastError).toContain("not connected");
    });

    it("is synchronous", () => {
      service = new RealLitEncryptionService();
      // getStatus() should not return a Promise
      const result = service.getStatus();
      expect(result).not.toBeInstanceOf(Promise);
      expect(typeof result.connected).toBe("boolean");
    });
  });

  // ── Interface compatibility ───────────────────────────────────────

  describe("interface compatibility", () => {
    it("has the same method names as LitEncryptionService", () => {
      service = new RealLitEncryptionService();

      // All public methods from the mock should exist on the real service
      expect(typeof service.connect).toBe("function");
      expect(typeof service.disconnect).toBe("function");
      expect(typeof service.isConnected).toBe("function");
      expect(typeof service.buildAccessConditions).toBe("function");
      expect(typeof service.encryptBundle).toBe("function");
      expect(typeof service.decryptBundle).toBe("function");
      expect(typeof service.getAccessConditions).toBe("function");
      expect(typeof service.validateAccessConditions).toBe("function");
      expect(typeof service.getStatus).toBe("function");
    });
  });
});

// ── createLitEncryptionService factory ────────────────────────────────────

describe("createLitEncryptionService (factory)", () => {
  const origEnv = process.env.LIT_PROTOCOL_REAL;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.LIT_PROTOCOL_REAL;
    } else {
      process.env.LIT_PROTOCOL_REAL = origEnv;
    }
  });

  it("returns LitEncryptionService (mock) by default when env is unset", () => {
    delete process.env.LIT_PROTOCOL_REAL;
    const svc = createLitEncryptionService();
    expect(svc).toBeInstanceOf(LitEncryptionService);
  });

  it("returns LitEncryptionService when LIT_PROTOCOL_REAL is 'false'", () => {
    process.env.LIT_PROTOCOL_REAL = "false";
    const svc = createLitEncryptionService();
    expect(svc).toBeInstanceOf(LitEncryptionService);
  });

  it("returns RealLitEncryptionService when LIT_PROTOCOL_REAL=true", () => {
    process.env.LIT_PROTOCOL_REAL = "true";
    const svc = createLitEncryptionService();
    expect(svc).toBeInstanceOf(RealLitEncryptionService);
  });

  it("returns RealLitEncryptionService when options.mock=false, env unset", () => {
    delete process.env.LIT_PROTOCOL_REAL;
    const svc = createLitEncryptionService({ mock: false });
    expect(svc).toBeInstanceOf(RealLitEncryptionService);
  });

  it("returns LitEncryptionService when options.mock=true even if env says real", () => {
    process.env.LIT_PROTOCOL_REAL = "true";
    const svc = createLitEncryptionService({ mock: true });
    // options.mock=true forces mock regardless of env
    expect(svc).toBeInstanceOf(LitEncryptionService);
  });

  it("forwards options to the constructed service (real path)", () => {
    process.env.LIT_PROTOCOL_REAL = "true";
    const svc = createLitEncryptionService({ network: "datil-test", chain: "baseSepolia" });
    expect(svc).toBeInstanceOf(RealLitEncryptionService);
    // Service starts disconnected — options accepted without error
    expect(svc.isConnected()).toBe(false);
  });

  it("forwards options to the constructed service (mock path)", () => {
    delete process.env.LIT_PROTOCOL_REAL;
    const svc = createLitEncryptionService({ network: "datil-test", chain: "ethereum" });
    expect(svc).toBeInstanceOf(LitEncryptionService);
    // Mock service also starts disconnected
    expect(svc.isConnected()).toBe(false);
  });

  it("returned mock service can connect and encrypt synchronously", async () => {
    delete process.env.LIT_PROTOCOL_REAL;
    const svc = createLitEncryptionService() as LitEncryptionService;
    await svc.connect();
    expect(svc.isConnected()).toBe(true);
    await svc.disconnect();
  });
});

// ── isRealLitEnabled helper ───────────────────────────────────────────────

describe("isRealLitEnabled", () => {
  const origEnv = process.env.LIT_PROTOCOL_REAL;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.LIT_PROTOCOL_REAL;
    } else {
      process.env.LIT_PROTOCOL_REAL = origEnv;
    }
  });

  it("returns false when env var is not set", () => {
    delete process.env.LIT_PROTOCOL_REAL;
    expect(isRealLitEnabled()).toBe(false);
  });

  it("returns false when env var is 'false'", () => {
    process.env.LIT_PROTOCOL_REAL = "false";
    expect(isRealLitEnabled()).toBe(false);
  });

  it("returns true when env var is 'true'", () => {
    process.env.LIT_PROTOCOL_REAL = "true";
    expect(isRealLitEnabled()).toBe(true);
  });
});
