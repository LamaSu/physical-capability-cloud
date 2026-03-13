/**
 * RealLitEncryptionService -- Lit Protocol-based decentralized encryption for evidence bundles.
 *
 * Uses the real @lit-protocol/lit-node-client SDK on the "datil-test" network.
 * Encrypts data with Lit's threshold cryptography, where decryption key shares
 * are held by the Lit node network and released only when on-chain access
 * control conditions are met.
 *
 * Key differences from mock:
 * - No local key storage: encryption keys are threshold-split across Lit nodes
 * - Access conditions enforced cryptographically by the Lit network, not in-process
 * - Requires SessionSigs (SIWE-based) for decryption, not simple auth signatures
 * - Connects to a real decentralized network (datil-test for testing, datil for production)
 */

import { LitNodeClient } from "@lit-protocol/lit-node-client";
import { LitNetwork } from "@lit-protocol/constants";
import type {
  AuthSig,
  SessionSigsMap,
  EncryptSdkParams,
  DecryptRequest,
  EncryptResponse,
  DecryptResponse,
} from "@lit-protocol/types";
import type {
  EvidenceBundle,
  EncryptedEvidenceBundle,
  Address,
  Id,
} from "@pcc/spec";
import { ids } from "@pcc/spec";
import { canonicalize, sha256 } from "@pcc/spec";

import type {
  AccessControlConditionChain,
  LitAuthSig,
  LitSessionSigs,
  LitEncryptionServiceOptions,
} from "./lit-encryption-service.js";

// Re-export relevant types from the mock module for compatibility
export type {
  AccessControlConditionChain,
  UnifiedAccessControlCondition,
  AccessControlConditionOperator,
  LitAuthSig,
  LitSessionSigs,
  LitEncryptionResult,
  LitEncryptionServiceOptions,
} from "./lit-encryption-service.js";

// ── Helpers ──────────────────────────────────────────────────────────

