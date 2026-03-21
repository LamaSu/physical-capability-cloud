/**
 * EncryptionService — AES-256-GCM envelope encryption for evidence bundles.
 *
 * Real AES-256-GCM via Node.js crypto for the symmetric layer.
 * Real ECIES (secp256k1 + HKDF-SHA256) via @noble/curves for asymmetric key wrapping.
 *
 * Key wrapping protocol (ECIES):
 *   1. Generate ephemeral secp256k1 keypair
 *   2. ECDH: sharedSecret = ephPriv * recipientPubKey (compressed point)
 *   3. HKDF-SHA256: derivedKey = HKDF(sharedSecret[1..], info="pcc-ecies", len=32)
 *   4. encryptedKey = aesKey XOR derivedKey
 *   5. Transmit: ephemeralPublicKey (hex) + encryptedKey (base64)
 *
 * Decryption:
 *   1. ECDH: sharedSecret = recipientPrivKey * ephemeralPubKey
 *   2. HKDF-SHA256: derivedKey (same params)
 *   3. aesKey = encryptedKey XOR derivedKey
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 as sha256Hash } from "@noble/hashes/sha256";
import type {
  EvidenceBundle,
  EncryptedEvidenceBundle,
  KeyCapsule,
  AccessGrant,
  Address,
  Id,
} from "@pcc/spec";
import { ids } from "@pcc/spec";
import { canonicalize, sha256 } from "@pcc/spec";
import { kernelKeyStore } from "./key-store.js";

export class EncryptionService {
  /**
   * Encrypt an evidence bundle for multiple recipients using real ECIES.
   *
   * @param bundle             - The evidence bundle to encrypt.
   * @param recipients         - Array of `{ address, publicKey }` or legacy `Address` strings.
   *                             When a secp256k1 compressed public key (66 hex chars) is provided,
   *                             real ECIES is used. Otherwise falls back to mock XOR (legacy).
   */
  async encryptBundle(
    bundle: EvidenceBundle,
    recipients: Array<{ address: Address; publicKey?: string } | Address>,
  ): Promise<EncryptedEvidenceBundle> {
    // Generate random AES-256 key
    const aesKey = randomBytes(32);
    const iv = randomBytes(12);

    // Serialize and encrypt bundle
    const plaintext = canonicalize(bundle);
    const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // Create per-recipient key capsules (real ECIES when public key is available)
    const capsules: KeyCapsule[] = recipients.map((r) => {
      const addr = typeof r === "string" ? r : r.address;
      const pubKey = typeof r === "string" ? undefined : r.publicKey;
      if (pubKey && pubKey.length === 66) {
        return this.eciesEncapsulate(aesKey, addr, pubKey);
      }
      return this.mockEncapsulate(aesKey, addr);
    });

    const bundleHash = await sha256(plaintext);

    const encryptedBundle: EncryptedEvidenceBundle = {
      id: ids.bundle(),
      bundleId: bundle.id,
      bundleHash: bundleHash as EvidenceBundle["bundleHash"],
      ciphertext: encrypted.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      encryptedAt: new Date().toISOString(),
      capsules,
    };

    // Store AES key in key store indexed by the original bundle id
    kernelKeyStore.store(bundle.id, aesKey);

    return encryptedBundle;
  }

  /**
   * Decrypt a bundle using a key capsule and the recipient's private key.
   *
   * @param encrypted  - The encrypted bundle.
   * @param capsule    - The capsule for this recipient.
   * @param privateKey - Hex secp256k1 private key (64 chars) for real ECIES,
   *                     or any string for legacy mock decapsulation.
   */
  async decryptBundle(
    encrypted: EncryptedEvidenceBundle,
    capsule: KeyCapsule,
    privateKey: string,
  ): Promise<EvidenceBundle> {
    let aesKey: Buffer;

    // Use real ECIES when ephemeralPublicKey looks like a hex compressed point (66 chars)
    if (capsule.ephemeralPublicKey.length === 66 && /^[0-9a-f]+$/i.test(capsule.ephemeralPublicKey)) {
      aesKey = this.eciesDecapsulate(capsule, privateKey);
    } else {
      aesKey = this.mockDecapsulate(capsule, privateKey);
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      aesKey,
      Buffer.from(encrypted.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]);

    return JSON.parse(decrypted.toString("utf8")) as EvidenceBundle;
  }

  /**
   * Grant access to a new recipient for an existing encrypted bundle.
   *
   * @param bundleId     - The bundle ID (used to look up AES key in key store).
   * @param aesKey       - The AES key (fallback if not in key store; pass `new Uint8Array(0)`
   *                       to force key store lookup).
   * @param newRecipient - Ethereum address of the new recipient.
   * @param accessLevel  - Access level for the capsule.
   * @param publicKey    - Optional secp256k1 compressed public key for real ECIES.
   */
  async grantAccess(
    bundleId: Id,
    aesKey: Uint8Array,
    newRecipient: Address,
    accessLevel: KeyCapsule["accessLevel"] = "full",
    publicKey?: string,
  ): Promise<AccessGrant> {
    // Prefer key store over caller-supplied key
    const storedKey = kernelKeyStore.retrieve(bundleId);
    const keyToUse = storedKey ?? Buffer.from(aesKey);

    let capsule: KeyCapsule;
    if (publicKey && publicKey.length === 66) {
      capsule = this.eciesEncapsulate(Buffer.from(keyToUse), newRecipient, publicKey, accessLevel);
    } else {
      capsule = this.mockEncapsulate(Buffer.from(keyToUse), newRecipient, accessLevel);
    }

    return {
      id: ids.grant(),
      bundleId,
      grantedBy: "0x0000000000000000000000000000000000000000" as Address,
      grantedTo: newRecipient,
      capsuleId: capsule.id,
      grantedAt: new Date().toISOString(),
      revoked: false,
    };
  }

  // ── Real ECIES ──────────────────────────────────────────────────────

  /**
   * Real ECIES key encapsulation using secp256k1 + HKDF-SHA256.
   */
  private eciesEncapsulate(
    aesKey: Buffer,
    recipientAddress: Address,
    recipientPublicKey: string,
    accessLevel: KeyCapsule["accessLevel"] = "full",
  ): KeyCapsule {
    // 1. Generate ephemeral secp256k1 keypair
    const ephPriv = secp256k1.utils.randomPrivateKey();
    const ephPub = secp256k1.getPublicKey(ephPriv, true); // compressed, 33 bytes

    // 2. ECDH shared secret (65-byte uncompressed point: 04 || x || y)
    const recipientPubBytes = Buffer.from(recipientPublicKey, "hex");
    const sharedSecret = secp256k1.getSharedSecret(ephPriv, recipientPubBytes);

    // 3. Derive 32-byte key via HKDF-SHA256 (skip the 0x04 prefix byte)
    const derivedKey = hkdf(sha256Hash, sharedSecret.slice(1), undefined, "pcc-ecies", 32);

    // 4. XOR AES key with derived key
    const encryptedKey = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
      encryptedKey[i] = aesKey[i] ^ derivedKey[i];
    }

    return {
      id: ids.capsule(),
      recipientAddress,
      recipientPublicKey,
      encryptedKey: encryptedKey.toString("base64"),
      ephemeralPublicKey: Buffer.from(ephPub).toString("hex"), // hex, 66 chars
      accessLevel,
    };
  }

  /**
   * Real ECIES key decapsulation using secp256k1 + HKDF-SHA256.
   */
  private eciesDecapsulate(capsule: KeyCapsule, recipientPrivateKey: string): Buffer {
    const privKeyBytes = Buffer.from(recipientPrivateKey.replace(/^0x/, ""), "hex");
    const ephPubBytes = Buffer.from(capsule.ephemeralPublicKey, "hex");

    // ECDH shared secret
    const sharedSecret = secp256k1.getSharedSecret(privKeyBytes, ephPubBytes);

    // Derive key via HKDF-SHA256
    const derivedKey = hkdf(sha256Hash, sharedSecret.slice(1), undefined, "pcc-ecies", 32);

    // XOR to recover AES key
    const encryptedKey = Buffer.from(capsule.encryptedKey, "base64");
    const aesKey = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
      aesKey[i] = encryptedKey[i] ^ derivedKey[i];
    }
    return aesKey;
  }

  // ── Legacy Mock ECIES (address-based XOR, backward compat) ──────────

  /**
   * Mock ECIES key encapsulation (legacy — address-derived XOR).
   * Used when no secp256k1 public key is available.
   */
  private mockEncapsulate(
    aesKey: Buffer,
    recipientAddress: Address,
    accessLevel: KeyCapsule["accessLevel"] = "full",
  ): KeyCapsule {
    // XOR AES key with deterministic bytes derived from address
    const addrBytes = Buffer.from(recipientAddress.slice(2).padEnd(64, "0"), "hex");
    const ephemeralKey = randomBytes(32);
    const encryptedKey = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
      encryptedKey[i] = aesKey[i] ^ addrBytes[i] ^ ephemeralKey[i];
    }

    return {
      id: ids.capsule(),
      recipientAddress,
      encryptedKey: encryptedKey.toString("base64"),
      ephemeralPublicKey: ephemeralKey.toString("base64"), // base64, NOT 66-char hex
      accessLevel,
    };
  }

  /**
   * Mock ECIES key decapsulation (legacy).
   */
  private mockDecapsulate(capsule: KeyCapsule, _privateKey: string): Buffer {
    const addrBytes = Buffer.from(capsule.recipientAddress.slice(2).padEnd(64, "0"), "hex");
    const ephemeralKey = Buffer.from(capsule.ephemeralPublicKey, "base64");
    const encryptedKey = Buffer.from(capsule.encryptedKey, "base64");
    const aesKey = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
      aesKey[i] = encryptedKey[i] ^ addrBytes[i] ^ ephemeralKey[i];
    }
    return aesKey;
  }
}
