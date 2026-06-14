/**
 * Commentary Narrator — LLM narration of PCC event streams.
 *
 * Subscribes to the in-process StreamHub (global topic) and produces
 * sports-broadcaster-style running commentary over batched event windows.
 *
 * The Anthropic SDK is loaded lazily so the gateway can build and serve
 * other routes even if @anthropic-ai/sdk is absent or ANTHROPIC_API_KEY is
 * unset. In that case `start()` returns a session that emits a single
 * `needs_api_key` chunk and resolves cleanly — the route layer renders this
 * as a friendly placeholder.
 */

import { streamHub, type StreamEvent } from "../sse/stream-hub.js";
import type { StreamTopic } from "@pcc/spec";

// ── Types ──────────────────────────────────────────────────────────

export type CommentaryTopic = "jobs" | "escrows" | "attestations" | "all";

export interface CommentaryOptions {
  /** Window batching interval in milliseconds. Default 1500. */
  windowMs?: number;
  /** Topic filter — narrows raw events to a class. Default "all". */
  topic?: CommentaryTopic;
  /** Anthropic model id. Defaults to claude-sonnet-4-5. */
  model?: string;
  /** Maximum number of windows to keep in narration history. Default 6 (~9s @ 1.5s). */
  historyWindows?: number;
  /** Anthropic API key (override). Default reads env. */
  apiKey?: string;
}

export type ChunkType =
  | "ready"
  | "narration"
  | "window"
  | "needs_api_key"
  | "error"
  | "heartbeat";

export interface CommentaryChunk {
  type: ChunkType;
  ts: string;
  /** Raw events included in this window (only for `window` chunks before narration starts). */
  raw_events?: StreamEvent[];
  /** Streaming narration text — a delta on `narration` chunks, the final text on the last chunk. */
  narration?: string;
  /** Window id linking narration deltas to their source window. */
  window_id?: string;
  /** Error message for `error` chunks; explanatory text for `needs_api_key`. */
  message?: string;
}

export type ChunkHandler = (chunk: CommentaryChunk) => void | Promise<void>;

// ── Event filtering ────────────────────────────────────────────────

/**
 * Classify a raw StreamEvent into a high-level commentary topic.
 * Topic filtering keys off `event.type` substrings — defensive against
 * the loose, evolving event taxonomy in the gateway.
 */
export function classifyEvent(event: StreamEvent): CommentaryTopic {
  const t = (event.type ?? "").toLowerCase();
  if (
    t.includes("job") ||
    t.includes("execution") ||
    t.includes("protocol") ||
    t.includes("device") ||
    t.includes("sensor")
  ) {
    return "jobs";
  }
  if (t.includes("escrow") || t.includes("settle") || t.includes("payment") || t.includes("fund")) {
    return "escrows";
  }
  if (
    t.includes("attest") ||
    t.includes("evidence") ||
    t.includes("verifier") ||
    t.includes("compliance") ||
    t.includes("mint")
  ) {
    return "attestations";
  }
  // Unknown taxonomy still flows through "all"
  return "all";
}

export function eventMatchesTopic(
  event: StreamEvent,
  topic: CommentaryTopic,
): boolean {
  if (topic === "all") return true;
  return classifyEvent(event) === topic;
}

// ── Prompt assembly ────────────────────────────────────────────────

export const NARRATOR_SYSTEM_PROMPT = `You are a knowledgeable, conversational sports-broadcaster-style narrator of the Physical Capability Cloud (PCC) substrate.

PCC is a coordination layer where physical manufacturing capabilities (3D printers, CNC mills, HPLC, lab automation) are offered on-chain as billable units. Jobs are dispatched, evidence is captured at each step, attestations are minted by verifiers, and milestone escrows release USDC payments when the evidence meets the required assurance tier.

YOUR JOB: Translate raw technical events into clear, engaging running commentary that explains what is happening at each phase of a job, who is involved, and what the network is doing economically. Tone: knowledgeable, slightly excited but professional, factual, never sycophantic. No hype, no panic, no urgency adverbs.

GROUND RULES:
- Tie every named operator, kernel, capability, or job to a field in the events. If the event does not name the entity, say "an operator" or "this kernel" — never invent a brand like "Tony's Pizza" unless that exact string appears in the event payload.
- Refer back to prior windows when relevant. Do NOT repeat narration the user has already seen — continue the broadcast.
- Use plain prose. No emoji. No bullet points. No headers. Conversational, like a TV broadcaster.
- 1 to 4 short sentences per window. Silence is fine if nothing meaningful happened ("Quiet stretch on the floor — kernels are heartbeating, no new escrows yet.").
- If you do not know what an event means, say so plainly ("a sensor anomaly we have not fully classified yet") rather than guess.
- Anchor money: when you see escrow amounts, say the dollar figure. When you see assurance tiers, mention them by name (Self-Attested / Verified / Certified / Sovereign).
- Never claim something was verified, settled, or released unless an event explicitly says so.`;