/** Convert a string to Uint8Array (for Lit SDK encrypt). */
function stringToUint8Array(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/** Convert a Uint8Array back to a string (from Lit SDK decrypt). */
function uint8ArrayToString(arr: Uint8Array): string {
  return new TextDecoder().decode(arr);
}

// ── Service Implementation ───────────────────────────────────────────

export class RealLitEncryptionService {
  private client: LitNodeClient;
  private connected = false;
  private readonly network: string;
  private readonly chain: string;
  private readonly debug: boolean;

  constructor(options: LitEncryptionServiceOptions = {}) {
    this.network = options.network ?? LitNetwork.DatilTest;
    this.chain = options.chain ?? "baseSepolia";
    this.debug = false;

    this.client = new LitNodeClient({
      litNetwork: this.network as LitNetwork,
      debug: this.debug,
    });
  }

  /**
   * Connect to the Lit Protocol network.
   * This bootstraps the connection to the Lit node operators and fetches
   * the network public key used for encryption.
   */
  async connect(): Promise<void> {
    await this.client.connect();
    this.connected = true;
  }

  /** Whether the service is connected to the Lit network. */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Build Unified Access Control Conditions for an escrow-gated evidence bundle.
   *
   * The conditions enforce:
   *   (caller is the buyer on the escrow contract) OR (caller is a verifier with >= 100 reputation)
   *
   * These are real Lit-compatible UnifiedAccessControlConditions that the Lit
   * network will evaluate on-chain before releasing decryption shares.
   */
  buildAccessConditions(
    escrowAddress: Address,
    jobId: Id,
  ): AccessControlConditionChain {
    // Condition 1: Caller is the buyer on the MilestoneEscrow contract
    const buyerCondition = {
      conditionType: "evmContract" as const,
      contractAddress: escrowAddress,
      chain: this.chain,
      functionName: "getBuyer",
      functionParams: [jobId],
      functionAbi: {
        name: "getBuyer",
        inputs: [{ name: "jobId", type: "string" }],
        outputs: [{ name: "", type: "address" }],
        stateMutability: "view",
        type: "function",
      },
      returnValueTest: {
        comparator: "=",
        value: ":userAddress",
      },
    };

    // OR operator
    const orOperator = { operator: "or" as const };

    // Condition 2: Caller is a verifier with reputation >= 100
    const verifierCondition = {
      conditionType: "evmContract" as const,
      contractAddress: escrowAddress,
      chain: this.chain,
      functionName: "getVerifierReputation",
      functionParams: [":userAddress"],
      functionAbi: {
        name: "getVerifierReputation",
        inputs: [{ name: "verifier", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
      returnValueTest: {
        comparator: ">=",
        value: "100",
      },
    };

    return [buyerCondition, orOperator, verifierCondition];
  }

  /**
   * Encrypt an evidence bundle using the Lit network's threshold cryptography.
   *
   * The data is encrypted with the Lit network's public key. Decryption shares
   * are only released when the on-chain access conditions are met. No keys
   * are stored locally -- they exist as threshold shares across Lit nodes.
   */
  async encryptBundle(
    bundle: EvidenceBundle,
    escrowAddress: Address,
    jobId: Id,
  ): Promise<EncryptedEvidenceBundle> {
    if (!this.connected) {
      throw new Error("RealLitEncryptionService not connected. Call connect() first.");
    }

    const accessConditions = this.buildAccessConditions(escrowAddress, jobId);
    const plaintext = canonicalize(bundle);

    // Encrypt using the Lit SDK -- this uses the network's public key
    const encryptParams: EncryptSdkParams = {
      dataToEncrypt: stringToUint8Array(plaintext),
      unifiedAccessControlConditions: accessConditions as any,
    };

    const { ciphertext, dataToEncryptHash }: EncryptResponse =
      await this.client.encrypt(encryptParams);

    const bundleHash = await sha256(plaintext);

    return {
      id: ids.bundle(),
      bundleId: bundle.id,
      bundleHash: bundleHash as EvidenceBundle["bundleHash"],
      // Standard envelope fields
      ciphertext,
      iv: "", // Lit manages IV internally
      authTag: "", // Lit manages auth tags internally
      encryptedAt: new Date().toISOString(),
      capsules: [], // Lit uses access conditions instead of per-recipient capsules
      // Lit Protocol fields
      litCiphertext: ciphertext,
      litDataToEncryptHash: dataToEncryptHash,
      litAccessConditions: accessConditions as object[],
      litNetwork: this.network,
    };
  }

  /**
   * Decrypt a Lit-encrypted evidence bundle.
   *
   * Requires either SessionSigs (preferred, SIWE-based) or a bare AuthSig.
   * The Lit network nodes will check the on-chain access conditions before
   * releasing their decryption shares.
   *
   * @param encrypted - The encrypted bundle with Lit metadata
   * @param authSigOrSessionSigs - Either a LitAuthSig (bare, limited) or SessionSigsMap (preferred)
   */
  async decryptBundle(
    encrypted: EncryptedEvidenceBundle,
    authSigOrSessionSigs: LitAuthSig | LitSessionSigs,
  ): Promise<EvidenceBundle> {
    if (!this.connected) {
      throw new Error("RealLitEncryptionService not connected. Call connect() first.");
    }

    if (!encrypted.litDataToEncryptHash) {
      throw new Error("Bundle was not encrypted with Lit Protocol (missing litDataToEncryptHash).");
    }

    if (!encrypted.litCiphertext) {
      throw new Error("Bundle was not encrypted with Lit Protocol (missing litCiphertext).");
    }

    // Determine if we have SessionSigs or AuthSig
    const isSessionSigs = !("sig" in authSigOrSessionSigs);

    const decryptParams: DecryptRequest = {
      ciphertext: encrypted.litCiphertext,
      dataToEncryptHash: encrypted.litDataToEncryptHash,
      chain: this.chain,
      unifiedAccessControlConditions: (encrypted.litAccessConditions ?? []) as any,
      ...(isSessionSigs
        ? { sessionSigs: authSigOrSessionSigs as unknown as SessionSigsMap }
        : { authSig: authSigOrSessionSigs as unknown as AuthSig }),
    };

    const { decryptedData }: DecryptResponse = await this.client.decrypt(decryptParams);
    const decryptedString = uint8ArrayToString(decryptedData);

    return JSON.parse(decryptedString) as EvidenceBundle;
  }

  /**
   * Get the access conditions stored in an encrypted bundle.
   */
  getAccessConditions(
    encrypted: EncryptedEvidenceBundle,
  ): AccessControlConditionChain | null {
    if (!encrypted.litAccessConditions) return null;
    return encrypted.litAccessConditions as AccessControlConditionChain;
  }

  /**
   * Validate that an access condition chain has the expected structure.
   * Delegates to the same logic as the mock service.
   */
  validateAccessConditions(conditions: AccessControlConditionChain): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (!Array.isArray(conditions)) {
      return { valid: false, errors: ["Conditions must be an array"] };
    }

    if (conditions.length === 0) {
      return { valid: false, errors: ["Conditions array is empty"] };
    }

    for (let i = 0; i < conditions.length; i++) {
      const item = conditions[i];

      if (i % 2 === 0) {
        // Even indices should be conditions
        const cond = item as any;
        if (!cond.conditionType) {
          errors.push(`Condition at index ${i} missing conditionType`);
        }
        if (!cond.chain) {
          errors.push(`Condition at index ${i} missing chain`);
        }
        if (!cond.returnValueTest) {
          errors.push(`Condition at index ${i} missing returnValueTest`);
        } else {
          if (!cond.returnValueTest.comparator) {
            errors.push(`Condition at index ${i} missing returnValueTest.comparator`);
          }
          if (cond.returnValueTest.value === undefined) {
            errors.push(`Condition at index ${i} missing returnValueTest.value`);
          }
        }
      } else {
        // Odd indices should be operators
        const op = item as any;
        if (!op.operator || !["and", "or"].includes(op.operator)) {
          errors.push(`Operator at index ${i} must be "and" or "or"`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Disconnect from the Lit network and clean up resources.
   */
  async disconnect(): Promise<void> {
    await this.client.disconnect();
    this.connected = false;
  }
}
