import { describe, it, expect, beforeEach } from "vitest";
import {
  SmartAccountManager,
  type SmartAccountConfig,
  type PccSessionModule,
} from "../smart-account.js";
import { createKernelAgentPolicy } from "../spending-policy.js";

describe("SmartAccountManager", () => {
  let manager: SmartAccountManager;
  const escrowContract = "0x1111111111111111111111111111111111111111" as `0x${string}`;
  const identityRegistry = "0x2222222222222222222222222222222222222222" as `0x${string}`;

  beforeEach(() => {
    const config: SmartAccountConfig = {
      owners: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      threshold: 1,
      modules: [],
    };
    manager = new SmartAccountManager(config);
  });

  describe("createSessionKey", () => {
    it("creates a session key with the given config", () => {
      const now = Math.floor(Date.now() / 1000);
      const key = manager.createSessionKey({
        validAfter: now,
        validUntil: now + 3600,
        allowedContracts: [escrowContract],
        allowedFunctions: ["0xa1b2c3d4"],
        maxSpendPerTx: 1000000n, // $1
        maxSpendTotal: 10000000n, // $10
        maxTxCount: 100,
      });

      expect(key.id).toMatch(/^session-/);
      expect(key.address).toMatch(/^0x/);
      expect(key.txCount).toBe(0);
      expect(key.totalSpent).toBe(0n);
      expect(key.revoked).toBe(false);
    });
  });

  describe("authorizeTransaction", () => {
    it("authorizes a valid transaction", () => {
      const now = Math.floor(Date.now() / 1000);
      const key = manager.createSessionKey({
        validAfter: now - 10,
        validUntil: now + 3600,
        allowedContracts: [escrowContract],
        allowedFunctions: ["0xa1b2c3d4"],
        maxSpendPerTx: 1000000n,
        maxSpendTotal: 10000000n,
        maxTxCount: 100,
      });

      const result = manager.authorizeTransaction(
        key.id,
        escrowContract,
        "0xa1b2c3d4",
        500000n,
      );

      expect(result.authorized).toBe(true);
    });

    it("rejects revoked keys", () => {
      const now = Math.floor(Date.now() / 1000);
      const key = manager.createSessionKey({
        validAfter: now - 10,
        validUntil: now + 3600,
        allowedContracts: [escrowContract],
        allowedFunctions: ["0xa1b2c3d4"],
        maxSpendPerTx: 1000000n,
        maxSpendTotal: 10000000n,
        maxTxCount: 100,
      });

      manager.revokeSessionKey(key.id);

      const result = manager.authorizeTransaction(
        key.id,
        escrowContract,
        "0xa1b2c3d4",
        500000n,
      );

      expect(result.authorized).toBe(false);
      expect(result.reason).toContain("revoked");
    });

    it("rejects unauthorized contracts", () => {
      const now = Math.floor(Date.now() / 1000);
      const key = manager.createSessionKey({
        validAfter: now - 10,
        validUntil: now + 3600,
        allowedContracts: [escrowContract],
        allowedFunctions: ["0xa1b2c3d4"],
        maxSpendPerTx: 1000000n,
        maxSpendTotal: 10000000n,
        maxTxCount: 100,
      });

      const result = manager.authorizeTransaction(
        key.id,
        "0x3333333333333333333333333333333333333333",
        "0xa1b2c3d4",
        500000n,
      );

      expect(result.authorized).toBe(false);
      expect(result.reason).toContain("not in allowlist");
    });

    it("rejects amounts exceeding per-tx limit", () => {
      const now = Math.floor(Date.now() / 1000);
      const key = manager.createSessionKey({
        validAfter: now - 10,
        validUntil: now + 3600,
        allowedContracts: [escrowContract],
        allowedFunctions: ["0xa1b2c3d4"],
        maxSpendPerTx: 1000000n, // $1
        maxSpendTotal: 10000000n,
        maxTxCount: 100,
      });

      const result = manager.authorizeTransaction(
        key.id,
        escrowContract,
        "0xa1b2c3d4",
        2000000n, // $2 — exceeds per-tx limit
      );

      expect(result.authorized).toBe(false);
      expect(result.reason).toContain("per-tx limit");
    });

    it("rejects when total spend limit would be exceeded", () => {
      const now = Math.floor(Date.now() / 1000);
      const key = manager.createSessionKey({
        validAfter: now - 10,
        validUntil: now + 3600,
        allowedContracts: [escrowContract],
        allowedFunctions: ["0xa1b2c3d4"],
        maxSpendPerTx: 5000000n,
        maxSpendTotal: 5000000n, // $5 total
        maxTxCount: 100,
      });

      // First tx uses up most of the budget
      manager.recordTransaction(key.id, 4000000n);

      const result = manager.authorizeTransaction(
        key.id,
        escrowContract,
        "0xa1b2c3d4",
        2000000n, // Would push total to $6 — exceeds $5 limit
      );

      expect(result.authorized).toBe(false);
      expect(result.reason).toContain("session limit");
    });

    it("rejects expired keys", () => {
      const now = Math.floor(Date.now() / 1000);
      const key = manager.createSessionKey({
        validAfter: now - 7200,
        validUntil: now - 3600, // Expired 1 hour ago
        allowedContracts: [escrowContract],
        allowedFunctions: ["0xa1b2c3d4"],
        maxSpendPerTx: 1000000n,
        maxSpendTotal: 10000000n,
        maxTxCount: 100,
      });

      const result = manager.authorizeTransaction(
        key.id,
        escrowContract,
        "0xa1b2c3d4",
        500000n,
      );

      expect(result.authorized).toBe(false);
      expect(result.reason).toContain("expired");
    });

    it("rejects when tx count limit reached", () => {
      const now = Math.floor(Date.now() / 1000);
      const key = manager.createSessionKey({
        validAfter: now - 10,
        validUntil: now + 3600,
        allowedContracts: [escrowContract],
        allowedFunctions: ["0xa1b2c3d4"],
        maxSpendPerTx: 1000000n,
        maxSpendTotal: 100000000n,
        maxTxCount: 2,
      });

      manager.recordTransaction(key.id, 100000n);
      manager.recordTransaction(key.id, 100000n);

      const result = manager.authorizeTransaction(
        key.id,
        escrowContract,
        "0xa1b2c3d4",
        100000n,
      );

      expect(result.authorized).toBe(false);
      expect(result.reason).toContain("count limit");
    });
  });

  describe("createKernelSessionKey", () => {
    it("creates a session key from PCC session module", () => {
      const module: PccSessionModule = {
        type: "pcc-kernel-operations",
        allowedOperations: [
          "escrow.lock",
          "escrow.fulfillMilestone",
          "evidence.submit",
        ],
        spendingPolicy: createKernelAgentPolicy(),
      };

      const key = manager.createKernelSessionKey(
        module,
        escrowContract,
        identityRegistry,
        3600, // 1 hour
      );

      expect(key.config.allowedContracts).toContain(escrowContract);
      expect(key.config.allowedContracts).toContain(identityRegistry);
      expect(key.config.allowedFunctions).toHaveLength(3);
      expect(key.config.validUntil - key.config.validAfter).toBe(3600);
    });
  });

  describe("getActiveKeys", () => {
    it("returns only non-revoked, non-expired keys", () => {
      const now = Math.floor(Date.now() / 1000);

      // Active key
      manager.createSessionKey({
        validAfter: now - 10,
        validUntil: now + 3600,
        allowedContracts: [escrowContract],
        allowedFunctions: ["0xa1b2c3d4"],
        maxSpendPerTx: 1000000n,
        maxSpendTotal: 10000000n,
        maxTxCount: 100,
      });

      // Expired key
      manager.createSessionKey({
        validAfter: now - 7200,
        validUntil: now - 3600,
        allowedContracts: [escrowContract],
        allowedFunctions: ["0xa1b2c3d4"],
        maxSpendPerTx: 1000000n,
        maxSpendTotal: 10000000n,
        maxTxCount: 100,
      });

      const active = manager.getActiveKeys();
      expect(active).toHaveLength(1);
    });
  });
});
