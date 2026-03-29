/**
 * EncryptedBus — wraps any MessageBus-compatible object to provide
 * automatic encryption of outgoing messages and decryption of incoming
 * messages using NaCl box (X25519 authenticated encryption).
 *
 * When a peer's public key is known, the intent payload is encrypted
 * before sending and the encrypted envelope is attached. On receive,
 * encrypted messages are automatically decrypted and the original
 * intent is restored for the handler.
 *
 * Falls back to plain (unencrypted) delivery when no key is available
 * for the peer.
 */

import type { A2AMessage } from "./types.js";
import { encryptMessage, decryptMessage } from "./crypto.js";

/** Minimal bus interface — works with both MessageBus and NetworkedBus */
export interface BusLike {
  send(message: A2AMessage): Promise<void>;
  subscribe(agentId: string, handler: (msg: A2AMessage) => void): void;
}

export class EncryptedBus implements BusLike {
  constructor(
    private inner: BusLike,
    private mySecretKey: string,
    private peerPublicKeys: Map<string, string>, // agentId -> publicKey (hex)
  ) {}

  async send(message: A2AMessage): Promise<void> {
    const peerKey = this.peerPublicKeys.get(message.to);
    if (peerKey) {
      // Encrypt the intent payload
      const plaintext = JSON.stringify(message.intent);
      const envelope = encryptMessage(plaintext, peerKey, this.mySecretKey);
      const encrypted: A2AMessage = {
        ...message,
        intent: { type: "text_message" as const, text: "[encrypted]" },
        encrypted: envelope,
      };
      return this.inner.send(encrypted);
    }
    // No key for peer — send unencrypted
    return this.inner.send(message);
  }

  subscribe(agentId: string, handler: (msg: A2AMessage) => void): void {
    this.inner.subscribe(agentId, (msg) => {
      if (msg.encrypted) {
        const senderKey = this.peerPublicKeys.get(msg.from);
        if (senderKey) {
          const plaintext = decryptMessage(msg.encrypted, senderKey, this.mySecretKey);
          if (plaintext) {
            try {
              const decryptedIntent = JSON.parse(plaintext);
              handler({ ...msg, intent: decryptedIntent, encrypted: undefined });
              return;
            } catch {
              /* fall through to raw handler on parse failure */
            }
          }
        }
      }
      handler(msg);
    });
  }
}
