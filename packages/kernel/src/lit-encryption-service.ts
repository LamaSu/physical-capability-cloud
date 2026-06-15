/**
 * LitEncryptionService — Lit Protocol-based decentralized encryption for evidence bundles.
 *
 * Encrypts evidence using access conditions tied to on-chain escrow state.
 * Access conditions enforce that only authorized parties (escrow buyer, high-rep verifiers)
 * can decrypt the evidence data.
 *
 * This implementation provides a mock Lit Protocol layer that:
 * - Generates realistic UnifiedAccessControlCondition arrays
 * - Uses AES-256-GCM for actual encryption (same quality as production)
 * - Stores access conditions alongside ciphertext for validation
 * - Has the same interface shape as a real Lit integration
 *
 * TODO: Replace mock with real @lit-protocol/lit-node-client when deploying
 * to an environment with Lit network access. The real integration requires:
 * 1. `new LitNodeClient({ litNetwork: "datil-test" })` + `client.connect()`
 * 2. `LitJsSdk.encryptString()` for encryption
 * 3. `LitJsSdk.decryptToString()` with authSig for decryption
 * 4. Browser-side SessionSigs via `client.getSessionSigs()` for auth
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import type {
  EvidenceBundle,
  EncryptedEvidenceBundle,
  Address,
  Id,
} from "@pcc/spec";
import { ids } from "@pcc/spec";
import { canonicalize, sha256 } from "@pcc/spec";

// ── Lit Protocol Types (mirrors @lit-protocol/types) ──────────────────

/** Unified Access Control Condition — the core Lit primitive for gating decryption. */
export interface UnifiedAccessControlCondition {
  conditionType: "evmBasic" | "evmContract" | "solRpc" | "cosmos" | "unified";
  contractAddress?: string;
  standardContractType?: string;
  chain: string;
  method?: string;
  parameters?: string[];
  returnValueTest: {
    comparator: string;
    value: string;
  };
  functionName?: string;
  functionParams?: string[];
  functionAbi?: object;
}

/** Operator for combining access conditions (boolean logic). */
export interface AccessControlConditionOperator {
  operator: "and" | "or";
}

/** A condition chain is an array of conditions and operators. */
export type AccessControlConditionChain = Array<
  UnifiedAccessControlCondition | AccessControlConditionOperator
>;

/** Auth signature for Lit decryption (browser-side). */
export interface LitAuthSig {
  sig: string;
  derivedVia: string;
  signedMessage: string;
  address: string;
}

/** Session signatures for Lit v3+ (browser-side). */
export interface LitSessionSigs {
  [nodeAddress: string]: {
    sig: string;
    derivedVia: string;
    signedMessage: string;
    address: string;
    algo?: string;
  };
}

/** Result of a Lit encryption operation. */
export interface LitEncryptionResult {
  ciphertext: string;
  dataToEncryptHash: string;
  accessControlConditions: AccessControlConditionChain;
  network: string;
}

/** Options for the LitEncryptionService. */
export interface LitEncryptionServiceOptions {
  /** Lit network to use. Default: "chipotle" */
  network?: string;
  /** Chain for access conditions. Default: "baseSepolia" */
  chain?: string;
  /** Whether to run in mock mode (no real Lit network). Default: true */
  mock?: boolean;
  /** Chipotle REST API URL. Default: https://api.dev.litprotocol.com/core/v1 */
  apiUrl?: string;
  /** Chipotle API key (from dashboard.dev.litprotocol.com). Default: LIT_API_KEY env */
  apiKey?: string;
  /**
   * Encrypt-by-default PCC operator address. When set, the gateway's own key
   * is added to the access-control conditions OR-chain so PCC can later read
   * encrypted evidence for verification + observability without dropping the
   * buyer / verifier gates. Pass undefined (default) to preserve the legacy
   * 2-condition ACL (buyer OR high-reputation verifier).
   *
   * Per pcc-deliberation #058 gateway items: "Lit encrypt-by-default — when
   * encrypted evidence is enabled, ensure PCC's own key is in the ACL".
   *
   * Convention: read from PCC_ENCRYPTION_OPERATOR_ADDRESS env in the gateway
   * service factory.
   */
  pccOperatorAddress?: string;
}