export interface PromptWindow {
  windowId: string;
  events: StreamEvent[];
  priorNarration: string[];
}

export function buildUserMessage(window: PromptWindow): string {
  const eventLines = window.events.map((e) => {
    const ts = e.timestamp ?? "";
    const topic = e.topic ? `${e.topic.type}:${e.topic.id}` : "unknown";
    const payload = JSON.stringify(e.payload ?? null);
    // Cap each event's payload so a noisy sensor stream cannot blow context
    const cappedPayload = payload.length > 600 ? payload.slice(0, 600) + "…" : payload;
    return `- [${ts}] (${topic}) ${e.type}: ${cappedPayload}`;
  });

  const eventsBlock = eventLines.length > 0
    ? eventLines.join("\n")
    : "(no new events in this window)";

  const priorBlock = window.priorNarration.length > 0
    ? `PRIOR NARRATION (last ${window.priorNarration.length} windows, oldest first; do not repeat these lines):\n${window.priorNarration.map((n, i) => `  ${i + 1}. ${n}`).join("\n")}`
    : "PRIOR NARRATION: (none yet — this is the start of the broadcast)";

  return `WINDOW ${window.windowId} — ${window.events.length} event(s)

${eventsBlock}

${priorBlock}

Continue the broadcast. 1-4 short sentences. Do not repeat prior lines verbatim.`;
}

// ── Anthropic client (lazy + degradable) ──────────────────────────

interface AnthropicLike {
  messages: {
    stream: (args: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    }) => AsyncIterable<unknown> & {
      finalMessage?: () => Promise<unknown>;
    };
  };
}

interface ClientLoadResult {
  client: AnthropicLike | null;
  reason?: string;
}

let cachedLoad: Promise<{ ctor: any | null; reason?: string }> | null = null;

async function loadAnthropicConstructor(): Promise<{ ctor: any | null; reason?: string }> {
  if (cachedLoad) return cachedLoad;
  cachedLoad = (async () => {
    try {
      // @ts-ignore — optional peer dependency, loaded at runtime
      const mod = await import("@anthropic-ai/sdk");
      const ctor = (mod as any).default ?? (mod as any).Anthropic ?? null;
      if (!ctor) {
        return { ctor: null, reason: "@anthropic-ai/sdk loaded but no usable export" };
      }
      return { ctor };
    } catch (err) {
      return {
        ctor: null,
        reason: `@anthropic-ai/sdk not installed: ${(err as Error).message}`,
      };
    }
  })();
  return cachedLoad;
}

/** Reset the cached SDK import — for tests only. */
export function _resetAnthropicCache(): void {
  cachedLoad = null;
}

async function makeClient(apiKey: string): Promise<ClientLoadResult> {
  const { ctor, reason } = await loadAnthropicConstructor();
  if (!ctor) return { client: null, reason };
  try {
    const client = new ctor({ apiKey });
    return { client };
  } catch (err) {
    return { client: null, reason: `Anthropic client init failed: ${(err as Error).message}` };
  }
}

// ── Narration history buffer ──────────────────────────────────────

class NarrationHistory {
  private buffer: string[] = [];
  constructor(private capacity: number) {}

  push(line: string): void {
    if (!line.trim()) return;
    this.buffer.push(line.trim());
    while (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
  }

  snapshot(): string[] {
    return this.buffer.slice();
  }
}

// ── Event windowing ───────────────────────────────────────────────

class EventWindow {
  private buffer: StreamEvent[] = [];
  private windowSeq = 0;

  push(event: StreamEvent): void {
    this.buffer.push(event);
  }

  flush(): { id: string; events: StreamEvent[] } {
    const events = this.buffer;
    this.buffer = [];
    this.windowSeq += 1;
    return { id: `w${this.windowSeq}-${Date.now().toString(36)}`, events };
  }

