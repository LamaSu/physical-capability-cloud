/**
 * InMemoryBackend — the default backend used by MessageBus. Pure in-process
 * pub/sub via a Map<subject, handlers[]>. Identical semantics to the original
 * MessageBus.send() inner dispatch loop.
 *
 * NOT suitable for cross-process delivery — for that, use NATSJetStreamBackend
 * or wrap NetworkedBus.
 */

import type { A2AMessage } from "../types.js";
import type {
  MessageBusBackend,
  BackendMessageHandler,
  BackendSubscription,
} from "./backend.js";

export class InMemoryBackend implements MessageBusBackend {
  readonly name = "memory";

  private handlers: Map<string, BackendMessageHandler[]> = new Map();
  private closed = false;

  async publish(subject: string, message: A2AMessage): Promise<void> {
    if (this.closed) throw new Error("InMemoryBackend: publish after close");
    const list = this.handlers.get(subject) ?? [];
    // Sequential await — matches existing MessageBus semantics (handlers run
    // in registration order, errors caught by the bus layer, not here).
    for (const h of list) {
      await h(message);
    }
  }

  async subscribe(
    subject: string,
    handler: BackendMessageHandler,
  ): Promise<BackendSubscription> {
    if (this.closed) throw new Error("InMemoryBackend: subscribe after close");
    const list = this.handlers.get(subject) ?? [];
    list.push(handler);
    this.handlers.set(subject, list);

    return {
      subject,
      unsubscribe: async () => {
        const current = this.handlers.get(subject);
        if (!current) return;
        const idx = current.indexOf(handler);
        if (idx >= 0) current.splice(idx, 1);
        if (current.length === 0) this.handlers.delete(subject);
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
  }
}
