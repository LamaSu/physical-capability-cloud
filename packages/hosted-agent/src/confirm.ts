/**
 * The hosted agent writes only with the user's explicit confirmation.
 *
 * Each tool is classified from the pinned agent package's HTTP method and path:
 *   - read: a GET or HEAD runs at once;
 *   - write: anything else is HELD;
 *   - l2: accepting jobs, price, payout, e-stop, policy, funds. These are not
 *     offered at all while the L2 flag is off, and are held like writes when it
 *     is on.
 * A held call becomes a pending confirmation bound to its session: an
 * unguessable single-use token, a frozen copy of the exact arguments the model
 * supplied, and an expiry. The model is told only that the call is held. It
 * never sees the token, and confirming is not a tool. The user confirms through
 * the service's API, and the service then runs exactly the stored call, once.
 */
import { randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";

/** The same shapes as @pcc/agent-runtime's ToolDef and ToolCaller (LLMAgent). */
export type ToolDef = Anthropic.Tool;
export type ToolCaller = (input: unknown) => Promise<unknown>;

export type ToolLevel = "read" | "write" | "l2";

/** A tool's endpoint, from the pinned agent package. */
export interface ToolSpec {
  readonly name: string;
  readonly method: string;
  readonly path: string;
}

export interface GatedTool {
  readonly def: ToolDef;
  readonly spec: ToolSpec;
  readonly caller: ToolCaller;
}

/** Non-GET paths that move money, accept work or touch safety. Matching is
 * deliberately broad: a false match only hides a tool while L2 is off. */
export const DEFAULT_L2_PATTERNS: readonly RegExp[] = [
  /\/claim\b/i,
  /\/accept\b/i,
  /emergency/i,
  /\/policy\b/i,
  /\/approv/i,
  /\/reject\b/i,
  /payout/i,
  /pric(e|ing)/i,
  /wallet/i,
  /\/fund/i,
  /transfer/i,
  /withdraw/i,
  /escrow/i,
  /settle/i,
  /\/pay\b|\/pay\//i,
  /stake|slash/i,
];

export function classify(spec: ToolSpec, l2Patterns: readonly RegExp[] = DEFAULT_L2_PATTERNS): ToolLevel {
  const method = spec.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return "read";
  return l2Patterns.some((re) => re.test(spec.path)) ? "l2" : "write";
}

export interface HeldCall {
  readonly token: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly level: Exclude<ToolLevel, "read">;
  readonly method: string;
  readonly path: string;
  readonly input: unknown;
  readonly expiresAt: number;
}

/** What the model receives instead of running a held call. */
export interface HeldResult {
  readonly status: "held_for_user_confirmation";
  readonly tool: string;
  readonly message: string;
}

export class ConfirmationRefused extends Error {
  constructor(readonly reason: "unknown" | "expired" | "other-session") {
    super(`confirmation refused: ${reason}`);
    this.name = "ConfirmationRefused";
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export class ConfirmationGate {
  private readonly held = new Map<string, { call: HeldCall; run: () => Promise<unknown> }>();

  constructor(
    private readonly opts: {
      readonly ttlMs?: number;
      readonly now?: () => number;
      readonly token?: () => string;
      readonly l2Patterns?: readonly RegExp[];
    } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * The tools to offer the model for one session, and their callers. Reads
   * pass through; writes (and L2, when enabled) are held; L2 is absent while
   * disabled.
   */
  forSession(
    sessionId: string,
    tools: readonly GatedTool[],
    flags: { readonly l2Enabled: boolean },
  ): { defs: ToolDef[]; callers: Record<string, ToolCaller> } {
    const defs: ToolDef[] = [];
    const callers: Record<string, ToolCaller> = {};
    for (const t of tools) {
      const level = classify(t.spec, this.opts.l2Patterns);
      if (level === "l2" && !flags.l2Enabled) continue;
      defs.push(t.def);
      if (level === "read") {
        callers[t.def.name] = t.caller;
        continue;
      }
      callers[t.def.name] = async (input: unknown): Promise<HeldResult> => {
        const frozen = deepFreeze(structuredClone(input));
        const token = (this.opts.token ?? (() => randomBytes(32).toString("base64url")))();
        const call: HeldCall = {
          token,
          sessionId,
          tool: t.def.name,
          level,
          method: t.spec.method.toUpperCase(),
          path: t.spec.path,
          input: frozen,
          expiresAt: this.now() + (this.opts.ttlMs ?? 10 * 60_000),
        };
        this.held.set(token, { call, run: () => t.caller(structuredClone(frozen)) });
        return {
          status: "held_for_user_confirmation",
          tool: t.def.name,
          message: "This action is waiting for the user's confirmation. Do not retry it; tell the user what it will do.",
        };
      };
    }
    return { defs, callers };
  }

  /** The session's held calls, for the confirmation cards. */
  pending(sessionId: string): HeldCall[] {
    const now = this.now();
    return [...this.held.values()]
      .map((h) => h.call)
      .filter((c) => c.sessionId === sessionId && c.expiresAt >= now);
  }

  private take(sessionId: string, token: string): { call: HeldCall; run: () => Promise<unknown> } {
    const entry = this.held.get(token);
    if (!entry) throw new ConfirmationRefused("unknown");
    if (entry.call.sessionId !== sessionId) throw new ConfirmationRefused("other-session");
    // Consumed before it runs: a second confirmation of the same token finds nothing.
    this.held.delete(token);
    if (entry.call.expiresAt < this.now()) throw new ConfirmationRefused("expired");
    return entry;
  }

  /** Run a held call exactly once, with exactly the arguments that were held. */
  async confirm(sessionId: string, token: string): Promise<unknown> {
    return this.take(sessionId, token).run();
  }

  reject(sessionId: string, token: string): void {
    this.take(sessionId, token);
  }
}
