/**
 * Conversational no-code onboarding chat (closes coord dc4d1ec8).
 *
 * Surface a single endpoint that lets a layperson onboard their capability
 * through a chat conversation, with the gateway driving an Anthropic LLM
 * that's been primed with the v3 agent-pack system_prompt (#154).
 *
 *   POST /api/onboard/chat
 *     body: { conversationId?: string, message: string }
 *     -> { conversationId, assistant: string, toolCalls: Array<{name, args, result}>, done: boolean }
 *
 *   GET  /api/onboard/chat/:id
 *     -> { conversationId, messages: [...], createdAt, updatedAt }
 *
 *   GET  /api/onboard/chat/health
 *     -> { ok, hasApiKey, hasSdk, agentPackageStatus }
 *
 * Design
 * ------
 * 1. We fetch the live agent-package.json from the dashboard's public dir
 *    (apps/dashboard/public/agent-package.json) at startup, so the
 *    system_prompt + tools list stay in sync with whatever production is
 *    serving. The path resolves from the gateway repo root via a small
 *    upward walk.
 * 2. Tools that arrive in `tool_use` blocks are executed by self-injecting
 *    HTTP requests against the same Fastify instance via `app.inject`.
 *    No outbound network call, no API key bootstrapping inside the
 *    conversation. The buyer/operator chat thus operates as if it WAS the
 *    user — anything the local gateway's apiGate normally lets through for
 *    unauthenticated calls is fair game; everything else returns the same
 *    401/403 the LLM can react to in plain English.
 * 3. Conversations are persisted in a small `onboard_chat_conversations`
 *    table (created idempotently on first request, no schema migration
 *    needed). Each row carries the full message history as JSON; we cap
 *    at 80 turns to avoid runaway costs.
 * 4. If ANTHROPIC_API_KEY is unset, the endpoint still returns 200 with a
 *    `needs_api_key` flag and a friendly placeholder so the dashboard UI
 *    can render an explanation. Mirrors the commentary-narrator pattern.
 *
 * The frontend (apps/dashboard /onboard/chat) consumes this endpoint with
 * a thin React component — no chat-runtime dependency, just fetch + render.
 *
 * MCP install (Approach A) remains the power-user path; this endpoint is
 * the layperson default. See PR body for the A-vs-B decision.
 */

import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getStore } from "../db.js";
import { sql } from "@pcc/store";

// ── Types ───────────────────────────────────────────────────────────

type AnthropicMessageContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicMessageContent[];
}

interface AgentPackageTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  endpoint?: { method: string; path: string };
}

interface AgentPackage {
  system_prompt: string;
  tools: AgentPackageTool[];
  toolCount?: number;
}

interface ToolCallTrace {
  name: string;
  args: Record<string, unknown>;
  status: number;
  result: unknown;
  durationMs: number;
}

interface ConversationRecord {
  id: string;
  messages: AnthropicMessage[];
  createdAt: string;
  updatedAt: string;
}

interface AnthropicLike {
  messages: {
    create: (args: {
      model: string;
      max_tokens: number;
      system: string;
      tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
      messages: AnthropicMessage[];
    }) => Promise<{
      content: Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      >;
      stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
    }>;
  };
}

// ── Constants ───────────────────────────────────────────────────────

/** Hard cap on conversation turns so a runaway loop can't melt the budget. */
const MAX_TURNS_PER_MESSAGE = 8;

/** Hard cap on total tool calls per chat call. */
const MAX_TOOL_CALLS_PER_TURN = 12;

/** Anthropic model — keep in lockstep with smoke-onboarding-prompt.ts. */
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

/** Default text the LLM emits when ANTHROPIC_API_KEY is missing. */
const NEEDS_KEY_TEXT =
  "Onboarding chat isn't fully configured on this gateway yet — the operator hasn't set ANTHROPIC_API_KEY. " +
  "You can still register your capability via the CLI (`pcc-node start`) or by following the wizard at /onboard/wizard. " +
  "Once a key is configured, this chat will walk you through registration end-to-end.";

// ── Agent package loader (cached) ──────────────────────────────────

let agentPackageCache: { pkg: AgentPackage; loadedAt: number } | null = null;

