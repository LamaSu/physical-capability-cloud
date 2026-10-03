/**
 * The agent package, pinned. The ADK carries no hand-written tool JSON
 * (#2392): generated/agent-pin.ts is generated from the package the dashboard
 * serves, with its version, tool count and the sha256 of its exact bytes.
 *
 * `resolveToolRequest` turns a tool call into an HTTP request against the
 * configured gateway. It is pure: no network, and no credentials, so the
 * caller decides where a key may go (the N50 lesson). It refuses any tool whose
 * endpoint is not a well-formed gateway path, such as an absolute localhost URL
 * or a path a URL parser would move to another route.
 *
 * The exported AGENT_PACKAGE_PIN and AGENT_TOOLS are deeply frozen, and
 * neither function reads them after load: both use private frozen copies taken
 * when this module loads (verdict 101).
 */

import { sha256 } from "@pcc/spec";
import { AGENT_PACKAGE_PIN, AGENT_TOOLS, type AgentToolName } from "./generated/agent-pin.js";
import type { AgentToolEndpoint } from "./agent-package-types.js";

export { AGENT_PACKAGE_PIN, AGENT_TOOLS };
export type { AgentToolName, AgentToolEndpoint };

export type AdkToolErrorCode =
  | "unknown_tool"
  | "not_a_gateway_path"
  | "bad_tool_endpoint"
  | "bad_input"
  | "missing_input"
  | "bad_path_param"
  | "bad_base_url";

export class AdkToolError extends Error {
  readonly code: AdkToolErrorCode;
  constructor(code: AdkToolErrorCode, message: string) {
    super(message);
    this.name = "AdkToolError";
    this.code = code;
  }
}

export interface ToolRequest {
  method: AgentToolEndpoint["method"];
  url: string;
  /** JSON body for POST, PUT and PATCH; absent for GET and DELETE. */
  body?: string;
}

// Private copies, taken once when this module loads. Nothing a caller does to
// the exported objects reaches them.
const PINNED = Object.freeze({
  version: String(AGENT_PACKAGE_PIN.version),
  toolCount: Number(AGENT_PACKAGE_PIN.toolCount),
  sha256: String(AGENT_PACKAGE_PIN.sha256),
});
const TOOLS: ReadonlyMap<string, AgentToolEndpoint> = new Map(
  Object.keys(AGENT_TOOLS).map((name): [string, AgentToolEndpoint] => {
    const tool = (AGENT_TOOLS as Record<string, AgentToolEndpoint>)[name];
    return [name, Object.freeze({ method: tool.method, path: tool.path, required: Object.freeze([...tool.required]) })];
  }),
);

