import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * A2A message event log — append-only, never updated.
 * Each row is one A2AMessage sent through the bus.
 */
export const a2aMessages = sqliteTable("a2a_messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  fromAgentId: text("from_agent_id").notNull(),
  toAgentId: text("to_agent_id").notNull(),
  inReplyTo: text("in_reply_to"),

  /** The discriminant field of the intent (e.g. "text_message", "request_quote") */
  intentType: text("intent_type").notNull(),
  /** Full intent JSON */
  intentPayload: text("intent_payload", { mode: "json" }).notNull().$type<Record<string, unknown>>(),

  /** 1 if A2AMessage.encrypted is set, 0 otherwise */
  isEncrypted: integer("is_encrypted").notNull().default(0),
  /** JSON of A2AMessage.encrypted (NaCl EncryptedEnvelope), null if not encrypted */
  encryptedEnvelope: text("encrypted_envelope", { mode: "json" }).$type<Record<string, unknown>>(),

  /** A2AMessage.signature — sender wallet signature, nullable */
  signature: text("signature"),

  /** A2AMessage.timestamp — ISO-8601 string from the sender */
  timestamp: text("timestamp").notNull(),
  /** Wall-clock time when this row was written to the DB */
  persistedAt: text("persisted_at").notNull(),
});

/**
 * A2A conversation aggregate — upserted on every message.
 * Provides O(1) conversation lookup without scanning messages.
 */
export const a2aConversations = sqliteTable("a2a_conversations", {
  id: text("id").primaryKey(),
  /** JSON string[] of agent IDs */
  participants: text("participants", { mode: "json" }).notNull().$type<string[]>(),
  status: text("status").notNull().default("active"),
  /** First message's intent.type */
  topic: text("topic").notNull(),
  messageCount: integer("message_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
