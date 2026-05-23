/**
 * NATSJetStreamBackend — placeholder. Implemented in Task 2.
 */

import type { A2AMessage } from "../types.js";
import type {
  MessageBusBackend,
  BackendMessageHandler,
  BackendSubscription,
} from "./backend.js";

export interface NATSJetStreamBackendOptions {
  url: string;
  streamName: string;
  durableName?: string;
}

export class NATSJetStreamBackend implements MessageBusBackend {
  readonly name = "nats";
  constructor(_opts: NATSJetStreamBackendOptions) {
    throw new Error("NATSJetStreamBackend: not yet implemented (Task 2)");
  }
  async publish(_subject: string, _message: A2AMessage): Promise<void> {
    throw new Error("not implemented");
  }
  async subscribe(
    _subject: string,
    _handler: BackendMessageHandler,
  ): Promise<BackendSubscription> {
    throw new Error("not implemented");
  }
  async close(): Promise<void> {
    /* no-op */
  }
}
