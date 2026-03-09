/**
 * EncryptionService — AES-256-GCM envelope encryption for evidence bundles.
 *
 * Real AES-256-GCM via Node.js crypto for the symmetric layer.
 * Mock ECIES for asymmetric key wrapping (swap to @noble/secp256k1 for production).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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

export class EncryptionService {
  /**
   * Encrypt an evidence bundle for multiple recipients.
   * Uses real AES-256-GCM for the bundle, mock ECIES for key distribution.
   */
  async encryptBundle(
    bundle: EvidenceBundle,
    recipientAddresses: Address[],
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

    // Create per-recipient key capsules (mock ECIES)
    const capsules: KeyCapsule[] = recipientAddresses.map((addr) =>
      this.mockEncapsulate(aesKey, addr),
    );

    const bundleHash = await sha256(plaintext);

    return {
      id: ids.bundle(),
      bundleId: bundle.id,
      bundleHash: bundleHash as EvidenceBundle["bundleHash"],
      ciphertext: encrypted.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      encryptedAt: new Date().toISOString(),
      capsules,
    };
  }

  /**
   * Decrypt a bundle using a key capsule and the recipient's private key.
   */
  async decryptBundle(
    encrypted: EncryptedEvidenceBundle,
    capsule: KeyCapsule,
    privateKey: string,
  ): Promise<EvidenceBundle> {
    // Mock ECIES decapsulation
    const aesKey = this.mockDecapsulate(capsule, privateKey);

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
   */
  async grantAccess(
    bundleId: Id,
    aesKey: Uint8Array,
    newRecipient: Address,
    accessLevel: KeyCapsule["accessLevel"] = "full",
  ): Promise<AccessGrant> {
    const capsule = this.mockEncapsulate(
      Buffer.from(aesKey),
      newRecipient,
      accessLevel,
    );

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

  /**
   * Mock ECIES key encapsulation.
   * In production, replace with @noble/secp256k1 ECIES.
   */
  private mockEncapsulate(
    aesKey: Buffer,
    recipientAddress: Address,
    accessLevel: KeyCapsule["accessLevel"] = "full",
  ): KeyCapsule {
    // Mock: XOR AES key with deterministic bytes derived from address
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
      ephemeralPublicKey: ephemeralKey.toString("base64"),
      accessLevel,
    };
  }

  /**
   * Mock ECIES key decapsulation.
   */
  private mockDecapsulate(capsule: KeyCapsule, privateKey: string): Buffer {
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