/**
 * Load the live agent-package.json from the dashboard's public directory.
 * Walks up from the gateway package looking for `apps/dashboard/public/agent-package.json`.
 * Cached per process; the file is regenerated by a build script, not at runtime.
 */
async function loadAgentPackage(): Promise<AgentPackage | null> {
  if (agentPackageCache) return agentPackageCache.pkg;

  // Candidate paths, ordered most-likely first
  const candidates = [
    resolve(process.cwd(), "apps/dashboard/public/agent-package.json"),
    resolve(process.cwd(), "../dashboard/public/agent-package.json"),
    resolve(process.cwd(), "../../apps/dashboard/public/agent-package.json"),
    resolve(process.cwd(), "../../../apps/dashboard/public/agent-package.json"),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as AgentPackage;
      if (parsed.system_prompt && Array.isArray(parsed.tools)) {
        agentPackageCache = { pkg: parsed, loadedAt: Date.now() };
        return parsed;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Reset the cache — for tests only. */
export function _resetAgentPackageCache(): void {
  agentPackageCache = null;
}

// ── Anthropic SDK loader (lazy + degradable) ───────────────────────

let cachedSdk: Promise<{ ctor: any | null; reason?: string }> | null = null;

async function loadAnthropic(): Promise<{ ctor: any | null; reason?: string }> {
  if (cachedSdk) return cachedSdk;
  cachedSdk = (async () => {
    try {
      // @ts-ignore — optional peer dependency
      const mod = await import("@anthropic-ai/sdk");
      const ctor = (mod as any).default ?? (mod as any).Anthropic ?? null;
      if (!ctor) return { ctor: null, reason: "@anthropic-ai/sdk loaded but no usable export" };
      return { ctor };
    } catch (err) {
      return { ctor: null, reason: `@anthropic-ai/sdk not installed: ${(err as Error).message}` };
    }
  })();
  return cachedSdk;
}

/** Reset the cached SDK import — for tests only. */
export function _resetAnthropicCache(): void {
  cachedSdk = null;
}

async function makeClient(apiKey: string): Promise<AnthropicLike | null> {
  const { ctor } = await loadAnthropic();
  if (!ctor) return null;
  try {
    return new ctor({ apiKey }) as AnthropicLike;
  } catch {
    return null;
  }
}

// ── DB helpers ──────────────────────────────────────────────────────

function ensureSchema(): void {
  const { db } = getStore();
  db.run(sql`CREATE TABLE IF NOT EXISTS onboard_chat_conversations (
    id TEXT PRIMARY KEY,
    messages TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}

function generateConversationId(): string {
  return `cnv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadConversation(id: string): ConversationRecord | null {
  const { db } = getStore();
  const rows = db.all(
    sql`SELECT id, messages, created_at as createdAt, updated_at as updatedAt
        FROM onboard_chat_conversations WHERE id = ${id} LIMIT 1`,
  ) as Array<{ id: string; messages: string; createdAt: string; updatedAt: string }>;
  if (rows.length === 0) return null;
  const row = rows[0];
  try {
    return {
      id: row.id,
      messages: JSON.parse(row.messages) as AnthropicMessage[],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  } catch {
    return null;
  }
}

function saveConversation(record: ConversationRecord): void {
  const { db } = getStore();
  const msgsJson = JSON.stringify(record.messages);
  db.run(sql`INSERT INTO onboard_chat_conversations (id, messages, created_at, updated_at)
             VALUES (${record.id}, ${msgsJson}, ${record.createdAt}, ${record.updatedAt})
             ON CONFLICT(id) DO UPDATE SET
               messages = excluded.messages,
               updated_at = excluded.updated_at`);
}

// ── Tool execution (self-injection) ─────────────────────────────────

/**
 * Execute a single LLM-emitted tool call by self-injecting an HTTP request
 * against the same Fastify instance.
 *
 * - GET-shaped tools (or DELETE): query string
 * - POST/PATCH/PUT: JSON body
 *
 * Path params are interpolated from the tool's input. Tool name maps to its
 * agent-package.json `endpoint`. Unknown tools fail closed (404).
 */
async function executeToolCall(
  app: FastifyInstance,
  tool: AgentPackageTool,
  input: Record<string, unknown>,
): Promise<{ status: number; result: unknown }> {
  if (!tool.endpoint) {
    return {
      status: 404,
      result: { error: "tool_has_no_endpoint", message: `Tool ${tool.name} has no endpoint mapping.` },
    };
  }

  const method = tool.endpoint.method.toUpperCase();
  let path = tool.endpoint.path;

  // Interpolate {param} -> input[param] and remember which keys went into the path
  const pathParams = new Set<string>();
  path = path.replace(/\{([^}]+)\}/g, (_, key: string) => {
    pathParams.add(key);
    const v = input[key];
    return v == null ? "" : encodeURIComponent(String(v));
  });

  let url = path;
  let payload: Record<string, unknown> | undefined;
  if (method === "GET" || method === "DELETE") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) {
      if (pathParams.has(key)) continue;
      if (value === undefined || value === null) continue;
      params.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    const qs = params.toString();
    if (qs) url = `${path}?${qs}`;
  } else {
    payload = {};
    for (const [key, value] of Object.entries(input)) {
      if (pathParams.has(key)) continue;
      payload[key] = value;
    }
  }

  try {
    const res = await app.inject({
      method: method as any,
      url,
      payload,
      headers: { "content-type": "application/json" },
    });
    let body: unknown;
    try {
      body = res.json();
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, result: body };
  } catch (err) {
    return {
      status: 500,
      result: { error: "tool_execution_failed", message: (err as Error).message },
    };
  }
}

// ── Route handler ───────────────────────────────────────────────────

export async function onboardChatRoutes(app: FastifyInstance): Promise<void> {
  ensureSchema();

  app.get("/api/onboard/chat/health", async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const sdkLoad = await loadAnthropic();
    const pkg = await loadAgentPackage();
    return {
      ok: true,
      hasApiKey: !!apiKey,
      hasSdk: !!sdkLoad.ctor,
      sdkReason: sdkLoad.reason,
      agentPackageStatus: pkg
        ? {
            loaded: true,
            toolCount: pkg.tools.length,
            promptLength: pkg.system_prompt.length,
          }
        : { loaded: false },
      model: DEFAULT_MODEL,
    };
  });

  app.get<{ Params: { id: string } }>(
    "/api/onboard/chat/:id",
    async (req, reply) => {
      const record = loadConversation(req.params.id);
      if (!record) return reply.status(404).send({ error: "not_found" });
      return {
        conversationId: record.id,
        messages: record.messages,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    },
  );

  app.post<{
    Body: {
      conversationId?: string;
      message?: string;
      /** Optional model override — defaults to ANTHROPIC_MODEL / claude-sonnet-4-6. */
      model?: string;
    };
  }>("/api/onboard/chat", async (req, reply) => {
    const body = req.body ?? {};
    const message = body.message?.trim();
    if (!message) {
      return reply.status(400).send({ error: "message_required" });
    }
    if (message.length > 8_000) {
      return reply.status(400).send({ error: "message_too_long", message: "Keep each message under 8000 chars." });
    }

    const now = new Date().toISOString();
    let record: ConversationRecord;
    if (body.conversationId) {
      const existing = loadConversation(body.conversationId);
      if (!existing) {
        return reply.status(404).send({ error: "conversation_not_found" });
      }
      record = existing;
    } else {
      record = {
        id: generateConversationId(),
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
    }

    if (record.messages.length >= 80) {
      return reply.status(400).send({
        error: "conversation_too_long",
        message: "Start a new conversation — this one has 80+ turns.",
      });
    }

    record.messages.push({ role: "user", content: message });

    // ── If no API key, save + return placeholder ────────────────────
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      record.messages.push({ role: "assistant", content: NEEDS_KEY_TEXT });
      record.updatedAt = new Date().toISOString();
      saveConversation(record);
      return {
        conversationId: record.id,
        assistant: NEEDS_KEY_TEXT,
        toolCalls: [],
        done: true,
        needsApiKey: true,
      };
    }

    const pkg = await loadAgentPackage();
    if (!pkg) {
      return reply.status(500).send({
        error: "agent_package_missing",
        message: "The gateway couldn't find apps/dashboard/public/agent-package.json. Generate it via the dashboard build.",
      });
    }

    const client = await makeClient(apiKey);
    if (!client) {
      return reply.status(500).send({
        error: "anthropic_sdk_unavailable",
        message: "ANTHROPIC_API_KEY is set but @anthropic-ai/sdk failed to load.",
      });
    }

    const toolByName = new Map<string, AgentPackageTool>();
    for (const t of pkg.tools) {
      if (!t.name || !t.input_schema) continue;
      toolByName.set(t.name, t);
    }
    const tools = Array.from(toolByName.values()).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: t.input_schema,
    }));

    // ── Multi-turn tool-use loop ────────────────────────────────────
    const toolCalls: ToolCallTrace[] = [];
    let lastAssistantText = "";
    let turns = 0;
    let totalToolCalls = 0;
    let doneReason: "end_turn" | "max_turns" | "tool_call_budget" | "paused" = "paused";

    while (turns < MAX_TURNS_PER_MESSAGE) {
      turns += 1;

      let res;
      try {
        res = await client.messages.create({
          model: body.model ?? DEFAULT_MODEL,
          max_tokens: 4096,
          system: pkg.system_prompt,
          tools,
          messages: record.messages,
        });
      } catch (err) {
        const errMsg = (err as Error).message;
        record.messages.push({
          role: "assistant",
          content: `(LLM call failed: ${errMsg}. Try again or contact support.)`,
        });
        record.updatedAt = new Date().toISOString();
        saveConversation(record);
        return reply.status(502).send({
          error: "anthropic_call_failed",
          message: errMsg,
          conversationId: record.id,
        });
      }

      const assistantContent: AnthropicMessageContent[] = [];
      const toolResultsForNextTurn: AnthropicMessageContent[] = [];
      let calledThisTurn = false;
      let textThisTurn = "";

      for (const block of res.content) {
        if (block.type === "text") {
          textThisTurn += block.text;
          assistantContent.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          calledThisTurn = true;
          totalToolCalls += 1;
          if (totalToolCalls > MAX_TOOL_CALLS_PER_TURN) {
            const errResult = { error: "tool_call_budget_exceeded", message: `Hit ${MAX_TOOL_CALLS_PER_TURN} tool calls in one user turn.` };
            assistantContent.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
            toolResultsForNextTurn.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(errResult) });
            doneReason = "tool_call_budget";
            continue;
          }

          assistantContent.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });

          const tool = toolByName.get(block.name);
          let status = 404;
          let result: unknown = { error: "unknown_tool", name: block.name };
          let durationMs = 0;
          if (tool) {
            const start = Date.now();
            const exec = await executeToolCall(app, tool, block.input);
            durationMs = Date.now() - start;
            status = exec.status;
            result = exec.result;
          }
          toolCalls.push({ name: block.name, args: block.input, status, result, durationMs });
          toolResultsForNextTurn.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }
      }

      if (textThisTurn) lastAssistantText = textThisTurn;

      // Persist the assistant turn even if we'll loop again — keeps history honest.
      record.messages.push({ role: "assistant", content: assistantContent });

      if (!calledThisTurn) {
        // Model spoke text and didn't call tools — it's awaiting user input.
        doneReason = "end_turn";
        break;
      }

      // Feed tool results back as a user turn (Anthropic convention).
      record.messages.push({ role: "user", content: toolResultsForNextTurn });

      if (doneReason === "tool_call_budget") break;

      if (res.stop_reason === "end_turn" || res.stop_reason === "stop_sequence") {
        doneReason = "end_turn";
        break;
      }
    }

    if (turns >= MAX_TURNS_PER_MESSAGE && doneReason === "paused") {
      doneReason = "max_turns";
    }

    record.updatedAt = new Date().toISOString();
    saveConversation(record);

    return {
      conversationId: record.id,
      assistant: lastAssistantText || "(no text response — see toolCalls for what happened)",
      toolCalls,
      done: doneReason === "end_turn",
      doneReason,
      turns,
    };
  });
}
