/**
 * One hosted-agent conversation.
 *
 * It composes the pieces: the pinned pack (system prompt and tools), the tool
 * transport AS THE USER, the confirmation gate, the budget meter, and
 * LLMAgent. The user's credential goes only into the transport; the session
 * never stores, logs or reports it.
 *
 * A session opens only against a gateway that runs the pinned pack: the server
 * names the pack it executes (its version plus the sha256 of the exact bytes),
 * and anything but the pin is refused before a single tool is listed.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { LLMAgent, BudgetExceededError, validateToolNames } from "@pcc/agent-runtime";
import { BudgetStop, meteredClient, type BudgetMeter, type MessagesClient, type ModelPrice } from "./budget.js";
import { ConfirmationGate, type HeldCall } from "./confirm.js";
import type { PinnedPack } from "./pack.js";
import { packTools, scrub, type ToolTransport } from "./tools.js";

export const HOSTED_PREAMBLE = [
  "You are PCC's hosted agent. You act for the signed-in user, with the user's own authority, never with PCC's.",
  "- Every action that changes anything waits for the user's confirmation in the page. When a tool answers",
  '  "held_for_user_confirmation", tell the user plainly what it will do, then stop. Do not retry it.',
  "- Never ask the user to type a key, password or private key into the chat. Sign-in happens in the page.",
  "- You cannot reach the user's device. Device steps run on the user's own machine through pcc-node; guide the user.",
  "- Price, payout, availability and safety settings are the user's decisions: ask, never assume.",
].join("\n");

export type AttemptOutcome = "ok" | "budget_stop" | "failed";

export const HARNESS_VERSION = "0.1.0";

/** The session roll-up, in painpoints' attempt-reporting contract v1 (item 3).
 * Metadata only: no transcript until operator item 99 settles consent. Its
 * sessionId is a random UUID for reporting, never the session's own id (a
 * bearer capability), because reports can go out while a session is live. */
export interface AttemptReport {
  readonly kind: "attempt";
  readonly contract: 1;
  readonly sessionId: string;
  readonly seq: number;
  readonly phase: "session";
  readonly outcome: AttemptOutcome;
  readonly durationMs: number;
  readonly summary: string;
  readonly harness: { readonly name: "pcc-hosted"; readonly version: string; readonly model: string };
  readonly pack: { readonly version: string; readonly digest: string };
  readonly tokens: { readonly in: number; readonly out: number; readonly source: "metered" };
  readonly consent: { readonly transcript: false };
}

/** What close() returns: the report, plus what stays local (never sent). */
export interface SessionClose {
  readonly report: AttemptReport;
  readonly turns: number;
  readonly spentNanoUsd: number;
}

export interface SessionDeps {
  readonly pack: PinnedPack;
  readonly meter: BudgetMeter;
  readonly price: ModelPrice;
  readonly model: string;
  readonly maxTokens?: number;
  readonly anthropic: MessagesClient;
  readonly connect: (credential: string | null) => Promise<ToolTransport>;
  readonly l2Enabled: boolean;
  readonly report?: (report: AttemptReport) => void | Promise<void>;
  readonly now?: () => number;
}

export interface TurnResult {
  readonly reply: string;
  readonly pending: HeldCall[];
  readonly stopped?: string;
}

const NOTE_LIMIT = 2_000;

/** The gateway does not run the pinned agent package. The tool names would
 * match, but a name resolves through the gateway's own pack, so no tool is
 * offered. Carries the two versions for the server-side log; never shown to a caller. */
export class PackMismatch extends Error {
  constructor(
    readonly expected: string,
    readonly reported: string | undefined,
  ) {
    super("the gateway is not running the pinned agent package");
    this.name = "PackMismatch";
  }
}

export class HostedSession {
  private history: Anthropic.MessageParam[] = [];
  private notes: string[] = [];
  private turns = 0;
  private outcome: AttemptOutcome = "ok";
  private closed = false;
  private seq = 0;
  private readonly reportId = randomUUID();

  private constructor(
    readonly id: string,
    private readonly userKey: string,
    private readonly deps: SessionDeps,
    private readonly transport: ToolTransport,
    private readonly gate: ConfirmationGate,
    private readonly agent: LLMAgent,
    private readonly startedAt: number,
    private readonly tokens: { in: number; out: number },
  ) {}

