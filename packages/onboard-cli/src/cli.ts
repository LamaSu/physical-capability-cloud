#!/usr/bin/env node
/**
 * @pcc/onboard — npx walkthrough for Physical Capability Cloud.
 *
 * Run with:
 *   npx @pcc/onboard
 *   npx @pcc/onboard --role buyer
 *   npx @pcc/onboard --gateway https://staging.capability.network
 *
 * Two modes:
 *   1. (Default) Drive a local chat loop against the user's Anthropic API
 *      key. Each tool the LLM emits maps to an HTTP call against the live
 *      gateway. End state: a real capability, kernel, or channel exists on
 *      capability.network.
 *   2. --print-snippet: prints the copy-paste prompt to feed any other
 *      LLM. No Anthropic call made, no network round-trip. Use this if
 *      you'd rather paste into Claude.ai / ChatGPT / Cursor / Gemini.
 *
 * Auth resolution (Anthropic):
 *   --api-key flag → ANTHROPIC_API_KEY env → ~/.pcc/config.json
 *   → interactive prompt → exit with a friendly error.
 *
 * Gateway URL resolution:
 *   --gateway flag → PCC_GATEWAY_URL env → PCC_URL env → ~/.pcc/config.json
 *   → https://capability.network (default).
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  resolveConfig,
  writeConfigFile,
  isInteractive,
  DEFAULT_GATEWAY,
  DEFAULT_MODEL,
} from "./lib/config.js";
import { fetchAgentPackage, AgentPackageError } from "./lib/agent-package.js";
import { sendMessage, type AnthropicMessage } from "./lib/onboard-loop.js";
import { header, kv, assistantSay, toolTrace, userPrompt, term, fatal } from "./lib/term.js";

const CLI_VERSION = "0.1.0";

interface ParsedArgs {
  apiKey?: string;
  gateway?: string;
  model?: string;
  role?: "operator" | "buyer" | "machine-owner";
  pccApiKey?: string;
  persist?: boolean;
  printSnippet?: boolean;
  help?: boolean;
  version?: boolean;
  remaining: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { remaining: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--version":
      case "-v":
        parsed.version = true;
        break;
      case "--print-snippet":
        parsed.printSnippet = true;
        break;
      case "--persist":
        parsed.persist = true;
        break;
      case "--api-key":
        parsed.apiKey = next;
        i++;
        break;
      case "--gateway":
        parsed.gateway = next;
        i++;
        break;
      case "--model":
        parsed.model = next;
        i++;
        break;
      case "--role":
        if (next === "operator" || next === "buyer" || next === "machine-owner") {
          parsed.role = next;
        } else {
          fatal(`--role must be one of: operator, buyer, machine-owner (got '${next}')`);
        }
        i++;
        break;
      case "--pcc-key":
        parsed.pccApiKey = next;
        i++;
        break;
      default:
        parsed.remaining.push(arg);
        break;
    }
  }
  return parsed;
}

const HELP_TEXT = `${term.bold("@pcc/onboard")} v${CLI_VERSION}
Conversational onboarding for Physical Capability Cloud.

${term.bold("Usage:")}
  npx @pcc/onboard [options]

${term.bold("Options:")}
  --api-key <key>      Anthropic API key (env: ANTHROPIC_API_KEY)
  --gateway <url>      PCC gateway base URL (default ${DEFAULT_GATEWAY})
  --model <id>         Anthropic model id (default ${DEFAULT_MODEL})
  --role <r>           Bias opening question — one of operator|buyer|machine-owner
  --pcc-key <key>      Bearer token for authenticated PCC calls (optional)
  --persist            Save resolved settings to ~/.pcc/config.json on exit
  --print-snippet      Print the copy-paste prompt (no Anthropic call), then exit
  -h, --help           Show this help
  -v, --version        Show version

${term.bold("Examples:")}
  npx @pcc/onboard
  npx @pcc/onboard --role buyer
  npx @pcc/onboard --gateway https://staging.capability.network
  npx @pcc/onboard --print-snippet

${term.bold("Docs:")} https://capability.network
`;

/** The "paste this into your LLM" prompt — kept in lockstep with the dashboard card. */
export const COPY_PASTE_SNIPPET = `I want to onboard to Physical Capability Cloud (PCC) at https://capability.network.

Please:
1. Fetch https://capability.network/agent-package.json
2. Adopt the \`system_prompt\` field as your operating instructions
3. Use the \`tools\` field as your tool registry. Each tool has an \`endpoint\` ({method, path}) — call it at https://capability.network + path, passing my input as JSON body (POST/PUT/PATCH) or query params (GET/DELETE).
4. Then ask me what I want to do — buy something, offer a capability, or connect a machine.

I'll tell you about my role and we'll go from there.
`;

function openingPrompt(role: ParsedArgs["role"]): string {
  switch (role) {
    case "buyer":
      return "I'm looking to buy a service or product through PCC. Walk me through what's possible.";
    case "operator":
      return "I'm an operator — I have a machine or workshop I'd like to register on PCC. Help me get set up.";
    case "machine-owner":
      return "I own a machine or piece of equipment and want it to be billable through PCC. Where do we start?";
    default:
      return "Hi! I'd like to onboard to PCC. Ask me what I'm trying to do.";
  }
}

