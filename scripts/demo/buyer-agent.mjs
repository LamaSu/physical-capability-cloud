#!/usr/bin/env node
/**
 * buyer-agent.mjs — the BUYER side of the "someone's agent mails a letter" demo.
 *
 * The premise: a real third-party agent, driven by an LLM it did not train and
 * does not control, walks up to PCC and uses PCC's own published tool surface to
 * get a physical job done. Here the job is "print this 3-page PDF and mail it".
 *
 *   brain  = AIsa (OpenAI-compatible chat/completions, model deepseek-v3.1)
 *   tools  = PCC's agent-package.json `tools`, translated 1:1 into OpenAI
 *            function-calling tools. A tool call is executed by making the HTTP
 *            request the tool's `endpoint` describes against PCC_BASE, carrying
 *            `Authorization: Bearer $PCC_API_KEY`.
 *
 * The script is deliberately NOT a black box. It prints a timestamped transcript
 * of every model turn and every HTTP call to stdout AND to
 * ai/research/buyer-transcript.md, so the demo is auditable after the fact.
 *
 * Flow:
 *   1. Describe the job in natural language.
 *   2. Let the brain drive: it calls pcc_submit_request → POST /api/requests.
 *      Print the decomposed capability DAG and the MATCHED node.
 *   3. Poll GET /api/job-offers/open?capabilityType=<type> until an offer shows.
 *      The operator-side bridge (PR #294) is what PUBLISHES offers; until that is
 *      merged this legitimately returns 0. We print that honestly — we never
 *      fabricate an offer.
 *   4. NEGATIVE CONTROL: poll a capabilityType nobody offers. It must also return
 *      0, so an empty feed is never silently mistaken for "no work available".
 *
 * Secrets: keys are read from env only. The script refuses to run without them.
 * It defaults PCC_BASE to a LOCAL gateway and never touches prod unless PCC_BASE
 * is explicitly pointed there.
 *
 * Two brains, one loop. The agent loop is identical whether the completion comes
 * from AIsa or from the built-in --mock-llm planner; only the completion backend
 * swaps. --mock-llm exists so the whole pipeline can be exercised against a local
 * gateway without spending AIsa credit or holding an AISA_API_KEY. It is always
 * labelled [MOCK-LLM] in the transcript and can never reach prod.
 *
 * Pure helpers (toOpenAiTools / buildEndpointMap / buildToolRequest /
 * extractDecomposition / deriveCapabilityType) are exported for the vitest in
 * buyer-agent.test.mjs — the schema translation is verified even where the
 * network path is written-not-verified.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

// ─────────────────────────────────────────────────────────────────────────────
// Config (env only — no secrets in the repo)
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {
  aisaBase: process.env.AISA_BASE ?? "https://api.aisa.one/v1",
  aisaModel: process.env.AISA_MODEL ?? "deepseek-v3.1",
  aisaKey: process.env.AISA_API_KEY ?? null,
  pccKey: process.env.PCC_API_KEY ?? null,
  // Default to a LOCAL gateway. Prod is only reached when explicitly configured.
  pccBase: process.env.PCC_BASE ?? "http://localhost:3200",
  // The task points at the published package. Overridable to a local path/URL so
  // a local run can be fully hermetic (no prod dependency). Tool calls still go
  // to PCC_BASE regardless of where the package was loaded from.
  agentPackageUrl:
    process.env.AGENT_PACKAGE_URL ?? "https://capability.network/agent-package.json",
  transcriptPath:
    process.env.TRANSCRIPT_PATH ?? join(REPO_ROOT, "ai", "research", "buyer-transcript.md"),
  // Cost ceilings for the brain. A "handful of calls" — submit one request, stop.
  maxTurns: Number(process.env.BUYER_MAX_TURNS ?? 4),
  maxToolCalls: Number(process.env.BUYER_MAX_TOOL_CALLS ?? 3),
  // Expose every package tool by default (faithful to the task). Cap only if set.
  maxTools: process.env.BUYER_MAX_TOOLS ? Number(process.env.BUYER_MAX_TOOLS) : null,
  // Job-offer polling.
  pollAttempts: Number(process.env.BUYER_POLL_ATTEMPTS ?? 5),
  pollDelayMs: Number(process.env.BUYER_POLL_DELAY_MS ?? 2000),
  httpTimeoutMs: Number(process.env.BUYER_HTTP_TIMEOUT_MS ?? 30000),
};

const FLAGS = {
  mockLlm: process.argv.includes("--mock-llm"),
};

const PROD_HOSTS = ["capability.network", "www.capability.network"];

// The job, in plain English. This is the ONLY thing the buyer "knows".
const JOB = {
  address: process.env.BUYER_MAIL_ADDRESS ?? "1 Market St, San Francisco, CA 94105",
  title: "Print a 3-page PDF and mail it",
  get description() {
    return (
      `Print this 3-page PDF (single-sided, black & white, letter paper) and ` +
      `physically mail the printed copy to ${this.address}. ` +
      `I need proof it was printed and proof it was mailed.`
    );
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Transcript — every model turn and every HTTP call, timestamped, to stdout AND
// to ai/research/buyer-transcript.md. Appended synchronously so a crash mid-run
// still leaves an honest partial record.
// ─────────────────────────────────────────────────────────────────────────────

class Transcript {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    // Truncate + header at start of a run.
    writeFileSync(
      path,
      `# Buyer agent transcript\n\n` +
        `Run started: ${new Date().toISOString()}\n\n` +
        `- brain: ${FLAGS.mockLlm ? "MOCK-LLM (scripted)" : `AIsa ${CONFIG.aisaModel} @ ${CONFIG.aisaBase}`}\n` +
        `- PCC_BASE: ${CONFIG.pccBase}\n` +
        `- agent package: ${CONFIG.agentPackageUrl}\n\n` +
        `---\n\n`,
    );
  }

  /** Log a single timestamped event to stdout and the transcript file. */
  event(kind, message, detail) {
    const ts = new Date().toISOString();
    const head = `[${ts}] ${kind}  ${message}`;
    // stdout
    console.log(head);
    if (detail !== undefined) console.log(indent(detail));
    // file (markdown)
    let block = `### ${ts} — ${kind}\n\n${message}\n`;
    if (detail !== undefined) {
      block += "\n```\n" + (typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)) + "\n```\n";
    }
    block += "\n";
    appendFileSync(this.path, block);
  }

  section(title) {
    console.log("\n" + "━".repeat(72));
    console.log(title);
    console.log("━".repeat(72));
    appendFileSync(this.path, `\n---\n\n## ${title}\n\n`);
  }
}

