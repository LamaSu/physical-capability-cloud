/**
 * EAS off-chain attestation signer and verifier.
 *
 * Off-chain attestations are EIP-712 signed messages whose UID is
 * deterministic (computed from message + version + salt). Verification
 * recovers the attester address from the signature and re-derives the UID.
 *
 * Implements EAS off-chain attestation Version 2 (current as of 2026-05).
 *
 * Wire format compatible with the official EAS SDK
 * (ethereum-attestation-service/eas-sdk).
 */

import {
  bytesToHex,
  encodePacked,
  hexToBytes,
  keccak256,
  recoverAddress,
  serializeSignature,
  signatureToHex,
  stringToHex,
  toBytes,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  DEFAULT_EAS_CONTRACT_VERSION,
  EAS_DOMAIN_NAME,
  OFFCHAIN_ATTESTATION_VERSION,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  getEASDeployment,
} from "./constants.js";
import { encodeSchemaData } from "./schema-registry.js";
import type { OffChainAttestation, VerificationResult } from "./types.js";

/**
 * EIP-712 typed-data structure for EAS off-chain attestations (Version 2).
 * Matches the contract's `Attest` primary type.
 */
export const OFFCHAIN_ATTESTATION_TYPES = {
  Attest: [
    { name: "version", type: "uint16" },
    { name: "schema", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "time", type: "uint64" },
    { name: "expirationTime", type: "uint64" },
    { name: "revocable", type: "bool" },
    { name: "refUID", type: "bytes32" },
    { name: "data", type: "bytes" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

export interface OffChainSignerOptions {
  chainId: number;
  /** Hex-prefixed 32-byte private key (or pass `account` instead) */
  privateKey?: `0x${string}`;
  /** Pre-built viem account (alternative to privateKey) */
  account?: PrivateKeyAccount;
  /** Override EAS contract address (otherwise looked up by chainId) */
  easAddress?: `0x${string}`;
  /** Override contract version string used in EIP-712 domain */
  contractVersion?: string;
}

export interface AttestParams {
  /** Schema UID this attestation matches */
  schema: `0x${string}`;
  /** Subject of the attestation (use ZERO_ADDRESS for no specific recipient) */
  recipient?: `0x${string}`;
  /** Unix seconds when attestation expires (0 = never) */
  expirationTime?: bigint;
  /** Reference to a parent attestation */
  refUID?: `0x${string}`;
  /** Whether the attestation can be revoked */
  revocable?: boolean;
  /** Payload as either pre-encoded hex OR an object + schema-string to encode */
  data: `0x${string}` | { schema: string; values: Record<string, unknown> };
  /** Custom 32-byte salt (auto-generated if omitted) */
  salt?: `0x${string}`;
  /** Custom timestamp (defaults to now) */
  time?: bigint;
}

/**
 * Generate a cryptographically random 32-byte salt for replay protection.
 */
export function generateSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  // crypto.getRandomValues is available in both Node 18+ and browsers
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Compute the off-chain attestation UID (EAS Version 2 derivation).
 * Matches eas-sdk's Offchain.getOffchainUID for version=2.
 *
 * UID = keccak256(abi.encodePacked(
 *   uint16(version),
 *   bytes(schema_string_as_bytes),  // BUT schema is bytes32 in V2 -- see below
 *   address(recipient),
 *   address(0),                      // attester placeholder
 *   uint64(time),
 *   uint64(expirationTime),
 *   bool(revocable),
 *   bytes32(refUID),
 *   bytes(data),
 *   bytes32(salt),
 *   uint32(0)
 * ))
 *
 * IMPORTANT: the EAS SDK packs `schema` as `bytes` of the UTF-8 hex representation
 * (`hexlify(toUtf8Bytes(schema))`) — the schema parameter to this helper is
 * the bytes32 schema UID, so we encode it as a hex-string of those 32 bytes
 * which is what eas-sdk does when called with the schema UID.
 */
export function computeOffChainUID(params: {
  version: number;
  schema: `0x${string}`;
  recipient: `0x${string}`;
  time: bigint;
  expirationTime: bigint;
  revocable: boolean;
  refUID: `0x${string}`;
  data: `0x${string}`;
  salt: `0x${string}`;
}): `0x${string}` {
  // EAS SDK does: hexlify(toUtf8Bytes(schema)) — so the schema is treated as
  // a UTF-8 string before being packed as bytes. The schema arg passed by EAS
  // SDK consumers is the bytes32 schema UID as a hex string (e.g.
  // "0xabc...") — packed as raw UTF-8 bytes of THAT string.
  const schemaAsBytes = stringToHex(params.schema);

  return keccak256(
    encodePacked(
      [
        "uint16",
        "bytes",
        "address",
        "address",
        "uint64",
        "uint64",
        "bool",
        "bytes32",
        "bytes",
        "bytes32",
        "uint32",
      ],
      [
        params.version,
        schemaAsBytes,
        params.recipient,
        ZERO_ADDRESS,
        params.time,
        params.expirationTime,
        params.revocable,
        params.refUID,
        params.data,
        params.salt,
        0,
      ],
    ),
  );
}

export class OffChainSigner {
  readonly chainId: number;
  readonly easAddress: `0x${string}`;
  readonly contractVersion: string;
  private readonly account: PrivateKeyAccount;

  constructor(options: OffChainSignerOptions) {
    this.chainId = options.chainId;
    this.easAddress = options.easAddress ?? getEASDeployment(options.chainId).eas;
    this.contractVersion = options.contractVersion ?? DEFAULT_EAS_CONTRACT_VERSION;

    if (options.account) {
      this.account = options.account;
    } else if (options.privateKey) {
      this.account = privateKeyToAccount(options.privateKey);
    } else {
      throw new Error("OffChainSigner requires either { account } or { privateKey }");
    }
  }

  /** Address of the signing account. */
  get attester(): `0x${string}` {
    return this.account.address;
  }

  /**
   * Sign an off-chain attestation. Returns a deterministically-uid'd
   * attestation ready to share over any transport.
   */
  async attest(params: AttestParams): Promise<OffChainAttestation> {
    const recipient = params.recipient ?? ZERO_ADDRESS;
    const expirationTime = params.expirationTime ?? 0n;
    const refUID = params.refUID ?? ZERO_BYTES32;
    const revocable = params.revocable ?? true;
    const time = params.time ?? BigInt(Math.floor(Date.now() / 1000));
    const salt = params.salt ?? generateSalt();

    let encodedData: `0x${string}`;
    if (typeof params.data === "string") {
      encodedData = params.data;
    } else {
      encodedData = encodeSchemaData(params.data.schema, params.data.values);
    }

    const domain = {
      name: EAS_DOMAIN_NAME,
      version: this.contractVersion,
      chainId: this.chainId,
      verifyingContract: this.easAddress,
    } as const;

    const message = {
      version: OFFCHAIN_ATTESTATION_VERSION,
      schema: params.schema,
      recipient,
      time,
      expirationTime,
      revocable,
      refUID,
      data: encodedData,
      salt,
    };

    // EIP-712 typed-data signature via viem account
    const signatureHex = await this.account.signTypedData({
      domain,
      types: OFFCHAIN_ATTESTATION_TYPES,
      primaryType: "Attest",
      message,
    });

    const { r, s, v } = parseSignatureHex(signatureHex);

    const uid = computeOffChainUID({
      version: OFFCHAIN_ATTESTATION_VERSION,
      schema: params.schema,
      recipient,
      time,
      expirationTime,
      revocable,
      refUID,
      data: encodedData,
      salt,
    });

    return {
      uid,
      version: OFFCHAIN_ATTESTATION_VERSION,
      schema: params.schema,
      recipient,
      attester: this.attester,
      time,
      expirationTime,
      revocable,
      refUID,
      data: encodedData,
      salt,
      signature: { r, s, v },
      domain: { ...domain },
    };
  }
}

/**
 * Stateless verifier — recovers the attester address from the signature
 * and re-checks the deterministic UID. Independent of which key was used.
 */
export class OffChainVerifier {
  /**
   * Verify an off-chain attestation:
   *  1. Re-derive the UID and compare to the claimed UID
   *  2. Recover the signer address from the typed-data signature
   *  3. Confirm recovered signer matches the claimed `attester`
   *  4. Check the attestation has not expired (if expirationTime > 0)
   *
   * Returns `{ valid: true, attester }` on success; `{ valid: false, reason }`
   * with a human-readable failure reason otherwise.
   */
  async verify(attestation: OffChainAttestation): Promise<VerificationResult> {
    // 1. Re-derive UID
    const expectedUID = computeOffChainUID({
      version: attestation.version,
      schema: attestation.schema,
      recipient: attestation.recipient,
      time: attestation.time,
      expirationTime: attestation.expirationTime,
      revocable: attestation.revocable,
      refUID: attestation.refUID,
      data: attestation.data,
      salt: attestation.salt,
    });

    if (expectedUID !== attestation.uid) {
      return { valid: false, attester: null, reason: "UID mismatch" };
    }

    // 2. Recover signer from typed-data signature
    const { r, s, v } = attestation.signature;
    const sigHex = serializeSignature({
      r: padHex32(r),
      s: padHex32(s),
      v: BigInt(v),
    });

    let recovered: `0x${string}`;
    try {
      const { hashTypedData } = await import("viem");
      const digest = hashTypedData({
        domain: attestation.domain,
        types: OFFCHAIN_ATTESTATION_TYPES,
        primaryType: "Attest",
        message: {
          version: attestation.version,
          schema: attestation.schema,
          recipient: attestation.recipient,
          time: attestation.time,
          expirationTime: attestation.expirationTime,
          revocable: attestation.revocable,
          refUID: attestation.refUID,
          data: attestation.data,
          salt: attestation.salt,
        },
      });
      recovered = await recoverAddress({ hash: digest, signature: sigHex });
    } catch (err) {
      return {
        valid: false,
        attester: null,
        reason: `Signature parsing/recovery failed: ${(err as Error).message}`,
      };
    }

    // 3. Compare recovered to claimed attester
    if (recovered.toLowerCase() !== attestation.attester.toLowerCase()) {
      return {
        valid: false,
        attester: recovered,
        reason: `Signer mismatch — recovered ${recovered}, claimed ${attestation.attester}`,
      };
    }

    // 4. Expiry check
    if (attestation.expirationTime > 0n) {
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (attestation.expirationTime < now) {
        return {
          valid: false,
          attester: recovered,
          reason: `Attestation expired at ${attestation.expirationTime} (now=${now})`,
        };
      }
    }

    return { valid: true, attester: recovered };
  }
}

/**
 * Parse a 65-byte concatenated signature hex string into r/s/v components.
 * viem's signTypedData returns 0x{r:64}{s:64}{v:2}.
 */
function parseSignatureHex(sig: `0x${string}`): {
  r: `0x${string}`;
  s: `0x${string}`;
  v: number;
} {
  const raw = sig.startsWith("0x") ? sig.slice(2) : sig;
  if (raw.length !== 130) {
    throw new Error(`Expected 65-byte signature hex (130 chars), got ${raw.length} chars`);
  }
  return {
    r: `0x${raw.slice(0, 64)}` as `0x${string}`,
    s: `0x${raw.slice(64, 128)}` as `0x${string}`,
    v: parseInt(raw.slice(128, 130), 16),
  };
}

/** Ensure a hex string is exactly 32 bytes (64 hex chars + 0x prefix). */
function padHex32(hex: string): `0x${string}` {
  let h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length > 64) {
    throw new Error(`Hex value too long: ${h.length} chars (max 64)`);
  }
  h = h.padStart(64, "0");
  return `0x${h}` as `0x${string}`;
}

// Re-export for tests
export { parseSignatureHex, padHex32 };
