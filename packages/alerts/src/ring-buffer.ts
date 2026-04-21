/**
 * Fixed-size ring buffer for recent Alert records.
 *
 * Pure in-memory. On restart the history is lost — intentional for v1, since
 * persistence (database / external sink) is a deployment concern and belongs
 * in a notifier, not core.
 *
 * Author: implementer-alpha
 */

import type { Alert } from "./types.js";

export class AlertRingBuffer {
  private readonly buffer: Alert[];
  private nextIndex = 0;
  private filled = false;

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`AlertRingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.buffer = new Array<Alert>(capacity);
  }

  push(alert: Alert): void {
    this.buffer[this.nextIndex] = alert;
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
    if (this.nextIndex === 0) this.filled = true;
  }

  /** Return the last N alerts, newest first. */
  recent(limit: number): Alert[] {
    const total = this.filled ? this.capacity : this.nextIndex;
    const out: Alert[] = [];
    const max = Math.min(limit, total);
    for (let i = 0; i < max; i++) {
      // Walk backwards from nextIndex-1.
      const idx = (this.nextIndex - 1 - i + this.capacity) % this.capacity;
      const entry = this.buffer[idx];
      if (entry) out.push(entry);
    }
    return out;
  }

  size(): number {
    return this.filled ? this.capacity : this.nextIndex;
  }
}
