import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadPinnedPack, PackPinMismatch } from "../pack.js";

const here = dirname(fileURLToPath(import.meta.url));
const SERVED = new Uint8Array(readFileSync(resolve(here, "../../../../apps/dashboard/public/agent-package.json")));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const VERSION = (JSON.parse(new TextDecoder().decode(SERVED)) as { version: string }).version;
const PIN = { version: VERSION, sha256: sha(SERVED) };
const serve = (b: Uint8Array) => async () => b;

async function refusal(bytes: Uint8Array, pin = PIN): Promise<string | null> {
  try {
    await loadPinnedPack(serve(bytes), pin);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(PackPinMismatch);
    return (e as PackPinMismatch).field;
  }
}

describe("the pack pin", () => {
  it("the served package loads under its pin, with every tool's endpoint", async () => {
    const pack = await loadPinnedPack(serve(SERVED), PIN);
    expect(pack.version).toBe(VERSION);
    expect(pack.tools.length).toBeGreaterThan(200);
    expect(pack.tools.find((t) => t.def.name === "provision_api_key")!.spec).toEqual({
      name: "provision_api_key",
      method: "POST",
      path: "/api/auth/provision",
    });
    expect(pack.systemPrompt.length).toBeGreaterThan(1000);
  });

  it("one changed byte is refused", async () => {
    const changed = SERVED.slice();
    changed[changed.length - 10] ^= 0x01;
    expect(await refusal(changed)).toBe("sha256");
  });

  it("the same JSON re-serialized is refused: the pin is over the exact served bytes", async () => {
    const reserialized = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(SERVED))));
    expect(await refusal(reserialized)).toBe("sha256");
  });

  it("the right bytes under another version are refused", async () => {
    expect(await refusal(SERVED, { ...PIN, version: "9.9.9" })).toBe("version");
  });

  it("a malformed pin is refused before anything is fetched", async () => {
    let fetched = false;
    await expect(
      loadPinnedPack(async () => ((fetched = true), SERVED), { version: VERSION, sha256: PIN.sha256.toUpperCase() }),
    ).rejects.toThrow(/pin/);
    expect(fetched).toBe(false);
  });

  it("invalid UTF-8 is refused even when the pin matches it", async () => {
    const bad = new Uint8Array([0x7b, 0xff, 0x7d]);
    expect(await refusal(bad, { version: VERSION, sha256: sha(bad) })).toBe("encoding");
  });

  it.each([
    ["a tool without an endpoint", { version: "1", system_prompt: "p", tools: [{ name: "t", input_schema: {} }] }],
    ["a tool without a schema", { version: "1", system_prompt: "p", tools: [{ name: "t", endpoint: { method: "GET", path: "/x" } }] }],
    [
      "a duplicated tool name",
      {
        version: "1",
        system_prompt: "p",
        tools: [
          { name: "t", input_schema: {}, endpoint: { method: "GET", path: "/x" } },
          { name: "t", input_schema: {}, endpoint: { method: "POST", path: "/y" } },
        ],
      },
    ],
    ["no system prompt", { version: "1", tools: [] }],
  ])("%s is refused, even under a matching pin", async (_name, doc) => {
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    expect(await refusal(bytes, { version: "1", sha256: sha(bytes) })).toBe("shape");
  });

  it("a failed fetch fails the start", async () => {
    await expect(loadPinnedPack(async () => Promise.reject(new Error("unreachable")), PIN)).rejects.toThrow("unreachable");
  });
});