function indent(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s
    .split("\n")
    .map((l) => "    " + l)
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported — verified by buyer-agent.test.mjs)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate one PCC agent-package tool (Anthropic-style: name/description/
 * input_schema/endpoint) into an OpenAI function-calling tool. This is the
 * schema translation the demo hinges on and the vitest verifies.
 */
export function toOpenAiTool(pkgTool) {
  return {
    type: "function",
    function: {
      name: pkgTool.name,
      description: pkgTool.description ?? "",
      // OpenAI calls it `parameters`; PCC calls it `input_schema`. Same JSON
      // Schema object. Default to an empty object schema when a tool omits it.
      parameters: pkgTool.input_schema ?? { type: "object", properties: {} },
    },
  };
}

/** Translate the whole `tools` array. Optionally cap the count (cost control). */
export function toOpenAiTools(pkgTools, maxTools = null) {
  const list = Array.isArray(pkgTools) ? pkgTools : [];
  const capped = maxTools != null ? list.slice(0, maxTools) : list;
  return capped.map(toOpenAiTool);
}

/** name → { method, path } so a tool call can be turned into an HTTP request. */
export function buildEndpointMap(pkgTools) {
  const map = new Map();
  for (const t of pkgTools ?? []) {
    if (t?.name && t?.endpoint?.path) {
      map.set(t.name, { method: (t.endpoint.method ?? "GET").toUpperCase(), path: t.endpoint.path });
    }
  }
  return map;
}

/**
 * Build the concrete HTTP request for a tool call — pure, no network. Path
 * params written `{name}` or `:name` are filled from `input` and removed from
 * the payload; the remainder becomes a querystring on GET/HEAD or a JSON body
 * otherwise. Returns { method, url, body } (body undefined for GET/HEAD).
 */