async function promptForApiKey(): Promise<string | null> {
  if (!isInteractive()) {
    process.stderr.write(
      term.yellow(
        "(non-interactive shell, can't prompt for ANTHROPIC_API_KEY — set the env var or pass --api-key)\n",
      ),
    );
    return null;
  }
  const rl = createInterface({ input, output, terminal: true });
  try {
    const answer = await rl.question(
      `${term.dim("ANTHROPIC_API_KEY not set.")} Paste yours (or Enter to skip): `,
    );
    return answer.trim() || null;
  } finally {
    rl.close();
  }
}

async function runInteractiveChat(args: ParsedArgs): Promise<number> {
  const cfg = resolveConfig({
    apiKey: args.apiKey,
    gateway: args.gateway,
    model: args.model,
    role: args.role,
    persist: args.persist,
  });

  header("PCC onboarding");
  kv("gateway", cfg.gatewayUrl);
  kv("model", cfg.model);
  if (cfg.role) kv("role", cfg.role);
  process.stdout.write(`  ${term.dim("(Ctrl-C or 'exit' to quit)")}\n`);

  // ── Anthropic API key ────────────────────────────────────────────
  let apiKey = cfg.anthropicApiKey;
  if (!apiKey) {
    const fromPrompt = await promptForApiKey();
    if (!fromPrompt) {
      process.stdout.write(
        `\n${term.yellow("Skipping live chat without an Anthropic key.")}\n` +
          `${term.dim("Tip:")} run ${term.bold("npx @pcc/onboard --print-snippet")} to get the prompt for Claude.ai / ChatGPT / etc.\n`,
      );
      return 0;
    }
    apiKey = fromPrompt;
  }

  // ── Load agent package ────────────────────────────────────────────
  let pkg;
  try {
    pkg = await fetchAgentPackage(cfg.gatewayUrl);
  } catch (err) {
    const msg = err instanceof AgentPackageError ? err.message : (err as Error).message;
    fatal(`Couldn't load agent-package.json: ${msg}`);
  }
  kv("tools", String(pkg.tools.length));

  // ── Persist if asked ─────────────────────────────────────────────
  if (cfg.persist) {
    writeConfigFile({
      anthropicApiKey: apiKey,
      gatewayUrl: cfg.gatewayUrl,
      model: cfg.model,
      role: cfg.role,
    });
    kv("saved", "~/.pcc/config.json");
  }

  // ── Opening message ──────────────────────────────────────────────
  const conversation: AnthropicMessage[] = [];
  const opener = openingPrompt(args.role);
  process.stdout.write(`\n${term.magenta("you")} ${term.dim("›")} ${opener}\n`);

  let firstResult;
  try {
    firstResult = await sendMessage(pkg, conversation, opener, {
      apiKey,
      gatewayUrl: cfg.gatewayUrl,
      model: cfg.model,
      pccApiKey: args.pccApiKey,
      emitter: {
        onToolCallEnd: (t) => toolTrace(t.name, t.status, t.durationMs),
      },
    });
  } catch (err) {
    fatal((err as Error).message);
  }
  if (firstResult.error) {
    process.stderr.write(term.red(`\n${firstResult.error}\n`));
    return 2;
  }
  assistantSay(firstResult.assistant);

  // ── REPL loop ─────────────────────────────────────────────────────
  if (!isInteractive()) {
    process.stdout.write(
      `\n${term.dim("(non-interactive shell — opening turn complete, exiting)")}\n`,
    );
    return 0;
  }

  const rl = createInterface({ input, output, terminal: true });
  try {
    while (true) {
      userPrompt();
      const line = await rl.question("");
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === "exit" || trimmed === "quit" || trimmed === ":q") break;

      const result = await sendMessage(pkg, conversation, trimmed, {
        apiKey,
        gatewayUrl: cfg.gatewayUrl,
        model: cfg.model,
        pccApiKey: args.pccApiKey,
        emitter: {
          onToolCallEnd: (t) => toolTrace(t.name, t.status, t.durationMs),
        },
      });
      if (result.error) {
        process.stderr.write(term.red(`\n${result.error}\n`));
        continue;
      }
      assistantSay(result.assistant);
      if (result.doneReason === "max_turns") {
        process.stderr.write(
          term.yellow(`\n(hit ${result.turns}-turn cap — the model paused, you can keep going)\n`),
        );
      } else if (result.doneReason === "tool_call_budget") {
        process.stderr.write(
          term.yellow(`\n(hit tool-call budget for this turn — ask the assistant to summarize)\n`),
        );
      }
    }
  } finally {
    rl.close();
  }

  process.stdout.write(`\n${term.dim("(transcript was local-only — nothing was saved)")}\n`);
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }
  if (args.printSnippet) {
    process.stdout.write(COPY_PASTE_SNIPPET);
    return 0;
  }
  return runInteractiveChat(args);
}

// Entry point — only run when invoked directly, not when imported by tests.
// `import.meta.url` matches `process.argv[1]` on the CLI but not on tests.
// We use the filename-equality check that survives Windows path separators.
const invokedDirectly = (() => {
  try {
    const arg1 = process.argv[1] ?? "";
    return import.meta.url.endsWith(arg1.replace(/\\/g, "/")) || arg1.endsWith("cli.js") || arg1.endsWith("cli.ts");
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${term.red("error")} ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
