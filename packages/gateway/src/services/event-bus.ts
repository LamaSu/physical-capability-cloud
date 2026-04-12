// packages/gateway/src/services/event-bus.ts
//
// In-process event bus that emits structured, hash-chained analytics events
// when mutations happen across the PCC gateway.
//
// This is the foundation for the unified analytics layer — route handlers
// can call getEventBus().publish(...) after any mutation to record it in
// the hash-chained audit trail.
//
// Usage:
//   import { getEventBus } from "../services/event-bus.js";
//
//   const event = getEventBus().publish({
//     eventType: "template.published",
//     category: "template",
//     actorId: operatorId,
//     actorType: "operator",
//     resourceType: "capability_template",
//     resourceId: templateId,
//   });
//
// Listeners:
//   getEventBus().onEvent((event) => { ... });

import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import type { AnalyticsEvent, AnalyticsEventCategory, SHA256 } from "@pcc/spec";

class PCCEventBus extends EventEmitter {
  private lastHash: string = "genesis";

  /** Emit a structured analytics event with hash-chain integrity */
  publish(opts: {
    eventType: string;
    category: AnalyticsEventCategory;
    actorId: string;
    actorType: "operator" | "requestor" | "verifier" | "agent" | "system";
    resourceType: string;
    resourceId: string;
    payload?: Record<string, unknown>;
  }): AnalyticsEvent {
    const event: AnalyticsEvent = {
      id: randomUUID(),
      eventType: opts.eventType,
      category: opts.category,
      timestamp: new Date().toISOString(),
      actorId: opts.actorId,
      actorType: opts.actorType,
      resourceType: opts.resourceType,
      resourceId: opts.resourceId,
      payload: opts.payload ?? {},
      hash: "sha256:" as SHA256, // computed below
      previousHash: this.lastHash as SHA256 | undefined,
    };

    // Compute SHA-256 hash over deterministic subset for integrity chain
    const hashInput = JSON.stringify({
      id: event.id,
      eventType: event.eventType,
      timestamp: event.timestamp,
      actorId: event.actorId,
      resourceId: event.resourceId,
      previousHash: event.previousHash,
    });
    event.hash = `sha256:${createHash("sha256").update(hashInput).digest("hex")}` as SHA256;
    this.lastHash = event.hash;

    // Emit for all subscribers (analytics service, audit trail, SSE, etc.)
    super.emit("analytics", event);
    return event;
  }

  /** Subscribe to all analytics events */
  onEvent(handler: (event: AnalyticsEvent) => void): void {
    this.on("analytics", handler);
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _eventBus: PCCEventBus | null = null;

/** Returns the singleton event bus, creating it on first call. */
export function getEventBus(): PCCEventBus {
  if (!_eventBus) _eventBus = new PCCEventBus();
  return _eventBus;
}

/**
 * Destroys the singleton event bus and removes all listeners.
 * Used in tests to reset state between test cases.
 */
export function resetEventBus(): void {
  _eventBus?.removeAllListeners();
  _eventBus = null;
}