export function buildToolRequest({ endpoint, input = {}, base }) {
  const method = (endpoint.method ?? "GET").toUpperCase();
  const consumed = new Set();
  const fill = (_, k) => {
    consumed.add(k);
    return encodeURIComponent(String(input[k] ?? ""));
  };
  const path = String(endpoint.path ?? "")
    .replace(/\{(\w+)\}/g, fill)
    .replace(/:(\w+)/g, fill);

  const url = new URL(base.replace(/\/+$/, "") + path);
  const rest = {};
  for (const [k, v] of Object.entries(input)) if (!consumed.has(k)) rest[k] = v;

  let body;
  if (method === "GET" || method === "HEAD") {
    for (const [k, v] of Object.entries(rest)) {
      if (v == null) continue;
      url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  } else {
    body = JSON.stringify(rest);
  }
  return { method, url: url.toString(), body };
}

/**
 * Pull the request + decomposition out of a POST /api/requests response. The
 * gateway returns { request, decomposition }, where the DAG is
 * decomposition.nodes (and mirrored on request.capabilityDag).
 */
export function extractDecomposition(submitResult) {
  const r = submitResult ?? {};
  const request = r.request ?? null;
  const decomposition = r.decomposition ?? null;
  const nodes =
    (decomposition && Array.isArray(decomposition.nodes) && decomposition.nodes) ||
    (request && Array.isArray(request.capabilityDag) && request.capabilityDag) ||
    [];
  return { request, decomposition, nodes };
}

/**
 * Choose the capabilityType to shop for. Prefer a node the decomposer actually
 * matched to a registered capability; otherwise a printing/mail/courier node by
 * keyword; otherwise the first node. Returns { type, node, reason } — the reason
 * is printed so the choice is never silent.
 */
export function deriveCapabilityType(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (list.length === 0) return { type: null, node: null, reason: "empty DAG" };

  // Match on BOTH the human name and the capabilityType — the offline decomposer
  // names a node "Delivery" while typing it "logistics"/"ipp", so type alone
  // misses. Prefer the transport/mail leg (the demo mails a letter), then print.
  const hay = (n) => `${n?.name ?? ""} ${n?.capabilityType ?? ""}`;

  const matched = list.find((n) => n?.matchStatus === "matched");
  if (matched) {
    return { type: matched.capabilityType, node: matched, reason: `matched node "${matched.matchedCapabilityName ?? matched.name}"` };
  }
  const transport = list.find((n) => /courier|mail|deliver|dispatch|logistic|ship|post/i.test(hay(n)));
  if (transport) {
    return { type: transport.capabilityType, node: transport, reason: `keyword match (transport) on "${transport.name}" — no node was capability-matched` };
  }
  const print = list.find((n) => /print|ipp|scan/i.test(hay(n)));
  if (print) {
    return { type: print.capabilityType, node: print, reason: `keyword match (print) on "${print.name}" — no node was capability-matched` };
  }
  return { type: list[0].capabilityType, node: list[0], reason: `first DAG node (no match, no keyword)` };
}

/** Compact one-line-per-node rendering of the DAG for humans. */
export function renderDag(nodes) {
  if (!nodes?.length) return "(empty DAG)";
  return nodes
    .map((n, i) => {
      const tag = n.matchStatus === "matched" ? " ★MATCHED" : "";
      const to = n.matchedCapabilityName ? ` → ${n.matchedCapabilityName}` : "";
      const deps = n.dependencies?.length ? ` deps=[${n.dependencies.join(",")}]` : "";
      return `  ${i + 1}. ${n.name}  [${n.capabilityType}]  ($${n.estimatedCost ?? "?"})${to}${deps}${tag}`;
    })
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

async function fetchJson(url, init = {}, timeoutMs = CONFIG.httpTimeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { _raw: text };
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute a translated tool call against PCC_BASE. This is the bridge between an
 * OpenAI function call and a real PCC HTTP endpoint.
 */
function makeToolExecutor(endpointMap, transcript) {
  return async function callTool(name, input) {
    const endpoint = endpointMap.get(name);
    if (!endpoint) {
      const err = { error: `unknown tool: ${name}` };
      transcript.event("TOOL-ERR", `no endpoint for tool "${name}"`, err);
      return err;
    }
    const { method, url, body } = buildToolRequest({ endpoint, input, base: CONFIG.pccBase });
    const headers = { "Content-Type": "application/json" };
    if (CONFIG.pccKey) headers["Authorization"] = `Bearer ${CONFIG.pccKey}`;

    const started = new Date();
    const { ok, status, data } = await fetchJson(url, { method, headers, body });
    const ms = Date.now() - started.getTime();
    transcript.event(
      "HTTP",
      `${method} ${url} → ${status} (${ms}ms)  [tool: ${name}]`,
      truncateForLog(data),
    );
    return data;
  };
}

function truncateForLog(data, max = 4000) {
  const s = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more chars)` : data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Brains — real AIsa and the scripted --mock-llm. Both return an OpenAI-shaped
// chat.completions response so the agent loop below is identical for either.
// ─────────────────────────────────────────────────────────────────────────────

/** The OpenAI chat/completions URL for an AIsa base (pure — exported for tests). */
export function aisaCompletionsUrl(base) {
  return `${String(base).replace(/\/+$/, "")}/chat/completions`;
}

/** The exact request body sent to AIsa (pure — exported so its shape is verified
 *  even though the live round-trip is written-not-verified). */
export function buildAisaPayload(messages, tools, model) {
  return { model, messages, tools, tool_choice: "auto", temperature: 0 };
}

async function aisaChatCompletion(messages, tools, transcript) {
  const url = aisaCompletionsUrl(CONFIG.aisaBase);
  const payload = buildAisaPayload(messages, tools, CONFIG.aisaModel);
  const started = new Date();
  const { ok, status, data } = await fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONFIG.aisaKey}`,
    },
    body: JSON.stringify(payload),
  });
  const ms = Date.now() - started.getTime();
  transcript.event("AISA-HTTP", `POST ${url} → ${status} (${ms}ms) model=${CONFIG.aisaModel}`, {
    usage: data?.usage,
    finish_reason: data?.choices?.[0]?.finish_reason,
  });
  if (!ok) {
    throw new Error(`AIsa error ${status}: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

/**
 * Scripted stand-in for the model, used with --mock-llm. Turn 1: "decide" to
 * submit the request. Turn 2 (after the tool result): a plain-text wrap-up. This
 * mirrors what a competent buyer model does, so the local pipeline is fully
 * exercisable without a key. Always labelled [MOCK-LLM].
 */
function makeMockCompletion(job, transcript) {
  return async function mockChatCompletion(messages) {
    const hasToolResult = messages.some((m) => m.role === "tool");
    if (!hasToolResult) {
      transcript.event("MODEL", "[MOCK-LLM] turn 1 — deciding to submit the request via pcc_submit_request");
      return {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: `I'll submit this as a PCC request and let the network decompose it.`,
              tool_calls: [
                {
                  id: "call_mock_1",
                  type: "function",
                  function: {
                    name: "pcc_submit_request",
                    arguments: JSON.stringify({ title: job.title, description: job.description }),
                  },
                },
              ],
            },
          },
        ],
        usage: { note: "mock — no tokens spent" },
      };
    }
    transcript.event("MODEL", "[MOCK-LLM] turn 2 — request submitted, wrapping up");
    return {
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content:
              `Request submitted and decomposed into a capability DAG. Next I'd shop each ` +
              `node's capabilityType on the open job-offers feed and commit once an operator claims.`,
          },
        },
      ],
      usage: { note: "mock — no tokens spent" },
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The agent loop — model → (tool calls → results) → model → … until it stops.
// ─────────────────────────────────────────────────────────────────────────────

