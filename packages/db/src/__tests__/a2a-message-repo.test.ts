import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store, type IA2AMessageRepository } from "../index.js";
import { A2AMessageRepository } from "../repositories/a2a-messages.js";
import type { A2AMessageInsert } from "../interfaces/IA2AMessageRepository.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<A2AMessageInsert> = {}) {
  const now = new Date().toISOString();
  return {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    conversationId: "conv-abc",
    fromAgentId: "agent-alice",
    toAgentId: "agent-bob",
    intentType: "text_message",
    intentPayload: { type: "text_message", text: "hello" } as Record<string, unknown>,
    isEncrypted: 0 as 0 | 1,
    timestamp: now,
    persistedAt: now,
    ...overrides,
  };
}

function makeConvRow(overrides: Partial<{
  id: string;
  participants: string[];
  status: string;
  topic: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}> = {}) {
  const now = new Date().toISOString();
  return {
    id: "conv-abc",
    participants: ["agent-alice", "agent-bob"],
    status: "active",
    topic: "text_message",
    messageCount: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("A2AMessageRepository", () => {
  let store: Store;
  let repo: IA2AMessageRepository;

  beforeEach(() => {
    store = createStore({ seed: false });
    repo = store.repos.a2aMessages;
  });

  afterEach(() => {
    store.close();
  });

  // ── Table creation ─────────────────────────────────────────────────────────

  describe("table creation", () => {
    it("a2a_messages table exists after createStore", () => {
      expect(() => {
        repo.persistMessage(makeRow());
      }).not.toThrow();
    });

    it("a2a_conversations table exists after createStore", () => {
      expect(() => {
        repo.upsertConversation(makeConvRow());
      }).not.toThrow();
    });
  });

  // ── persistMessage ─────────────────────────────────────────────────────────

  describe("persistMessage", () => {
    it("inserts a message row", () => {
      const msg = makeRow({ id: "msg-001" });
      repo.persistMessage(msg);

      const rows = repo.getRecentMessages(10);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe("msg-001");
    });

    it("is idempotent — duplicate inserts are silently ignored", () => {
      const msg = makeRow({ id: "msg-dup" });
      repo.persistMessage(msg);
      repo.persistMessage(msg); // second insert with same PK

      const rows = repo.getRecentMessages(10);
      expect(rows).toHaveLength(1);
    });

    it("stores intent payload as JSON", () => {
      const payload = { type: "request_quote", capabilityType: "fdm", assuranceTier: 1 };
      const msg = makeRow({ id: "msg-payload", intentPayload: payload as Record<string, unknown> });
      repo.persistMessage(msg);

      const rows = repo.getRecentMessages(10);
      expect(rows[0].intentPayload).toEqual(payload);
    });

    it("stores encrypted_envelope when isEncrypted=1", () => {
      const envelope = { nonce: "abc123", ciphertext: "deadbeef" };
      const msg = makeRow({
        id: "msg-enc",
        isEncrypted: 1 as 1,
        encryptedEnvelope: envelope as Record<string, unknown>,
      });
      repo.persistMessage(msg);

      const rows = repo.getRecentMessages(10);
      expect(rows[0].isEncrypted).toBe(1);
      expect(rows[0].encryptedEnvelope).toEqual(envelope);
    });

    it("stores optional fields: inReplyTo and signature", () => {
      const msg = makeRow({
        id: "msg-full",
        inReplyTo: "msg-000",
        signature: "0xsig123",
      });
      repo.persistMessage(msg);

      const rows = repo.getRecentMessages(10);
      expect(rows[0].inReplyTo).toBe("msg-000");
      expect(rows[0].signature).toBe("0xsig123");
    });
  });

  // ── getConversation ────────────────────────────────────────────────────────

  describe("getConversation", () => {
    it("returns messages for a conversation in chronological order", () => {
      const base = Date.now();
      repo.persistMessage(makeRow({ id: "m3", conversationId: "conv-1", timestamp: new Date(base + 2).toISOString() }));
      repo.persistMessage(makeRow({ id: "m1", conversationId: "conv-1", timestamp: new Date(base + 0).toISOString() }));
      repo.persistMessage(makeRow({ id: "m2", conversationId: "conv-1", timestamp: new Date(base + 1).toISOString() }));
      repo.persistMessage(makeRow({ id: "mx", conversationId: "other-conv" }));

      const msgs = repo.getConversation("conv-1");
      expect(msgs).toHaveLength(3);
      expect(msgs.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    });

    it("returns empty array for unknown conversation", () => {
      expect(repo.getConversation("no-such-conv")).toEqual([]);
    });
  });

  // ── getMessagesAfter ───────────────────────────────────────────────────────

  describe("getMessagesAfter", () => {
    it("returns only messages at or after the given timestamp", () => {
      const base = new Date("2026-01-01T12:00:00.000Z");
      const t0 = new Date(base.getTime() + 0).toISOString();
      const t1 = new Date(base.getTime() + 1000).toISOString();
      const t2 = new Date(base.getTime() + 2000).toISOString();

      repo.persistMessage(makeRow({ id: "m-early", timestamp: t0 }));
      repo.persistMessage(makeRow({ id: "m-mid", timestamp: t1 }));
      repo.persistMessage(makeRow({ id: "m-late", timestamp: t2 }));

      const results = repo.getMessagesAfter(t1);
      expect(results.map((m) => m.id)).toContain("m-mid");
      expect(results.map((m) => m.id)).toContain("m-late");
      expect(results.map((m) => m.id)).not.toContain("m-early");
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        repo.persistMessage(makeRow({ id: `bulk-${i}` }));
      }
      const results = repo.getMessagesAfter(new Date(0).toISOString(), 3);
      expect(results).toHaveLength(3);
    });
  });

  // ── getRecentMessages ──────────────────────────────────────────────────────

  describe("getRecentMessages", () => {
    it("returns N most recent messages, newest first", () => {
      const base = Date.now();
      repo.persistMessage(makeRow({ id: "oldest", timestamp: new Date(base - 2000).toISOString() }));
      repo.persistMessage(makeRow({ id: "middle", timestamp: new Date(base - 1000).toISOString() }));
      repo.persistMessage(makeRow({ id: "newest", timestamp: new Date(base).toISOString() }));

      const results = repo.getRecentMessages(2);
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe("newest");
      expect(results[1].id).toBe("middle");
    });

    it("returns all messages when limit > count", () => {
      repo.persistMessage(makeRow({ id: "a" }));
      repo.persistMessage(makeRow({ id: "b" }));

      expect(repo.getRecentMessages(100)).toHaveLength(2);
    });
  });

  // ── getMessagesByAgent ─────────────────────────────────────────────────────

  describe("getMessagesByAgent", () => {
    it("returns messages where agent is sender or recipient", () => {
      repo.persistMessage(makeRow({ id: "from-alice", fromAgentId: "alice", toAgentId: "carol" }));
      repo.persistMessage(makeRow({ id: "to-alice", fromAgentId: "bob", toAgentId: "alice" }));
      repo.persistMessage(makeRow({ id: "unrelated", fromAgentId: "bob", toAgentId: "carol" }));

      const results = repo.getMessagesByAgent("alice");
      const ids = results.map((m) => m.id);
      expect(ids).toContain("from-alice");
      expect(ids).toContain("to-alice");
      expect(ids).not.toContain("unrelated");
    });
  });

  // ── upsertConversation + getConversationIds ────────────────────────────────

  describe("upsertConversation", () => {
    it("inserts a new conversation aggregate", () => {
      const conv = makeConvRow({ id: "conv-new" });
      repo.upsertConversation(conv);

      const ids = repo.getConversationIds();
      expect(ids).toContain("conv-new");
    });

    it("updates existing conversation aggregate on conflict", () => {
      const conv = makeConvRow({ id: "conv-upsert", messageCount: 1 });
      repo.upsertConversation(conv);

      const updated = makeConvRow({ id: "conv-upsert", messageCount: 5 });
      repo.upsertConversation(updated);

      const agg = repo.getConversationAggregate("conv-upsert");
      expect(agg?.messageCount).toBe(5);
    });
  });

  // ── getConversationIds ─────────────────────────────────────────────────────

  describe("getConversationIds", () => {
    it("returns IDs ordered by updated_at descending", () => {
      const base = Date.now();
      repo.upsertConversation(makeConvRow({ id: "conv-a", updatedAt: new Date(base + 1000).toISOString() }));
      repo.upsertConversation(makeConvRow({ id: "conv-b", updatedAt: new Date(base + 2000).toISOString() }));
      repo.upsertConversation(makeConvRow({ id: "conv-c", updatedAt: new Date(base + 500).toISOString() }));

      const ids = repo.getConversationIds();
      expect(ids[0]).toBe("conv-b");
      expect(ids[1]).toBe("conv-a");
      expect(ids[2]).toBe("conv-c");
    });

    it("respects the limit", () => {
      for (let i = 0; i < 5; i++) {
        repo.upsertConversation(makeConvRow({ id: `conv-${i}` }));
      }
      expect(repo.getConversationIds(3)).toHaveLength(3);
    });
  });

  // ── pruneMessagesBefore ────────────────────────────────────────────────────

  describe("pruneMessagesBefore", () => {
    it("deletes messages at or before the cutoff timestamp", () => {
      const base = new Date("2026-01-10T00:00:00.000Z");
      const old1 = new Date(base.getTime() - 2000).toISOString();
      const old2 = new Date(base.getTime() - 1000).toISOString();
      const cutoff = base.toISOString();
      const recent = new Date(base.getTime() + 1000).toISOString();

      repo.persistMessage(makeRow({ id: "old-1", timestamp: old1 }));
      repo.persistMessage(makeRow({ id: "old-2", timestamp: old2 }));
      repo.persistMessage(makeRow({ id: "keep", timestamp: recent }));

      const deleted = repo.pruneMessagesBefore(cutoff);
      expect(deleted).toBe(2);

      const remaining = repo.getRecentMessages(100);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe("keep");
    });

    it("returns 0 when no messages fall before the cutoff", () => {
      repo.persistMessage(makeRow({ id: "future", timestamp: new Date(Date.now() + 99999).toISOString() }));
      const deleted = repo.pruneMessagesBefore(new Date(0).toISOString());
      expect(deleted).toBe(0);
    });
  });

  // ── buildRepositories wiring ────────────────────────────────────────────────

  describe("buildRepositories integration", () => {
    it("a2aMessages is accessible via store.repos.a2aMessages", () => {
      expect(store.repos.a2aMessages).toBeInstanceOf(A2AMessageRepository);
    });
  });
});
