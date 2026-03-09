/**
 * StreamHub — topic-based event routing for real-time sensor/batch/log streaming.
 *
 * Subscribers register for specific topics (job, kernel, device, batch, global)
 * and receive events published to those topics. Includes a bounded replay buffer
 * for Last-Event-ID resume support.
 */

import type { StreamTopic } from "@pcc/spec";

export interface StreamEvent {
  id: string;
  type: string;
  timestamp: string;
  topic: StreamTopic;
  payload: unknown;
}

type StreamCallback = (event: StreamEvent) => void;

const DEFAULT_REPLAY_CAPACITY = 500;

export class StreamHub {
  private subscriptions = new Map<string, Set<StreamCallback>>();
  private replayBuffers = new Map<string, StreamEvent[]>();
  private replayCapacity: number;

  constructor(replayCapacity = DEFAULT_REPLAY_CAPACITY) {
    this.replayCapacity = replayCapacity;
  }

  static topicKey(topic: StreamTopic): string {
    return `${topic.type}:${topic.id}`;
  }

  /**
   * Subscribe to one or more topics. Returns an unsubscribe function.
   * If lastEventId is provided, replays missed events before switching to live.
   */
  subscribe(
    topics: StreamTopic[],
    callback: StreamCallback,
    lastEventId?: string,
  ): () => void {
    // Replay missed events if lastEventId provided
    if (lastEventId) {
      for (const topic of topics) {
        const key = StreamHub.topicKey(topic);
        const buffer = this.replayBuffers.get(key);
        if (buffer) {
          const idx = buffer.findIndex((e) => e.id === lastEventId);
          const startIdx = idx >= 0 ? idx + 1 : 0;
          for (let i = startIdx; i < buffer.length; i++) {
            try { callback(buffer[i]); } catch { /* ignore */ }
          }
        }
      }
    }

    for (const topic of topics) {
      const key = StreamHub.topicKey(topic);
      let subs = this.subscriptions.get(key);
      if (!subs) {
        subs = new Set();
        this.subscriptions.set(key, subs);
      }
      subs.add(callback);
    }

    return () => {
      for (const topic of topics) {
        const key = StreamHub.topicKey(topic);
        const subs = this.subscriptions.get(key);
        if (subs) {
          subs.delete(callback);
          if (subs.size === 0) {
            this.subscriptions.delete(key);
          }
        }
      }
    };
  }

  /** Publish an event to one or more topics + always to global. */
  publish(topics: StreamTopic[], event: StreamEvent): void {
    const notified = new Set<StreamCallback>();

    // Always include global
    const allTopics = [...topics];
    if (!allTopics.some((t) => t.type === "global")) {
      allTopics.push({ type: "global", id: "*" });
    }

    for (const topic of allTopics) {
      const key = StreamHub.topicKey(topic);

      // Store in replay buffer
      let buffer = this.replayBuffers.get(key);
      if (!buffer) {
        buffer = [];
        this.replayBuffers.set(key, buffer);
      }
      buffer.push(event);
      if (buffer.length > this.replayCapacity) {
        buffer.shift();
      }

      // Notify live subscribers
      const subs = this.subscriptions.get(key);
      if (subs) {
        for (const cb of subs) {
          if (!notified.has(cb)) {
            notified.add(cb);
            try {
              cb(event);
            } catch {
              // Ignore callback errors
            }
          }
        }
      }
    }
  }

  /** Get subscriber count for a specific topic, or all topics. */
  getSubscriberCount(topic?: StreamTopic): number {
    if (topic) {
      return this.subscriptions.get(StreamHub.topicKey(topic))?.size ?? 0;
    }
    let total = 0;
    for (const subs of this.subscriptions.values()) {
      total += subs.size;
    }
    return total;
  }

  /** Get replay buffer size for a topic. */
  getBufferSize(topic: StreamTopic): number {
    return this.replayBuffers.get(StreamHub.topicKey(topic))?.length ?? 0;
  }
}

/** Singleton hub instance shared across the gateway */
export const streamHub = new StreamHub();