async function runAgent({ completion, system, user, tools, callTool, transcript }) {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const executed = []; // { name, input, result }
  let toolCalls = 0;

  for (let turn = 0; turn < CONFIG.maxTurns; turn++) {
    const resp = await completion(messages, tools, transcript);
    const msg = resp?.choices?.[0]?.message;
    if (!msg) throw new Error(`no message in completion response (turn ${turn})`);

    transcript.event(
      "MODEL",
      `turn ${turn} — finish_reason=${resp.choices[0].finish_reason ?? "?"}` +
        (msg.tool_calls ? `, ${msg.tool_calls.length} tool call(s)` : ""),
      msg.content || undefined,
    );

    messages.push(msg);

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      return { messages, executed, finalText: msg.content ?? "", turns: turn + 1, toolCalls };
    }

    for (const call of calls) {
      if (toolCalls >= CONFIG.maxToolCalls) {
        transcript.event("GUARD", `maxToolCalls=${CONFIG.maxToolCalls} reached — stopping tool execution`);
        return { messages, executed, finalText: msg.content ?? "", turns: turn + 1, toolCalls, capped: true };
      }
      let input = {};
      try {
        input = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch (e) {
        transcript.event("TOOL-ERR", `could not parse arguments for ${call.function?.name}`, String(e));
      }
      transcript.event("TOOL-CALL", `${call.function?.name}(${JSON.stringify(input)})`);
      const result = await callTool(call.function.name, input);
      toolCalls++;
      executed.push({ name: call.function.name, input, result });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result ?? null),
      });
    }
  }
  transcript.event("GUARD", `maxTurns=${CONFIG.maxTurns} reached without a terminal turn`);
  return { messages, executed, finalText: "", turns: CONFIG.maxTurns, toolCalls, capped: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Package loading
// ─────────────────────────────────────────────────────────────────────────────

async function loadAgentPackage(urlOrPath, transcript) {
  // Local file path or file:// URL → read from disk (hermetic runs).
  if (urlOrPath.startsWith("file://") || (!urlOrPath.startsWith("http://") && !urlOrPath.startsWith("https://"))) {
    const p = urlOrPath.startsWith("file://") ? fileURLToPath(urlOrPath) : resolve(urlOrPath);
    transcript.event("PKG", `loading agent package from disk: ${p}`);
    return JSON.parse(readFileSync(p, "utf8"));
  }
  transcript.event("PKG", `fetching agent package: ${urlOrPath}`);
  const { ok, status, data } = await fetchJson(urlOrPath, {}, CONFIG.httpTimeoutMs);
  if (!ok) throw new Error(`failed to fetch agent package (${status})`);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Job-offers polling + negative control (deterministic; the open feed is public)
// ─────────────────────────────────────────────────────────────────────────────

async function pollOpenOffers(capabilityType, transcript, { attempts, delayMs, label }) {
  const base = CONFIG.pccBase.replace(/\/+$/, "");
  const url = `${base}/api/job-offers/open?capabilityType=${encodeURIComponent(capabilityType)}`;
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    const { ok, status, data } = await fetchJson(url, {
      headers: CONFIG.pccKey ? { Authorization: `Bearer ${CONFIG.pccKey}` } : {},
    });
    const count = typeof data?.count === "number" ? data.count : Array.isArray(data?.offers) ? data.offers.length : null;
    transcript.event(
      "HTTP",
      `[${label}] GET ${url} → ${status} — count=${count}${count === 0 ? " (no offers)" : ""} (attempt ${i}/${attempts})`,
      count && count > 0 ? truncateForLog(data) : undefined,
    );
    last = { ok, status, count, data };
    if (count && count > 0) break;
    if (i < attempts) await sleep(delayMs);
  }
  return last;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

function preflight() {
  const problems = [];
  if (!FLAGS.mockLlm && !CONFIG.aisaKey) {
    problems.push("AISA_API_KEY is not set (required for the AIsa brain; or pass --mock-llm for a keyless local run).");
  }
  if (!CONFIG.pccKey) {
    problems.push("PCC_API_KEY is not set (required as the Bearer token for tool HTTP calls).");
  }
  if (problems.length) {
    console.error("✗ Refusing to run — missing configuration:\n");
    for (const p of problems) console.error("  • " + p);
    console.error(
      "\nKeys are read from env only; nothing is stored in the repo. Example (local mock gateway):\n" +
        "  export PCC_API_KEY=pcc_live_...        # provision one at POST /api/auth/provision\n" +
        "  export PCC_BASE=http://localhost:3200  # local gateway in mock mode (default)\n" +
        "  export AISA_API_KEY=...                # for the real brain\n" +
        "  node scripts/demo/buyer-agent.mjs [--mock-llm]\n",
    );
    process.exit(1);
  }

  // Prod guard — loud, but permitted only when explicitly targeted.
  try {
    const host = new URL(CONFIG.pccBase).host;
    if (PROD_HOSTS.includes(host)) {
      console.error(
        `\n⚠️  PCC_BASE points at PRODUCTION (${host}). This will submit a REAL request.\n` +
          `   Unset PCC_BASE (defaults to http://localhost:3200) to run against a local gateway.\n`,
      );
    }
  } catch {
    console.error(`✗ PCC_BASE is not a valid URL: ${CONFIG.pccBase}`);
    process.exit(1);
  }
}

async function main() {
  preflight();
  const transcript = new Transcript(CONFIG.transcriptPath);

  transcript.section("PCC BUYER AGENT — print a PDF and mail it");
  transcript.event(
    "START",
    FLAGS.mockLlm ? "brain: MOCK-LLM (scripted, no credit spent)" : `brain: AIsa ${CONFIG.aisaModel}`,
    { pccBase: CONFIG.pccBase, agentPackage: CONFIG.agentPackageUrl },
  );

  // 1) Load PCC's tool surface and translate it into OpenAI tools.
  const pkg = await loadAgentPackage(CONFIG.agentPackageUrl, transcript);
  const pkgTools = pkg.tools ?? [];
  const tools = toOpenAiTools(pkgTools, CONFIG.maxTools);
  const endpointMap = buildEndpointMap(pkgTools);
  transcript.event(
    "PKG",
    `translated ${pkgTools.length} PCC tools → ${tools.length} OpenAI function tools` +
      (CONFIG.maxTools ? ` (capped at ${CONFIG.maxTools})` : ""),
    { sampleTool: tools[0]?.function?.name, submitPresent: endpointMap.has("pcc_submit_request") },
  );

  const callTool = makeToolExecutor(endpointMap, transcript);
  const completion = FLAGS.mockLlm ? makeMockCompletion(JOB, transcript) : aisaChatCompletion;

  const system =
    (pkg.system_prompt ? pkg.system_prompt + "\n\n" : "") +
    `You are acting as a BUYER on the user's behalf. For THIS task, do exactly one ` +
    `thing: submit the job as a single capability request using the pcc_submit_request ` +
    `tool (pass a short title and the full natural-language description). Do not call ` +
    `any other tool. After the request comes back decomposed, stop and briefly summarize.`;

  // 2) Describe the job in natural language and let the brain drive.
  transcript.section("STEP 1 — describe the job, brain submits the request");
  transcript.event("JOB", JOB.title, JOB.description);

  const run = await runAgent({
    completion,
    system,
    user:
      `Please get this done: ${JOB.description}\n\n` +
      `Submit it as one PCC request via pcc_submit_request and report the decomposition.`,
    tools,
    callTool,
    transcript,
  });

  // 2b) Extract + print the decomposed DAG and the MATCHED node.
  transcript.section("STEP 2 — decomposed DAG + MATCHED node");
  const submitCall = run.executed.find((e) => e.name === "pcc_submit_request");
  let derived = { type: null, node: null, reason: "no request was submitted by the brain" };

  if (!submitCall) {
    transcript.event(
      "WARN",
      "The brain did not call pcc_submit_request — no DAG to show. This is reported honestly; nothing is faked.",
      run.finalText || "(no final text)",
    );
  } else if (submitCall.result?.error || submitCall.result?.request == null) {
    transcript.event("WARN", "pcc_submit_request returned no request/decomposition", truncateForLog(submitCall.result));
  } else {
    const { request, decomposition, nodes } = extractDecomposition(submitCall.result);
    transcript.event(
      "DAG",
      `request ${request.id} — status=${request.status}, ${nodes.length} node(s), ` +
        `matchedCount=${decomposition?.matchedCount ?? 0}, ` +
        `est. cost=$${decomposition?.totalEstimatedCost ?? request.totalEstimatedCost ?? "?"}`,
      renderDag(nodes),
    );
    derived = deriveCapabilityType(nodes);
    const matchedNodes = nodes.filter((n) => n.matchStatus === "matched");
    if (matchedNodes.length) {
      transcript.event(
        "MATCHED",
        `${matchedNodes.length} node(s) matched to a registered capability`,
        matchedNodes.map((n) => ({
          node: n.name,
          capabilityType: n.capabilityType,
          matchedCapability: n.matchedCapabilityName,
          matchedKernel: n.matchedKernelId,
          matchScore: n.matchScore,
        })),
      );
    } else {
      transcript.event(
        "MATCHED",
        "No node was matched to a registered capability on this gateway (matchStatus=none). " +
          "Honest: with an empty/mock catalog the decomposer produces the DAG but has nothing to match against.",
      );
    }
    transcript.event("SHOP", `will shop capabilityType="${derived.type}" — reason: ${derived.reason}`);
  }

  // 3) Poll the open job-offers feed for the derived capability type.
  transcript.section("STEP 3 — poll open job-offers (real matching signal)");
  if (derived.type) {
    const res = await pollOpenOffers(derived.type, transcript, {
      attempts: CONFIG.pollAttempts,
      delayMs: CONFIG.pollDelayMs,
      label: "LIVE",
    });
    if (res?.count && res.count > 0) {
      transcript.event("RESULT", `✓ Found ${res.count} open offer(s) for "${derived.type}".`);
    } else {
      transcript.event(
        "RESULT",
        `0 open offers for "${derived.type}". This is the HONEST expected result until the ` +
          `operator-side bridge (PR #294) is merged — that PR is what publishes offers onto this ` +
          `feed. An empty feed here means "no operator has posted yet", not "the query failed" ` +
          `— the negative control below proves the query path works.`,
      );
    }
  } else {
    transcript.event("SKIP", "No capabilityType derived (brain did not submit) — skipping live poll.");
  }

  // 4) NEGATIVE CONTROL — a type nobody offers must also return 0.
  transcript.section("STEP 4 — negative control");
  const negType = `pcc.buyer.negative-control.${Date.now()}.nobody-offers-this`;
  const neg = await pollOpenOffers(negType, transcript, { attempts: 1, delayMs: 0, label: "NEG-CTRL" });
  const negCount = neg?.count;
  if (negCount === 0) {
    transcript.event(
      "RESULT",
      `✓ Negative control returned 0 for a capabilityType nobody offers, as required. ` +
        `An empty live feed is therefore trustworthy: 0 means "no work", not "broken query".`,
    );
  } else if (negCount == null && (neg?.status ?? 0) >= 400) {
    transcript.event(
      "WARN",
      `Negative control could not reach the feed (status ${neg?.status}). Likely the local ` +
        `gateway is not running at ${CONFIG.pccBase}. The control is INCONCLUSIVE, not passed.`,
    );
  } else {
    transcript.event(
      "WARN",
      `Negative control returned count=${negCount} for a type nobody should offer — unexpected; ` +
        `investigate before trusting the live feed.`,
    );
  }

  // Wrap-up.
  transcript.section("SUMMARY");
  const summary = {
    brain: FLAGS.mockLlm ? "MOCK-LLM" : `AIsa ${CONFIG.aisaModel}`,
    pccBase: CONFIG.pccBase,
    toolsExposed: tools.length,
    modelTurns: run.turns,
    toolCallsExecuted: run.toolCalls,
    requestSubmitted: Boolean(submitCall && submitCall.result?.request),
    shoppedCapabilityType: derived.type,
    negativeControl: negCount === 0 ? "PASS (0 as required)" : negCount == null ? "INCONCLUSIVE (feed unreachable)" : `UNEXPECTED (${negCount})`,
  };
  transcript.event("DONE", "run complete", summary);
  console.log(`\nTranscript written to: ${CONFIG.transcriptPath}`);
  return summary;
}

// Only run when executed directly (so the test file can import the pure helpers).
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error("\n✗ buyer-agent failed:", err?.stack || err?.message || String(err));
    try {
      appendFileSync(
        CONFIG.transcriptPath,
        `\n### ${new Date().toISOString()} — FATAL\n\n\`\`\`\n${err?.stack || String(err)}\n\`\`\`\n`,
      );
    } catch {}
    process.exit(1);
  });
}