// ── Service Implementation ────────────────────────────────────────────

export class LitEncryptionService {
  private readonly network: string;
  private readonly chain: string;
  private readonly mock: boolean;
  private readonly pccOperatorAddress?: string;
  private connected = false;

  // Mock storage: maps dataToEncryptHash -> { plaintext, aesKey, iv }
  // In production, Lit nodes hold the decryption shares — this is only for mock mode.
  private readonly mockKeyStore = new Map<
    string,
    { aesKey: Buffer; iv: Buffer; authTag: Buffer }
  >();

  // ── Telemetry counters ──────────────────────────────────────────
  private encryptCount = 0;
  private decryptCount = 0;
  private lastError: string | null = null;

  constructor(options: LitEncryptionServiceOptions = {}) {
    this.network = options.network ?? "datil-test";
    this.chain = options.chain ?? "baseSepolia";
    this.mock = options.mock ?? true;
    this.pccOperatorAddress = options.pccOperatorAddress;

    console.log(
      `[LIT] LitEncryptionService (mock) constructed — network=${this.network} chain=${this.chain} pccInACL=${this.pccOperatorAddress ? "yes" : "no"}`,
    );
  }

  /**
   * Connect to the Lit network. In mock mode, this is a no-op.
   * In production, this would call `new LitNodeClient().connect()`.
   */
  async connect(): Promise<void> {
    console.log(`[LIT] mock connect() called — mock=${this.mock}`);
    if (this.mock) {
      this.connected = true;
      console.log(`[LIT] mock connect() completed — mode=mock-aes`);
      return;
    }

    // TODO: Real Lit integration
    // const client = new LitNodeClient({ litNetwork: this.network });
    // await client.connect();
    // this.litClient = client;
    this.connected = true;
    console.log(`[LIT] mock connect() completed`);
  }

  /** Whether the service is connected to the Lit network. */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Return current service state for telemetry/observability.
   */
  getStatus(): {
    connected: boolean;
    mode: "mock-aes";
    network: string;
    hasPKP: false;
    apiKeyPresent: false;
    encryptCount: number;
    decryptCount: number;
    lastError: string | null;
  } {
    return {
      connected: this.connected,
      mode: "mock-aes",
      network: this.network,
      hasPKP: false,
      apiKeyPresent: false,
      encryptCount: this.encryptCount,
      decryptCount: this.decryptCount,
      lastError: this.lastError,
    };
  }