  size(): number {
    return this.buffer.length;
  }
}

// ── Streaming session ──────────────────────────────────────────────

export interface CommentarySession {
  /** Stop the session and release the StreamHub subscription. */
  stop: () => void;
  /** Promise resolves when the session ends (stop() called or fatal error). */
  done: Promise<void>;
}

/**
 * Start a narration session. The chunk handler is called with:
 *   - one `ready` chunk first
 *   - alternating `window` (raw events for that window) and `narration` (final text) chunks
 *   - heartbeats every ~15s when the window is empty
 *   - one `error` chunk on fatal error before `done` resolves
 *   - one `needs_api_key` chunk + done if no key/SDK available
 */
export function startCommentarySession(
  options: CommentaryOptions,
  onChunk: ChunkHandler,
): CommentarySession {
  const windowMs = Math.max(250, options.windowMs ?? 1500);
  const topic: CommentaryTopic = options.topic ?? "all";
  const model = options.model ?? "claude-sonnet-4-5";
  const historyCap = Math.max(1, options.historyWindows ?? 6);
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;

  const history = new NarrationHistory(historyCap);
  const window = new EventWindow();
  let stopped = false;
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((res) => { resolveDone = res; });
  let inFlight = false;

  // since-filter (events older than `since` are dropped on the StreamHub side
  // via lastEventId — but here we're subscribing live, so we drop on receive)
  const sinceMs = (() => {
    const s = (options as any).since as string | undefined;
    if (!s) return 0;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
  })();

  const safeEmit = async (chunk: CommentaryChunk) => {
    if (stopped) return;
    try {
      await onChunk(chunk);
    } catch {
      // Caller-side handler errors must not crash the session
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (unsubscribe) {
      try { unsubscribe(); } catch { /* ignore */ }
    }
    resolveDone();
  };

  // Subscribe to streamHub global topic — we want everything, classified below
  const topics: StreamTopic[] = [{ type: "global", id: "*" }];
  unsubscribe = streamHub.subscribe(topics, (event) => {
    if (stopped) return;
    if (sinceMs > 0) {
      const evMs = Date.parse(event.timestamp ?? "");
      if (Number.isFinite(evMs) && evMs < sinceMs) return;
    }
    if (!eventMatchesTopic(event, topic)) return;
    window.push(event);
  });

  // Kickoff: announce ready, then async load client and start ticking
  (async () => {
    await safeEmit({
      type: "ready",
      ts: new Date().toISOString(),
      message: `Subscribed to topic=${topic}, window=${windowMs}ms, model=${model}`,
    });

    if (!apiKey) {
      await safeEmit({
        type: "needs_api_key",
        ts: new Date().toISOString(),
        message:
          "ANTHROPIC_API_KEY is not set. The event stream is live but no narration will be produced until a key is configured.",
      });
      // Keep streaming raw windows so the UI can still show data
    }

    const { client, reason } = apiKey
      ? await makeClient(apiKey)
      : { client: null, reason: "no api key" };

    if (apiKey && !client) {
      await safeEmit({
        type: "needs_api_key",
        ts: new Date().toISOString(),
        message: `Anthropic client unavailable: ${reason ?? "unknown reason"}`,
      });
    }

    timer = setInterval(async () => {
      if (stopped || inFlight) return;
      if (window.size() === 0) return;
      inFlight = true;
      try {
        const flushed = window.flush();
        const promptWindow: PromptWindow = {
          windowId: flushed.id,
          events: flushed.events,
          priorNarration: history.snapshot(),
        };

        // Always emit raw window first so the left column updates regardless of LLM state
        await safeEmit({
          type: "window",
          ts: new Date().toISOString(),
          window_id: flushed.id,
          raw_events: flushed.events,
        });

        if (!client) {
          // Without a client, raw windows are still emitted but no narration
          return;
        }

        const userMsg = buildUserMessage(promptWindow);
        const stream = client.messages.stream({
          model,
          max_tokens: 350,
          system: NARRATOR_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMsg }],
        });

        let assembled = "";
        for await (const ev of stream as any) {
          if (stopped) break;
          // Anthropic streaming events: content_block_delta + delta.text
          const evType = (ev && ev.type) || "";
          if (evType === "content_block_delta") {
            const text = ev?.delta?.text;
            if (typeof text === "string" && text.length > 0) {
              assembled += text;
              await safeEmit({
                type: "narration",
                ts: new Date().toISOString(),
                window_id: flushed.id,
                narration: text,
              });
            }
          }
        }

        if (assembled.trim().length > 0) {
          history.push(assembled);
        }
      } catch (err) {
        await safeEmit({
          type: "error",
          ts: new Date().toISOString(),
          message: `Narration failed for window: ${(err as Error).message ?? String(err)}`,
        });
      } finally {
        inFlight = false;
      }
    }, windowMs);

    heartbeatTimer = setInterval(() => {
      void safeEmit({ type: "heartbeat", ts: new Date().toISOString() });
    }, 15_000);
  })().catch(async (err) => {
    await safeEmit({
      type: "error",
      ts: new Date().toISOString(),
      message: `Session bootstrap failed: ${(err as Error).message ?? String(err)}`,
    });
    stop();
  });

  return { stop, done };
}
