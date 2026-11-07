import { and, desc, eq, or, schema, sql } from "@pcc/store";
import { getStore } from "../db.js";
import type { ChallengeReader, KernelRegistryReader, UnitBinding } from "./final-milestone-package-v2.js";
import type { GatewayReceipt } from "./gateway-receipt.js";

export const gatewayKernelRegistry: KernelRegistryReader = {
  signerForKernel(kernelId) {
    const row = getStore().db.select().from(schema.shopKernels).where(eq(schema.shopKernels.id, kernelId)).get();
    if (!row) return null;
    if (row.signingKeyAlgorithm === "ed25519" && /^0x[0-9a-f]{64}$/.test(row.signingKeyPublicKey ?? "")) {
      return { algorithm: "ed25519", publicKey: row.signingKeyPublicKey! };
    }
    if (row.signingKeyAlgorithm === "secp256k1" && /^0x[0-9a-fA-F]{40}$/.test(row.signingAddress ?? "")) {
      return { algorithm: "secp256k1", address: row.signingAddress! };
    }
    return null;
  },
};

export function createJobChallengeReader(jobId: string): ChallengeReader {
  const table = schema.settlementChallenges;
  const forUnit = (unit: UnitBinding) => and(
    eq(table.chainId, Number(unit.chainId)),
    eq(table.escrow, unit.escrow),
    eq(table.settlementUnitId, unit.settlementUnitId),
  );
  return {
    recordFor(unit) {
      const row = getStore().db.select().from(table).where(and(forUnit(unit), eq(table.jobId, jobId)))
        .orderBy(sql`CASE WHEN ${table.state} = 'issued' THEN 0 ELSE 1 END`, desc(table.issuedAt)).get();
      if (!row) return null;
      return {
        nonce: row.nonce as `0x${string}`,
        tChallengeRef: row.tChallengeRef,
        state: row.expiresAt <= Math.floor(Date.now() / 1000) ? "expired" : row.state,
      };
    },
    consumeIssued(unit, expected) {
      const now = Math.floor(Date.now() / 1000);
      // One conditional UPDATE is the authoritative one-use decision, including expiry.
      const result = getStore().db.update(table).set({ state: "consumed", consumedAt: now }).where(and(
        forUnit(unit), eq(table.jobId, jobId), eq(table.state, "issued"),
        eq(table.nonce, expected.nonce), eq(table.tChallengeRef, expected.tChallengeRef),
        sql`${table.expiresAt} > ${now}`,
      )).run();
      return result.changes === 1;
    },
  };
}

export function findStoredReceipt(jobId: string, unit?: UnitBinding) {
  const table = schema.gatewayReceipts;
  return getStore().db.select().from(table).where(unit ? or(
    eq(table.jobId, jobId),
    and(eq(table.chainId, Number(unit.chainId)), eq(table.escrow, unit.escrow), eq(table.settlementUnitId, unit.settlementUnitId)),
  ) : eq(table.jobId, jobId)).get();
}

export function storedReceiptBody(row: typeof schema.gatewayReceipts.$inferSelect) {
  const receipt: GatewayReceipt = {
    chainId: row.chainId,
    escrow: row.escrow as `0x${string}`,
    settlementUnitId: row.settlementUnitId as `0x${string}`,
    packageDigest: row.packageDigest as `0x${string}`,
    receivedAt: row.receivedAt,
  };
  return { receipt, signatureHex: row.signatureHex, receiptDigest: row.receiptDigest, kid: row.kid };
}