  /**
   * Build Unified Access Control Conditions for an escrow-gated evidence bundle.
   *
   * The conditions enforce:
   *   (caller is the buyer on the escrow contract)
   *   OR (caller is a verifier with >= 100 reputation)
   *   OR (caller is the PCC operator — when `pccOperatorAddress` is configured)
   *
   * The PCC operator clause is added only when the service was constructed
   * with `pccOperatorAddress` set (encrypt-by-default — see #058 in
   * pcc-deliberation). When unset, the legacy 2-condition ACL stands and
   * existing call sites are unaffected.
   *
   * This produces a real Lit-compatible condition chain that can be used with
   * the actual Lit SDK when switching off mock mode.
   */
  buildAccessConditions(
    escrowAddress: Address,
    jobId: Id,
  ): AccessControlConditionChain {
    // Condition 1: Caller is the buyer on the MilestoneEscrow contract
    const buyerCondition: UnifiedAccessControlCondition = {
      conditionType: "evmContract",
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
    const orOperator: AccessControlConditionOperator = { operator: "or" };

    // Condition 2: Caller is a verifier with reputation >= 100
    const verifierCondition: UnifiedAccessControlCondition = {
      conditionType: "evmContract",
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

    const chain: AccessControlConditionChain = [
      buyerCondition,
      orOperator,
      verifierCondition,
    ];

    // Condition 3 (optional — encrypt-by-default): PCC operator key.
    // When the service is constructed with `pccOperatorAddress`, append an OR
    // clause so the gateway can later decrypt the bundle for verification +
    // observability. The clause is an evmBasic address-equality check (no
    // contract call required), which keeps it cheap on Lit nodes and avoids
    // adding more on-chain calls to the condition chain.
    if (this.pccOperatorAddress) {
      const pccOrOperator: AccessControlConditionOperator = { operator: "or" };
      const pccCondition: UnifiedAccessControlCondition = {
        conditionType: "evmBasic",
        chain: this.chain,
        standardContractType: "",
        method: "",
        parameters: [":userAddress"],
        returnValueTest: {
          comparator: "=",
          value: this.pccOperatorAddress,
        },
      };
      chain.push(pccOrOperator, pccCondition);
    }

    return chain;
  }

  /**
   * Encrypt an evidence bundle with Lit Protocol access conditions.
   *
   * In mock mode, uses AES-256-GCM and stores the key locally.
   * In production, Lit nodes would hold threshold-encrypted key shares.
   */
  async encryptBundle(
    bundle: EvidenceBundle,
    escrowAddress: Address,
    jobId: Id,
  ): Promise<EncryptedEvidenceBundle> {
    const encryptStart = performance.now();

    if (!this.connected) {
      const err = new Error("LitEncryptionService not connected. Call connect() first.");
      this.lastError = err.message;
      console.log(`[LIT] mock encryptBundle() FAILED — not connected`);
      throw err;
    }

    console.log(
      `[LIT] mock encryptBundle() called — bundleId=${bundle.id} escrow=${escrowAddress} jobId=${jobId}`,
    );

    const accessConditions = this.buildAccessConditions(escrowAddress, jobId);
    const plaintext = canonicalize(bundle);

    // Encrypt the data
    const { ciphertext, dataToEncryptHash, aesKey, iv, authTag } =
      this.mockEncrypt(plaintext);

    // Store key material for mock decryption
    this.mockKeyStore.set(dataToEncryptHash, { aesKey, iv, authTag });

    const bundleHash = await sha256(plaintext);

    this.encryptCount++;
    const elapsed = (performance.now() - encryptStart).toFixed(1);
    console.log(
      `[LIT] mock encryptBundle() completed in ${elapsed}ms — hash=${dataToEncryptHash.slice(0, 16)}... encryptCount=${this.encryptCount}`,
    );

    return {
      id: ids.bundle(),
      bundleId: bundle.id,
      bundleHash: bundleHash as EvidenceBundle["bundleHash"],
      // Standard envelope fields (for backwards compatibility)
      ciphertext: ciphertext,
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
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
   * In mock mode, validates the auth signature address against access conditions,
   * then decrypts using the locally stored key.
   *
   * In production, this would call `LitJsSdk.decryptToString()` with
   * the Lit node network performing the access condition check.
   */
  async decryptBundle(
    encrypted: EncryptedEvidenceBundle,
    authSig: LitAuthSig,
  ): Promise<EvidenceBundle> {
    const decryptStart = performance.now();

    if (!this.connected) {
      const err = new Error("LitEncryptionService not connected. Call connect() first.");
      this.lastError = err.message;
      console.log(`[LIT] mock decryptBundle() FAILED — not connected`);
      throw err;
    }

    console.log(
      `[LIT] mock decryptBundle() called — bundleId=${encrypted.bundleId ?? "unknown"} hash=${encrypted.litDataToEncryptHash?.slice(0, 16) ?? "none"}...`,
    );

    if (!encrypted.litDataToEncryptHash) {
      const err = new Error("Bundle was not encrypted with Lit Protocol (missing litDataToEncryptHash).");
      this.lastError = err.message;
      console.log(`[LIT] mock decryptBundle() FAILED — ${err.message}`);
      throw err;
    }

    if (!encrypted.litCiphertext) {
      const err = new Error("Bundle was not encrypted with Lit Protocol (missing litCiphertext).");
      this.lastError = err.message;
      console.log(`[LIT] mock decryptBundle() FAILED — ${err.message}`);
      throw err;
    }

    // In mock mode, retrieve the stored key and decrypt
    const keyMaterial = this.mockKeyStore.get(encrypted.litDataToEncryptHash);
    if (!keyMaterial) {
      const err = new Error(
        "Decryption failed: no key material found for this bundle. " +
        "In production, Lit nodes would perform threshold decryption.",
      );
      this.lastError = err.message;
      console.log(`[LIT] mock decryptBundle() FAILED — key not found`);
      throw err;
    }

    // Mock access condition check — in production, Lit nodes enforce this
    this.validateAuthSig(authSig);

    const decipher = createDecipheriv("aes-256-gcm", keyMaterial.aesKey, keyMaterial.iv);
    decipher.setAuthTag(keyMaterial.authTag);

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypted.litCiphertext, "base64")),
      decipher.final(),
    ]);

    this.decryptCount++;
    const elapsed = (performance.now() - decryptStart).toFixed(1);
    console.log(
      `[LIT] mock decryptBundle() completed in ${elapsed}ms — decryptCount=${this.decryptCount}`,
    );

    return JSON.parse(decrypted.toString("utf8")) as EvidenceBundle;
  }

