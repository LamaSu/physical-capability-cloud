/**
 * PersistentMessageBus — extends MessageBus with SQLite-backed persistence.
 *
 * Drop-in replacement for MessageBus. The in-memory bus handles real-time
 * delivery; the persistence layer handles recovery after process restart.
 *
 * Architecture:
 * - send() persists AFTER successful security scan and in-memory delivery
 * - broadcast() persists the original message AFTER delivery (not each copy)
 * - rehydrate() loads conversations from DB into in-memory cache on startup
 *   via the protected _seedConversation() method — no handlers are invoked
 * - Persistence failures never block message delivery (errors are logged only)
 *
 * The MessagePersistence interface is satisfied by A2AMessageRepository from
 * @pcc/store via structural typing. PersistentMessageBus has zero direct
 * dependency on @pcc/store.
 */

import type { A2AMessage, Conversation } from "./types.js";
import { MessageBus } from "./message-bus.js";
import type { MessagePersistence, A2AMessagePersistedData } from "./persistence.js";

/** Convert a raw persisted data row back into a full A2AMessage object */
function rowToA2AMessage(row: A2AMessagePersistedData): A2AMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    from: row.fromAgentId,
    to: row.toAgentId,
    // intentPayload is stored as-is from the original message.intent —
    // the shape is always a valid Intent; use double cast via unknown.
    intent: row.intentPayload as unknown as A2AMessage["intent"],
    timestamp: row.timestamp,
    ...(row.inReplyTo != null && row.inReplyTo !== undefined ? { inReplyTo: row.inReplyTo } : {}),
    ...(row.signature != null && row.signature !== undefined ? { signature: row.signature } : {}),
    ...(row.isEncrypted && row.encryptedEnvelope != null && row.encryptedEnvelope !== undefined
      ? { encrypted: row.encryptedEnvelope as unknown as A2AMessage["encrypted"] }
      : {}),
  };
}

export class PersistentMessageBus extends MessageBus {
  /**
   * @param persistence - Optional persistence layer. When omitted, the bus
   * behaves exactly like the base MessageBus (graceful degradation).
   */
  constructor(private persistence?: MessagePersistence) {
    super();
  }

  /**
   * Warm the in-memory conversation cache from persisted storage.
   *
   * Call once at startup, after registering agents but before serving traffic.
   * Loads messages from the last 7 days (or the provided sinceTimestamp) and
   * seeds them into conversations WITHOUT dispatching to any handlers.
   *
   * Idempotent — safe to call multiple times.
   */
  async rehydrate(sinceTimestamp?: string): Promise<void> {
    if (!this.persistence) return;

    const since =
      sinceTimestamp ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    let rows: A2AMessagePersistedData[];
    try {
      rows = this.persistence.getMessagesAfter(since);
    } catch (err) {
      console.error("[PersistentMessageBus] rehydrate: failed to load messages:", err);
      return;
    }

    // Group messages by conversationId so we can seed each conversation at once
    const byConversation = new Map<string, A2AMessage[]>();
    for (const row of rows) {
      const msg = rowToA2AMessage(row);
      const msgs = byConversation.get(row.conversationId) ?? [];
      msgs.push(msg);
      byConversation.set(row.conversationId, msgs);
    }

    // Seed each conversation into the in-memory cache (no handler dispatch)
    for (const [conversationId, messages] of byConversation) {
      this._seedConversation(conversationId, messages);
    }

    console.log(
      `[PersistentMessageBus] rehydrated ${rows.length} messages across ${byConversation.size} conversations`,
    );
  }

  /**
   * Send a message. Persists to SQLite after successful in-memory delivery.
   * If the security scan throws, the message is never persisted (correct —
   * only clean messages that pass scanning should be stored).
   */
  override async send(message: A2AMessage): Promise<void> {
    // Delegate to base class: security scan → conversation tracking → handler dispatch
    await super.send(message);
    // Persist after successful delivery — never persists if security throws
    this._persist(message);
  }

  /**
   * Broadcast a message to matching agents. Persists the original message
   * (not the per-recipient copies) after delivery.
   */
  override async broadcast(message: A2AMessage, role?: string): Promise<void> {
    await super.broadcast(message, role);
    this._persist(message);
  }

  // ── Replay API ────────────────────────────────────────────────────────

  /**
   * Get all persisted messages in a conversation (survives process restart).
   * Falls back to in-memory getConversation() when no persistence is configured.
   */
  getPersistedConversation(conversationId: string): A2AMessage[] {
    if (!this.persistence) {
      return this.getConversation(conversationId)?.messages ?? [];
    }
    return this.persistence.getConversation(conversationId).map(rowToA2AMessage);
  }

  /**
   * Replay messages from a checkpoint timestamp (inclusive).
   * Optionally filter to messages involving a specific agent.
   * Falls back to empty array when no persistence is configured.
   */
  getMessagesAfterTimestamp(
    timestamp: string,
    opts?: { limit?: number },
  ): A2AMessage[] {
    if (!this.persistence) return [];
    return this.persistence.getMessagesAfter(timestamp, opts?.limit).map(rowToA2AMessage);
  }

  /**
   * Get the N most recent persisted messages, newest first.
   * Prefers persisted data (accurate after restart); falls back to in-memory.
   */
  getRecentPersistedMessages(limit: number): A2AMessage[] {
    if (!this.persistence) {
      // Fall back to the in-memory approach (flatten all conversations)
      const all: A2AMessage[] = [];
      for (const card of this.findAgents()) {
        for (const conv of this.getConversationsFor(card.id)) {
          all.push(...conv.messages);
        }
      }
      const seen = new Set<string>();
      return all
        .filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        })
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, limit);
    }
    return this.persistence.getRecentMessages(limit).map(rowToA2AMessage);
  }

  /**
   * Get persisted conversations for all agents (DB-backed, survives restart).
   */
  getAllPersistedConversationIds(limit?: number): string[] {
    if (!this.persistence) return [];
    return this.persistence.getConversationIds(limit);
  }

  // ── Private helpers ───────────────────────────────────────────────────

  /**
   * Persist a single message to the storage layer.
   * Persistence errors are caught and logged — they must NEVER block delivery.
   */
  private _persist(message: A2AMessage): void {
    if (!this.persistence) return;

    const now = new Date().toISOString();
    try {
      this.persistence.persistMessage({
        id: message.id,
        conversationId: message.conversationId,
        fromAgentId: message.from,
        toAgentId: message.to,
        inReplyTo: message.inReplyTo,
        intentType: message.intent.type,
        intentPayload: message.intent as unknown as Record<string, unknown>,
        isEncrypted: message.encrypted ? 1 : 0,
        encryptedEnvelope: message.encrypted as Record<string, unknown> | undefined,
        signature: message.signature,
        timestamp: message.timestamp,
        persistedAt: now,
      });

      // Upsert the conversation aggregate so it stays consistent
      const conv: Conversation | undefined = this.getConversation(message.conversationId);
      if (conv) {
        this.persistence.upsertConversation({
          id: conv.id,
          participants: conv.participants,
          status: conv.status,
          topic: conv.topic,
          messageCount: conv.messages.length,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
        });
      }
    } catch (err) {
      console.error("[PersistentMessageBus] persist error (delivery not affected):", err);
    }
  }
}
