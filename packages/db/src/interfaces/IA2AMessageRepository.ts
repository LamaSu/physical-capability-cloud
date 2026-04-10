import type { a2aMessages, a2aConversations } from "../schema/index.js";

export type A2AMessageRow = typeof a2aMessages.$inferSelect;
export type A2AMessageInsert = typeof a2aMessages.$inferInsert;
export type A2AConversationRow = typeof a2aConversations.$inferSelect;
export type A2AConversationInsert = typeof a2aConversations.$inferInsert;

export interface IA2AMessageRepository {
  // Write
  persistMessage(msg: A2AMessageInsert): void;
  upsertConversation(conv: A2AConversationInsert): void;
  // Read — MessagePersistence-compatible interface methods
  getConversation(conversationId: string): A2AMessageRow[];
  getMessagesAfter(timestamp: string, limit?: number): A2AMessageRow[];
  getRecentMessages(limit: number): A2AMessageRow[];
  getMessagesByAgent(agentId: string, limit?: number): A2AMessageRow[];
  getConversationIds(limit?: number): string[];
  // Extended read methods
  getMessagesAfterFiltered(
    timestamp: string,
    opts?: { agentId?: string; limit?: number },
  ): A2AMessageRow[];
  getMessagesAfterCursor(
    afterMessageId: string,
    opts?: { conversationId?: string; limit?: number },
  ): A2AMessageRow[];
  getConversationAggregate(id: string): A2AConversationRow | undefined;
  getConversationsForAgent(agentId: string): A2AConversationRow[];
  getAllConversations(limit?: number): A2AConversationRow[];
  // Retention
  pruneMessagesBefore(timestamp: string): number;
}