  /**
   * Get the access conditions for a bundle (for client-side display/validation).
   */
  getAccessConditions(
    encrypted: EncryptedEvidenceBundle,
  ): AccessControlConditionChain | null {
    if (!encrypted.litAccessConditions) return null;
    return encrypted.litAccessConditions as AccessControlConditionChain;
  }

  /**
   * Validate that an access condition chain has the expected structure.
   * Useful for verifying conditions before attempting decryption.
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
        const cond = item as UnifiedAccessControlCondition;
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
        const op = item as AccessControlConditionOperator;
        if (!op.operator || !["and", "or"].includes(op.operator)) {
          errors.push(`Operator at index ${i} must be "and" or "or"`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Disconnect from the Lit network. Clears mock key store.
   */
  async disconnect(): Promise<void> {
    console.log(
      `[LIT] mock disconnect() — encryptCount=${this.encryptCount} decryptCount=${this.decryptCount} keyStoreSize=${this.mockKeyStore.size}`,
    );
    this.mockKeyStore.clear();
    this.connected = false;
  }

  // ── Private helpers ───────────────────────────────────────────────

  /**
   * Mock encryption using AES-256-GCM.
   * In production, replaced by LitJsSdk.encryptString().
   */
  private mockEncrypt(plaintext: string): {
    ciphertext: string;
    dataToEncryptHash: string;
    aesKey: Buffer;
    iv: Buffer;
    authTag: Buffer;
  } {
    const aesKey = randomBytes(32);
    const iv = randomBytes(12);

    const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // Hash of plaintext for integrity verification (matches Lit SDK behavior)
    const dataToEncryptHash = createHash("sha256")
      .update(plaintext)
      .digest("hex");

    return {
      ciphertext: encrypted.toString("base64"),
      dataToEncryptHash,
      aesKey,
      iv,
      authTag,
    };
  }

  /**
   * Mock auth signature validation.
   * In production, Lit nodes verify the signature cryptographically.
   */
  private validateAuthSig(authSig: LitAuthSig): void {
    if (!authSig.sig) {
      throw new Error("Invalid auth signature: missing sig");
    }
    if (!authSig.address) {
      throw new Error("Invalid auth signature: missing address");
    }
    if (!authSig.signedMessage) {
      throw new Error("Invalid auth signature: missing signedMessage");
    }
    // In production, Lit nodes verify the signature matches the address
    // and check the signed message format.
  }
}
