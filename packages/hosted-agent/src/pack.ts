/**
 * The hosted agent runs the pack it was deployed with, or it does not start.
 *
 * At startup it fetches the agent package the gateway serves (the same file
 * /mcp reads) and compares it with the deploy-time pin: the version, and the
 * sha256 of the exact bytes, never of a re-serialization (adk #3949). Any
 * difference refuses the start. The tool specs the policy classifies (name,
 * method, path) and the system prompt come from these verified bytes only.
 */
import { createHash } from "node:crypto";
import type { ToolDef } from "./confirm.js";
import type { ToolSpec } from "./policy.js";

export interface PackPin {
  readonly version: string;
  /** Lowercase hex sha256 of the served bytes. */
  readonly sha256: string;
}

export interface PinnedPack {
  readonly version: string;
  readonly sha256: string;
  readonly systemPrompt: string;
  readonly tools: ReadonlyArray<{ readonly def: ToolDef; readonly spec: ToolSpec }>;
}

export class PackPinMismatch extends Error {
  constructor(
    readonly field: "pin" | "sha256" | "encoding" | "version" | "shape",
    detail: string,
  ) {
    super(`agent package refused (${field}): ${detail}`);
    this.name = "PackPinMismatch";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export async function loadPinnedPack(fetchBytes: () => Promise<Uint8Array>, pin: PackPin): Promise<PinnedPack> {
  if (!/^[0-9a-f]{64}$/.test(pin.sha256)) throw new PackPinMismatch("pin", "sha256 must be 64 lowercase hex digits");
  if (typeof pin.version !== "string" || pin.version.length === 0) throw new PackPinMismatch("pin", "version is required");

  const bytes = await fetchBytes();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== pin.sha256) throw new PackPinMismatch("sha256", `served ${sha256}, pinned ${pin.sha256}`);

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PackPinMismatch("encoding", "the package is not valid UTF-8");
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new PackPinMismatch("shape", "the package is not JSON");
  }
  if (!isObject(doc)) throw new PackPinMismatch("shape", "the package is not an object");
  if (doc.version !== pin.version) throw new PackPinMismatch("version", `served ${String(doc.version)}, pinned ${pin.version}`);
  if (typeof doc.system_prompt !== "string") throw new PackPinMismatch("shape", "system_prompt is not a string");
  if (!Array.isArray(doc.tools)) throw new PackPinMismatch("shape", "tools is not an array");

  const seen = new Set<string>();
  const tools = doc.tools.map((t: unknown, i: number) => {
    if (!isObject(t) || typeof t.name !== "string" || t.name.length === 0) throw new PackPinMismatch("shape", `tool ${i} has no name`);
    if (seen.has(t.name)) throw new PackPinMismatch("shape", `tool "${t.name}" appears twice`);
    seen.add(t.name);
    const e = t.endpoint;
    if (!isObject(e) || typeof e.method !== "string" || typeof e.path !== "string") {
      throw new PackPinMismatch("shape", `tool "${t.name}" has no endpoint method and path`);
    }
    if (!isObject(t.input_schema)) throw new PackPinMismatch("shape", `tool "${t.name}" has no input_schema object`);
    const def = {
      name: t.name,
      description: typeof t.description === "string" ? t.description : "",
      input_schema: t.input_schema,
    } as ToolDef;
    return { def, spec: { name: t.name, method: e.method, path: e.path } };
  });
  return { version: pin.version, sha256, systemPrompt: doc.system_prompt, tools };
}
