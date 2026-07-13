import type { apiKeys } from "../schema/index.js";

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ApiKeyInsert = typeof apiKeys.$inferInsert;

export interface IApiKeyRepository {
  findByHash(keyHash: string): ApiKeyRow | undefined;
  findById(id: string): ApiKeyRow | undefined;
  findByOperator(operatorId: string): ApiKeyRow[];
  findActiveByHash(keyHash: string): ApiKeyRow | undefined;
  insert(key: ApiKeyInsert): ApiKeyRow | undefined;
  incrementUsage(id: string): void;
  revoke(id: string): ApiKeyRow | undefined;
  listActive(): ApiKeyRow[];
  countByOperator(operatorId: string): number;
  // ── ERC-8004 IdentityRegistry write tracking ──────────────────────
  recordOnchainSuccess(
    id: string,
    onchain: {
      agentId: bigint | string;
      txHash: string;
      registryAddress: string;
      chainId: number;
    },
  ): ApiKeyRow | undefined;
  recordOnchainFailure(id: string, error: string): ApiKeyRow | undefined;
  listPendingOnchain(limit?: number): ApiKeyRow[];
  recordOperatorWallet(
    id: string,
    wallet: {
      // H-12: envelope-encrypted private key only (`enc:v1:iv:tag:ct`), never
      // plaintext; null when no KEK is configured (fail-closed at the caller).
      address: string;
      privateKeyEnvelope: string | null;
      onchainStatus: "written" | "failed" | "pending";
      onchainTxHash: string | null;
      onchainError: string | null;
    },
  ): ApiKeyRow | undefined;
  setPasskeyCredential(
    id: string,
    passkey: {
      credentialId: string;
      publicKey: string;
      rpId: string;
    },
  ): ApiKeyRow | undefined;
}