  static async open(deps: SessionDeps, opts: { readonly userKey: string; readonly credential: string | null }): Promise<HostedSession> {
    const id = randomBytes(24).toString("base64url");
    const transport = await deps.connect(opts.credential);
    try {
      // The pin names the package; the gateway names the one it runs. Anything
      // else is refused BEFORE any tool is listed or offered: a tool name
      // resolves through the gateway's own pack, so a name that matches the pin
      // proves nothing about what a call would do.
      const expected = `${deps.pack.version}+sha256.${deps.pack.sha256}`;
      const reported = transport.serverVersion?.();
      if (reported !== expected) throw new PackMismatch(expected, reported);
      const gate = new ConfirmationGate({ now: deps.now });
      const served = new Set(await transport.listTools());
      const offered = gate.forSession(id, packTools(deps.pack, transport, served), { l2Enabled: deps.l2Enabled });
      // LLMAgent refuses reserved tool names (delete_*, fund_*, ...). The policy
      // never offers the ones it knows; any other is dropped here, never renamed.
      const defs = offered.defs.filter((d) => {
        try {
          validateToolNames([d]);
          return true;
        } catch {
          return false;
        }
      });
      const callers = Object.fromEntries(defs.map((d) => [d.name, offered.callers[d.name]!]));
      // Count the tokens each response reports (the metered source), then meter the spend.
      const tokens = { in: 0, out: 0 };
      const counting: MessagesClient = {
        messages: {
          create: async (request) => {
            const response = await deps.anthropic.messages.create(request);
            tokens.in += response.usage?.input_tokens ?? 0;
            tokens.out += response.usage?.output_tokens ?? 0;
            return response;
          },
        },
      };
      const client = meteredClient(counting, deps.meter, { sessionId: id, userKey: opts.userKey }, deps.price);
      // LLMAgent calls only messages.create on its client.
      const agent = new LLMAgent(defs, callers, { client: client as unknown as Anthropic, model: deps.model, maxTokens: deps.maxTokens });
      return new HostedSession(id, opts.userKey, deps, transport, gate, agent, (deps.now ?? Date.now)(), tokens);
    } catch (err) {
      // A session that fails to open leaves no connection behind.
      await transport.close().catch(() => undefined);
      throw err;
    }
  }

  /** One user message. The history advances only when the turn completes. */
  async send(text: string): Promise<TurnResult> {
    if (this.closed) throw new Error("the session is closed");
    // The outcomes this message tells the model. A confirmation or decline that
    // arrives while it runs is not among them: it is told to the NEXT message.
    const told = this.notes.slice();
    const input = told.length > 0 ? `${told.join("\n")}\n\n${text}` : text;
    try {
      const result = await this.agent.chat(input, {
        system: `${HOSTED_PREAMBLE}\n\n${this.deps.pack.systemPrompt}`,
        history: this.history,
      });
      this.history = result.messages;
      this.notes = this.notes.slice(told.length); // only what this message told, never what arrived since
      this.turns += 1;
      return { reply: result.text, pending: this.gate.pending(this.id) };
    } catch (err) {
      if (err instanceof BudgetStop) {
        this.outcome = "budget_stop";
        return {
          reply:
            err.reason === "overrun"
              ? "The agent is paused for your account until tomorrow (UTC), because an earlier call cost more than it was budgeted for. Nothing more was charged."
              : "This session has reached its spending limit, so the agent has stopped. Nothing was charged beyond it.",
          pending: this.gate.pending(this.id),
          stopped: err.reason,
        };
      }
      if (err instanceof BudgetExceededError) {
        return {
          reply: "That request needed more steps than one turn allows. Please ask for a smaller step.",
          pending: this.gate.pending(this.id),
          stopped: err.budget,
        };
      }
      this.outcome = "failed";
      throw err;
    }
  }

  pending(): HeldCall[] {
    return this.gate.pending(this.id);
  }

  /** The user confirms a held call; it runs once, and the model hears the outcome next turn. */
  async confirm(token: string): Promise<unknown> {
    const held = this.gate.pending(this.id).find((h) => h.token === token);
    // What the user's page and the model are shown is scrubbed here, whatever the transport returned.
    const result = scrub(await this.gate.confirm(this.id, token));
    const shown = JSON.stringify(result) ?? "null";
    this.notes.push(
      `(The user confirmed ${held?.tool ?? "an action"}. It returned: ${shown.length > NOTE_LIMIT ? `${shown.slice(0, NOTE_LIMIT)}…` : shown})`,
    );
    return result;
  }

  reject(token: string): void {
    const held = this.gate.pending(this.id).find((h) => h.token === token);
    this.gate.reject(this.id, token);
    this.notes.push(`(The user declined ${held?.tool ?? "an action"}.)`);
  }

  /** End the session: report the attempt (metadata only) and drop the transport. */
  async close(): Promise<SessionClose> {
    if (this.closed) throw new Error("the session is closed");
    this.closed = true;
    const report: AttemptReport = {
      kind: "attempt",
      contract: 1,
      sessionId: this.reportId,
      seq: this.seq++,
      phase: "session",
      outcome: this.outcome,
      durationMs: (this.deps.now ?? Date.now)() - this.startedAt,
      summary: `session: ${this.outcome}`,
      harness: { name: "pcc-hosted", version: HARNESS_VERSION, model: this.deps.model },
      pack: { version: this.deps.pack.version, digest: `sha256:${this.deps.pack.sha256}` },
      tokens: { in: this.tokens.in, out: this.tokens.out, source: "metered" },
      consent: { transcript: false },
    };
    try {
      await this.deps.report?.(report);
    } finally {
      await this.transport.close();
    }
    return {
      report,
      turns: this.turns,
      spentNanoUsd: this.deps.meter.spent({ sessionId: this.id, userKey: this.userKey }).session,
    };
  }
}
