/**
 * StreamHub — topic-based event routing for real-time sensor/batch/log streaming.
 *
 * Subscribers register for specific topics (job, kernel, device, batch, global)
 * and receive events published to those topics. Includes a bounded replay buffer
 * for Last-Event-ID resume support.
 */

import type { StreamTopic } from "@pcc/spec";
import { batchStreamView } from "./batch-stream-projection.js";

export interface StreamEvent {
  id: string;
  type: string;
  timestamp: string;
  topic: StreamTopic;
  payload: unknown;
}

/**
 * Where an event sits in one topic's stream: the topic's key and the event's
 * sequence number on that topic. The hub assigns it at publish, 1, 2, 3, ...
 * per topic, so it says nothing about any other topic and carries nothing the
 * publisher wrote (N49 round 6).
 */
export interface StreamCursor {
  topicKey: string;
  seq: number;
  /** What a cursor stream shows for the event: decided once, at publish, and frozen (round 8). */
  view?: StreamView;
}

/** A frozen event type and payload, as a cursor stream writes them. */
export interface StreamView {
  readonly type: string;
  readonly payload: unknown;
}

type StreamCallback = (event: StreamEvent, cursor?: StreamCursor) => void;

/**
 * Decides, once per event and topic at publish, whether the event gets a cursor
 * on the topic and what a cursor stream shows for it (see the constructor).
 */
export type CursorView = (event: StreamEvent, topic: StreamTopic) => StreamView | null;

export interface SubscribeOptions {
  /**
   * "seq": lastEventId is this hub's own per-topic cursor (StreamCursor.seq, as
   * a decimal string), and replay delivers the topic's buffered events after
   * it. A lastEventId that is not a cursor replays nothing, so a client cannot
   * learn whether some publisher id is in the buffer. Without this option,
   * lastEventId is matched against publisher event ids, as before.
   */
  cursor?: "seq";
}

const DEFAULT_REPLAY_CAPACITY = 500;

/** A cursor as a client sends it back: 1 to 15 decimal digits, so a safe integer. */
const CURSOR_PATTERN = /^[0-9]{1,15}$/;

export class StreamHub {
  private subscriptions = new Map<string, Set<StreamCallback>>();
  // Read directly by routes/visualizer-events.ts (the global topic); its shape stays.
  private replayBuffers = new Map<string, StreamEvent[]>();
  /** Per topic: the last cursor assigned, and the replay window with each event's cursor. */
  private cursors = new Map<string, number>();
  private cursorBuffers = new Map<string, Array<{ seq: number; event: StreamEvent; view?: StreamView }>>();
  private replayCapacity: number;

  /**
   * `cursorView` (N49 rounds 7 and 8) is called ONCE per event and topic, at
   * publish. Null (or a throw) means no cursor: the event is still delivered to
   * subscribers and kept in the publisher-id replay buffer, but it is not
   * numbered and not in the cursor window, so a cursor stream neither shows it
   * nor leaves a gap for it. A view means a cursor, and the frozen view is
   * stored and handed out with it, live and on replay. So the decision to
   * number an event and what a cursor stream writes for it are the same single
   * judgment and cannot disagree. Without a cursorView, every event is numbered
   * with no view.
   */
  constructor(replayCapacity = DEFAULT_REPLAY_CAPACITY, private readonly cursorView?: CursorView) {
    this.replayCapacity = replayCapacity;
  }

  /** The cursor decision for one event on one topic: made once, here. */
  private decide(event: StreamEvent, topic: StreamTopic): { numbered: boolean; view?: StreamView } {
    if (!this.cursorView) return { numbered: true };
    try {
      const view = this.cursorView(event, topic);
      return view ? { numbered: true, view } : { numbered: false };
    } catch {
      return { numbered: false };
    }
  }

  static topicKey(topic: StreamTopic): string {
    return `${topic.type}:${topic.id}`;
  }

  /**
   * Subscribe to one or more topics. Returns an unsubscribe function.
   * If lastEventId is provided, replays missed events before switching to live
   * (see SubscribeOptions for what lastEventId means). Every callback, replayed
   * or live, receives the event's cursor on the topic it came through.
   */
  subscribe(
    topics: StreamTopic[],
    callback: StreamCallback,
    lastEventId?: string,
    options?: SubscribeOptions,
  ): () => void {
    if (options?.cursor === "seq") {
      // Cursor mode: resume after the client's cursor, on each topic's own count.
      if (typeof lastEventId === "string" && CURSOR_PATTERN.test(lastEventId)) {
        const after = Number(lastEventId);
        for (const topic of topics) {
          const key = StreamHub.topicKey(topic);
          for (const entry of this.cursorBuffers.get(key) ?? []) {
            if (entry.seq <= after) continue;
            try { callback(entry.event, { topicKey: key, seq: entry.seq, view: entry.view }); } catch { /* ignore */ }
          }
        }
      }
    } else if (lastEventId) {
      // Publisher-id mode (the original behavior).
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
      let cursor: StreamCursor | undefined;
      const decision = this.decide(event, topic);
      if (decision.numbered) {
        const seq = (this.cursors.get(key) ?? 0) + 1;
        this.cursors.set(key, seq);
        cursor = { topicKey: key, seq, view: decision.view };
        let window = this.cursorBuffers.get(key);
        if (!window) {
          window = [];
          this.cursorBuffers.set(key, window);
        }
        window.push({ seq, event, view: decision.view });
        if (window.length > this.replayCapacity) {
          window.shift();
        }
      }

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
              cb(event, cursor);
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

/**
 * Singleton hub instance shared across the gateway. Only batch topics carry
 * cursors, and there only the events the shared batch stream can show get one
 * (N49 rounds 7 and 8). Each carries its frozen projection, computed once at
 * publish, so the cursor gaps say nothing about the private events the stream
 * drops, and what the stream writes is what was judged.
 */
export const streamHub = new StreamHub(
  DEFAULT_REPLAY_CAPACITY,
  (event, topic) => (topic.type === "batch" ? batchStreamView(event, topic.id) : null),
);