// The endpoint rules. scripts/generate-agent-pin.mjs applies the same rules
// when it generates the pin; the tests check that the two agree.
const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const LITERAL_SEGMENT = /^[A-Za-z0-9\-._~!$&'()*+,;=:@]+$/;
const PLACEHOLDER_SEGMENT = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Why `path` is not a well-formed gateway path template, or null. Every
 * segment is a placeholder or plain path characters, so no query, fragment,
 * backslash, percent-escape or dot segment can reach a URL parser.
 */
function gatewayPathProblem(path: string): string | null {
  const names = new Set<string>();
  for (const segment of path.slice(1).split("/")) {
    const placeholder = PLACEHOLDER_SEGMENT.exec(segment);
    if (placeholder) {
      if (names.has(placeholder[1])) return `repeats the placeholder {${placeholder[1]}}`;
      names.add(placeholder[1]);
    } else if (!LITERAL_SEGMENT.test(segment)) {
      return `has a segment that is empty or needs escaping: ${JSON.stringify(segment)}`;
    } else if (segment === "." || segment === "..") {
      return `has a dot segment: ${JSON.stringify(segment)}`;
    }
  }
  return null;
}

function baseOrigin(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new AdkToolError("bad_base_url", `baseUrl is not a URL: ${baseUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AdkToolError("bad_base_url", `baseUrl must be http(s): ${baseUrl}`);
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new AdkToolError("bad_base_url", "baseUrl must not carry a query, fragment or credentials");
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

// A path parameter's characters (verdict 101b): ASCII letters and digits and - . _ ~ : @ + = , only. No /, \, %,
// ;, ?, #, space, control or non-ASCII character can reach the path, so no intermediary that decodes the
// path (or folds a lookalike solidus) can turn the value into a separator or a dot segment.
const PATH_PARAM = /^[A-Za-z0-9._~:@+=,-]+$/;

function pathParam(name: string, value: Json | undefined): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new AdkToolError("missing_input", `path parameter "${name}" is required`);
  }
  const text = String(value);
  // "." and ".." would be resolved away by URL normalization and move the call
  // to another route; an empty segment would do the same.
  if (text === "" || text === "." || text === "..") {
    throw new AdkToolError("bad_path_param", `path parameter "${name}" cannot be "${text}"`);
  }
  if (!PATH_PARAM.test(text)) {
    throw new AdkToolError(
      "bad_path_param",
      `path parameter "${name}" may hold only ASCII letters, digits and - . _ ~ : @ + = ,`,
    );
  }
  return encodeURIComponent(text);
}

// ── Input: plain JSON only, snapshotted once ────────────────────────────────
// The required-field check, the path parameters, the query and the body all
// read one snapshot, so no getter, proxy, inherited field or toJSON can show
// the check one value and the request another.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const MAX_DEPTH = 64;
// Bounds on one input (verdict 101b): values at all levels, items in one array, UTF-16 units in one string
// and in all strings together, UTF-8 bytes in the body, and characters in the URL.
const MAX_NODES = 100_000;
const MAX_ARRAY_LENGTH = 10_000;
const MAX_STRING_LENGTH = 1 << 20;
const MAX_TOTAL_CHARS = 4 << 20;
const MAX_BODY_BYTES = 1 << 20;
const MAX_URL_LENGTH = 8_192;

interface Budget {
  nodes: number;
  chars: number;
}

/** True when every surrogate in `text` is part of a pair: the string is valid Unicode. */
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** UTF-8 byte length of valid Unicode text. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** A string or key as the snapshot keeps it: valid Unicode, and within the bounds. */
function checkText(text: string, where: string, budget: Budget): void {
  if (text.length > MAX_STRING_LENGTH) bad(where, "is too long");
  if (!wellFormed(text)) bad(where, "is not valid Unicode (it has an unpaired surrogate)");
  budget.chars += text.length;
  if (budget.chars > MAX_TOTAL_CHARS) bad(where, "makes the input too large");
}

function bad(where: string, why: string): never {
  throw new AdkToolError("bad_input", `input${where} ${why}; only plain JSON data is sent`);
}

/** An own, enumerable data property's value. */
function dataProperty(target: object, key: string, where: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor) bad(where, "is missing");
  if (!("value" in descriptor)) bad(where, "is an accessor");
  if (!descriptor.enumerable) bad(where, "is not enumerable");
  return descriptor.value;
}

function plainObject(value: object, where: string, depth: number, open: Set<object>, budget: Budget): { [key: string]: Json } {
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) bad(where, "is not a plain object");
  const out: { [key: string]: Json } = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") bad(where, "has a symbol key");
    checkText(key, `${where} (a key)`, budget);
    const at = `${where}.${key}`;
    const item = dataProperty(value, key, at);
    if (item === undefined) continue; // dropped, as JSON.stringify drops it
    Object.defineProperty(out, key, {
      value: plain(item, at, depth + 1, open, budget),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function plainArray(value: unknown[], where: string, depth: number, open: Set<object>, budget: Budget): Json[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) bad(where, "is not a plain array");
  // "length" is the one own property of an array that is not enumerable.
  const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || !Number.isInteger(length)) bad(where, "has no length");
  // Checked before anything is listed or copied, so a huge array costs nothing (verdict 101b).
  if (length > MAX_ARRAY_LENGTH) bad(where, `has more than ${MAX_ARRAY_LENGTH} items`);
  // Exactly the indexes and "length": no holes and no extra properties.
  if (Reflect.ownKeys(value).length !== length + 1) bad(where, "has holes or extra properties");
  const out: Json[] = [];
  for (let i = 0; i < length; i++) {
    const at = `${where}[${i}]`;
    const item = dataProperty(value, String(i), at);
    if (item === undefined) bad(at, "is undefined");
    out.push(plain(item, at, depth + 1, open, budget));
  }
  return out;
}

function plain(value: unknown, where: string, depth: number, open: Set<object>, budget: Budget): Json {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) bad(where, "makes the input too large");
  if (typeof value === "string") {
    checkText(value, where, budget);
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) bad(where, "is not a finite number");
    return value;
  }
  if (typeof value !== "object") bad(where, `is a ${typeof value}`);
  if (depth >= MAX_DEPTH) bad(where, "is nested too deeply");
  if (open.has(value)) bad(where, "contains itself");
  open.add(value);
  try {
    return Array.isArray(value) ? plainArray(value, where, depth, open, budget) : plainObject(value, where, depth, open, budget);
  } finally {
    open.delete(value);
  }
}

function snapshotInput(input: unknown): { [key: string]: Json } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) bad("", "must be a plain object");
  return plainObject(input, "", 0, new Set([input]), { nodes: 0, chars: 0 });
}

/** JSON text for a snapshot. It never consults toJSON, so the text is the snapshot. */
function jsonText(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jsonText).join(",")}]`;
  return `{${Object.keys(value)
    .map((key) => `${JSON.stringify(key)}:${jsonText(value[key])}`)
    .join(",")}}`;
}

function queryString(data: { [key: string]: Json }): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(data).sort()) {
    const value = data[key];
    if (value === null) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      params.append(key, v !== null && typeof v === "object" ? jsonText(v) : String(v));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * The HTTP request for one agent-package tool call, against `baseUrl`.
 * Throws AdkToolError; never touches the network.
 */
export function resolveToolRequest(
  name: string,
  input: Record<string, unknown>,
  options: { baseUrl: string },
): ToolRequest {
  // A Map: "constructor", "__proto__" and the like are not tools.
  const tool = typeof name === "string" ? TOOLS.get(name) : undefined;
  if (!tool) throw new AdkToolError("unknown_tool", `no tool named "${String(name)}" in agent package ${PINNED.version}`);
  if (!tool.path.startsWith("/") || tool.path.startsWith("//")) {
    throw new AdkToolError(
      "not_a_gateway_path",
      `tool "${name}" points at ${tool.path}, not a gateway path; the ADK will not call it`,
    );
  }
  const problem = METHODS.has(tool.method) ? gatewayPathProblem(tool.path) : "has an unknown method";
  if (problem) {
    throw new AdkToolError(
      "bad_tool_endpoint",
      `tool "${name}" endpoint ${tool.method} ${tool.path} ${problem}; the ADK will not call it`,
    );
  }

  const data = snapshotInput(input);
  const missing = tool.required.filter((field) => !Object.hasOwn(data, field) || data[field] === null);
  if (missing.length > 0) {
    throw new AdkToolError("missing_input", `tool "${name}" needs: ${missing.join(", ")}`);
  }

  const path = tool.path
    .split("/")
    .map((segment) => {
      const placeholder = PLACEHOLDER_SEGMENT.exec(segment);
      if (!placeholder) return segment;
      const param = placeholder[1];
      const encoded = pathParam(param, Object.hasOwn(data, param) ? data[param] : undefined);
      delete data[param];
      return encoded;
    })
    .join("/");

  const origin = baseOrigin(options.baseUrl);
  const read = tool.method === "GET" || tool.method === "DELETE";
  const url = read ? `${origin}${path}${queryString(data)}` : `${origin}${path}`;
  if (url.length > MAX_URL_LENGTH) bad("", `would make a URL longer than ${MAX_URL_LENGTH} characters`);
  // Belt and braces: the URL a client would send is the one built here.
  if (new URL(url).href !== url) {
    throw new AdkToolError("bad_tool_endpoint", `tool "${name}" would not be sent to ${url} as built`);
  }
  if (read) return { method: tool.method, url };
  const body = jsonText(data);
  if (utf8Length(body) > MAX_BODY_BYTES) bad("", `would make a body larger than ${MAX_BODY_BYTES} bytes`);
  return { method: tool.method, url, body };
}

export interface AgentPackageCheck {
  /**
   * True when the live bytes are exactly the pinned ones. This says what was
   * served, not who served it: anyone can serve these public bytes, so a match
   * does not authenticate the server or make it safe to send it a key.
   */
  matches: boolean;
  pinned: { version: string; toolCount: number; sha256: string };
  live: { version: string | null; toolCount: number | null; sha256: string };
}

/** Compare a live /agent-package.json (its exact text) with the pin. */
export async function checkAgentPackage(text: string): Promise<AgentPackageCheck> {
  const liveSha = await sha256(text);
  let version: string | null = null;
  let toolCount: number | null = null;
  try {
    const parsed = JSON.parse(text) as { version?: unknown; tools?: unknown };
    version = typeof parsed.version === "string" ? parsed.version : null;
    toolCount = Array.isArray(parsed.tools) ? parsed.tools.length : null;
  } catch {
    // Not JSON: it cannot match, and there is nothing to read.
  }
  return {
    matches: liveSha === PINNED.sha256,
    pinned: { version: PINNED.version, toolCount: PINNED.toolCount, sha256: PINNED.sha256 },
    live: { version, toolCount, sha256: liveSha },
  };
}
