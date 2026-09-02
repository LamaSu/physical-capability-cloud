/**
 * OrgBus — thin wrapper over `@pcc/a2a`'s message-bus backend, publishing
 * `org.*` subjects for the coordination Brain.
 *
 * `@pcc/a2a`'s `Intent` union (packages/a2a/src/types.ts) is a closed,
 * versioned protocol contract — this package is additive-only and must not
 * edit it. So rather than inventing a new Intent variant, OrgBus carries its
 * own `{ subject, payload }` envelope inside the existing `TextMessageIntent`
 * (`{ type: "text_message", text: string }`), JSON-encoded. This is the same
 * "generic passthrough" role `text_message` already plays in the protocol;
 * no changes to @pcc/a2a are needed.
 *
 * Backend selection reuses `@pcc/a2a`'s own `createBackendFromEnv()` — the
 * in-memory backend by default, or NATS JetStream when
 * `PCC_MESSAGE_BUS_BACKEND=nats` is set (same env contract a2a's own
 * MessageBus uses). Tests should inject `new InMemoryBackend()` explicitly
 * for determinism.
 */

import { randomUUID } from "node:crypto";
import {
  InMemoryBackend,
  createBackendFromEnv,
  type A2AMessage,
  type MessageBusBackend,
} from "@pcc/a2a";

export interface OrgEvent<T = unknown> {
  subject: string;
  payload: T;
  occurredAt: string;
}

export type OrgEventHandler<T = unknown> = (event: OrgEvent<T>) => void | Promise<void>;

export type OrgBusUnsubscribe = () => Promise<void>;

export const ORG_BUS_FROM = "pcc-coordination-brain";
const ORG_BUS_TO = "org-bus";

function isTextMessage(intent: A2AMessage["intent"]): intent is { type: "text_message"; text: string } {
  return intent.type === "text_message";
}

export class OrgBus {
  private readonly backendPromise: Promise<MessageBusBackend>;

  constructor(backend?: MessageBusBackend) {
    this.backendPromise = backend ? Promise.resolve(backend) : createBackendFromEnv();
  }

  /** Convenience factory for tests / single-process deployments. */
  static withInMemoryBackend(): OrgBus {
    return new OrgBus(new InMemoryBackend());
  }

  async publish<T>(subject: string, payload: T): Promise<void> {
    const backend = await this.backendPromise;
    const message: A2AMessage = {
      id: randomUUID(),
      conversationId: `org-bus:${subject}`,
      from: ORG_BUS_FROM,
      to: ORG_BUS_TO,
      intent: { type: "text_message", text: JSON.stringify({ subject, payload }) },
      timestamp: new Date().toISOString(),
    };
    await backend.publish(subject, message);
  }

  async subscribe<T>(subject: string, handler: OrgEventHandler<T>): Promise<OrgBusUnsubscribe> {
    const backend = await this.backendPromise;
    const sub = await backend.subscribe(subject, async (message) => {
      if (!isTextMessage(message.intent)) return;
      let decoded: { subject: string; payload: T };
      try {
        decoded = JSON.parse(message.intent.text) as { subject: string; payload: T };
      } catch {
        return; // not one of ours — ignore rather than throw on a shared subject
      }
      await handler({ subject: decoded.subject, payload: decoded.payload, occurredAt: message.timestamp });
    });
    return () => sub.unsubscribe();
  }

  async close(): Promise<void> {
    const backend = await this.backendPromise;
    await backend.close();
  }
}

// ── org.* subject constants ─────────────────────────────────────────────

export const ORG_SUBJECTS = {
  SNAPSHOT_TAKEN: "org.snapshot.taken",
  QUEUE_ITEM_ENQUEUED: "org.queue.item.enqueued",
  QUEUE_ITEM_APPROVED: "org.queue.item.approved",
  WORKFLOW_DISPATCHED: "org.workflow.dispatched",
  WORKFLOW_COMPLETED: "org.workflow.completed",
} as const;
