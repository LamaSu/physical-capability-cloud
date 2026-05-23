/**
 * Backend selection and the standard subject helper.
 *
 * Subject scheme: `pcc.a2a.<intent-type>` — chosen so a JetStream stream
 * defined with subject `pcc.a2a.>` captures every A2A intent without per-
 * intent stream config.
 */

import type { MessageBusBackend } from "./backend.js";
import { InMemoryBackend } from "./in-memory-backend.js";

export type { MessageBusBackend, BackendMessageHandler, BackendSubscription } from "./backend.js";
export { InMemoryBackend } from "./in-memory-backend.js";

/** Build the canonical subject for a given intent type */
export function subjectFor(intentType: string): string {
  return `pcc.a2a.${intentType}`;
}

/** All A2A subjects, useful as a wildcard subscription */
export const ALL_A2A_SUBJECTS = "pcc.a2a.>";

/**
 * Select a backend from environment variables.
 *
 * `PCC_MESSAGE_BUS_BACKEND` selects: `memory` (default) | `nats`.
 *
 * Returns the backend instance. The actual NATS module is lazy-loaded so
 * that consumers using the default `memory` backend don't pay the import
 * cost.
 */
export async function createBackendFromEnv(): Promise<MessageBusBackend> {
  const choice = (process.env.PCC_MESSAGE_BUS_BACKEND ?? "memory").toLowerCase();
  if (choice === "memory") return new InMemoryBackend();
  if (choice === "nats") {
    // Lazy import — only pay the cost when nats is actually selected.
    const { NATSJetStreamBackend } = await import("./nats-jetstream-backend.js");
    return new NATSJetStreamBackend({
      url: process.env.NATS_URL ?? "nats://localhost:4222",
      streamName: process.env.NATS_STREAM_NAME ?? "PCC_A2A",
      durableName: process.env.NATS_DURABLE_NAME,
    });
  }
  throw new Error(
    `PCC_MESSAGE_BUS_BACKEND='${choice}' is not a known backend (memory|nats)`,
  );
}
