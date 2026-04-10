/**
 * MessagePersistence — the interface PersistentMessageBus depends on.
 *
 * Defined in @pcc/a2a so the bus stays self-contained with no dependency
 * on @pcc/store. The concrete implementation (A2AMessageRepository) satisfies
 * this interface via TypeScript structural typing.
 *
 * All methods are synchronous — better-sqlite3 is a synchronous API.
 *
 * Return types use plain data structures (not @pcc/a2a types) to keep this
 * interface portable. PersistentMessageBus reconstructs A2AMessage objects
 * from the returned data.
 */

/** Data written to the store for each message */
export interface A2AMessagePersistedData {
  id: string;
  conversationId: string;
  fromAgentId: string;
  toAgentId: string;
  /** Optional reference to a prior message. Null when not set (SQLite nullability). */
  inReplyTo?: string | null;
  intentType: string;
  intentPayload: Record<string, unknown>;
  /** 1 if encrypted, 0 if plaintext */
  isEncrypted: number;
  /** Present when isEncrypted=1. Null otherwise. */
  encryptedEnvelope?: Record<string, unknown> | null;
  /** Sender wallet signature. Null when not present. */
  signature?: string | null;
  timestamp: string;
  persistedAt: string;
}

/** Data written to the store for each conversation upsert */
export interface A2AConversationPersistedData {
  id: string;
  participants: string[];
  status: string;
  topic: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MessagePersistence {
  /** Persist a single message. Synchronous (better-sqlite3). Returns void. */
  persistMessage(msg: A2AMessagePersistedData): void;

  /** Upsert conversation aggregate. Synchronous. */
  upsertConversation(conv: A2AConversationPersistedData): void;

  /**
   * Get all persisted messages for a conversation ID, in chronological order.
   * Returns raw persisted data rows (not A2AMessage objects).
   */
  getConversation(conversationId: string): A2AMessagePersistedData[];

  /**
   * Get messages at or after the given ISO-8601 timestamp.
   * Optional limit defaults to 500.
   */
  getMessagesAfter(timestamp: string, limit?: number): A2AMessagePersistedData[];

  /**
   * Get the N most recent messages, newest first.
   */
  getRecentMessages(limit: number): A2AMessagePersistedData[];

  /**
   * Get messages for a specific agent (as sender or recipient).
   */
  getMessagesByAgent(agentId: string, limit?: number): A2AMessagePersistedData[];

  /**
   * Get conversation IDs ordered by most-recently-updated.
   */
  getConversationIds(limit?: number): string[];
}
