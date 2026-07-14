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
  /**
   * Verified-onboarding scope-grant (Wave-1): replace the scopes on an ACTIVE
   * key. The caller MUST pass a bounded, validated scope list — never `["*"]`
   * (C-01). Returns the updated row, or undefined if the key is missing/revoked.
   */
  updateScopes(id: string, scopes: string[]): ApiKeyRow | undefined;
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
      // H-12: envelope-encrypted private key only, never plaintext; null when no
      // KEK is configured (fail-closed at the caller). The gateway writes
      // `enc:v2:<ivHex>:<tagHex>:<ciphertextHex>` (AES-256-GCM). The GCM AAD
      // binds the FULL row identity —
      //   JSON.stringify(["pcc:operator-wallet","v2",<id>,<operator_id>,
      //     <operator_wallet_address lower-cased>])
      // — so an envelope cannot be relocated to another row. Legacy `enc:v1`
      // blobs (address-only AAD) predate this and must be rotated (Wave 3).
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
