// Replacement for the TinyFish wrapper. We fetch the page through the
// harness's stealth `camoufox` CLI (C++ engine-patched Firefox, so it gets
// past Cloudflare/DataDome/etc. on operator websites), then hand the HTML to
// Claude with a tool-use forced output so the model is required to fill our
// Zod schema. Goal: structured-extract anything we used to ask TinyFish for,
// without the external dependency.
//
// Ported from `LamaSu/navi` packages/backend/src/tools/web-extract.ts.

import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import type { ZodSchema } from "zod";
import { zodToJsonSchema } from "./zod-json-schema.js";

const MOCK = process.env.MOCK_WEB_EXTRACT === "true";
const MODEL = process.env.WEB_EXTRACT_MODEL ?? "claude-sonnet-4-5";
const HTML_LIMIT = Number(process.env.WEB_EXTRACT_HTML_LIMIT ?? 100_000);
const CAMOUFOX_BIN = process.env.CAMOUFOX_BIN ?? "camoufox";

export interface ExtractOptions<T> {
  url: string;
  schema: ZodSchema<T>;
  goal: string;
  /** Override model per-call. Defaults to env or claude-sonnet-4-5. */
  model?: string;
  /** Truncate fetched HTML before passing to the model. Defaults to 100k chars. */
  htmlLimit?: number;
}

/**
 * Fetch a URL via the stealth camoufox CLI and return the rendered text/HTML
 * payload. Subprocess-based so we don't need to embed Playwright. Throws if
 * the CLI exits non-zero or stdout is empty.
 */
export async function camoufoxFetch(url: string, bin = CAMOUFOX_BIN): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, [url, "--json"], {
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (err) => {
      reject(new Error(`camoufox spawn failed: ${err.message}`));
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`camoufox exited ${code}: ${stderr.trim() || "(no stderr)"}`));
        return;
      }
      if (!stdout.trim()) {
        reject(new Error("camoufox returned empty output"));
        return;
      }
      // The harness CLI in --json mode emits the MCP tools/call result. The
      // payload we want is the text content (rendered DOM). Try to parse JSON
      // first; fall back to raw text.
      try {
        const parsed = JSON.parse(stdout);
        const content = parsed?.content;
        if (Array.isArray(content)) {
          const text = content
            .filter((c: { type?: string }) => c?.type === "text")
            .map((c: { text?: string }) => c.text ?? "")
            .join("\n");
          if (text.trim()) {
            resolve(text);
            return;
          }
        }
        // No text block — fall through to raw stdout.
      } catch {
        // Not JSON — assume plain text mode.
      }
      resolve(stdout);
    });
  });
}

/**
 * Extract a structured object from a URL. Pipes the page through camoufox,
 * then forces Claude into a single tool_use call whose JSON schema is built
 * from the caller-supplied Zod schema. The tool_use input is then validated
 * by Zod before return — anything the model emits that doesn't match the
 * schema raises a ZodError to the caller.
 */
export async function extractStructured<T>(opts: ExtractOptions<T>): Promise<T> {
  if (MOCK) {
    // Best-effort mock: parse() with empty object so schemas with all-optional
    // fields succeed; tests should provide MOCK_WEB_EXTRACT=false.
    return opts.schema.parse({});
  }

  const html = await camoufoxFetch(opts.url);
  const truncated = html.slice(0, opts.htmlLimit ?? HTML_LIMIT);
  const inputSchema = zodToJsonSchema(opts.schema);

  const client = new Anthropic();
  const resp = await client.messages.create({
    model: opts.model ?? MODEL,
    max_tokens: 4096,
    tools: [
      {
        name: "emit_result",
        description: opts.goal,
        input_schema: inputSchema as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: "tool", name: "emit_result" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `URL: ${opts.url}` },
          { type: "text", text: `Goal: ${opts.goal}` },
          {
            type: "text",
            text: `Below is the rendered page content. Extract the structured result and call emit_result.\n\n---\n${truncated}`,
          },
        ],
      },
    ],
  });

  const toolUse = resp.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === "emit_result"
  );
  if (!toolUse) {
    throw new Error("web-extract: model did not call emit_result");
  }

  return opts.schema.parse(toolUse.input);
}
