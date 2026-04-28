import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { EventEmitter } from "node:events";

// We mock the Anthropic SDK and node:child_process before importing the SUT
// so the constructor in web-extract.ts picks up the mocks.

const messagesCreateMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: messagesCreateMock };
  }
  return { default: MockAnthropic };
});

// Mock spawn to return a controllable subprocess.
let spawnImpl: (() => MockProc) | null = null;
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: vi.fn(() => {
      if (!spawnImpl) throw new Error("spawnImpl not set in test");
      return spawnImpl();
    }),
  };
});

// Force off MOCK so the real path runs against the mocked deps.
process.env.MOCK_WEB_EXTRACT = "false";

// Imports must come AFTER vi.mock above.
const { extractStructured, camoufoxFetch } = await import("../web-extract.js");
const { zodToJsonSchema } = await import("../zod-json-schema.js");

class MockProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function makeProc(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  spawnError?: Error;
  delayMs?: number;
}): MockProc {
  const proc = new MockProc();
  setImmediate(() => {
    if (opts.spawnError) {
      proc.emit("error", opts.spawnError);
      return;
    }
    if (opts.stdout) proc.stdout.emit("data", Buffer.from(opts.stdout, "utf8"));
    if (opts.stderr) proc.stderr.emit("data", Buffer.from(opts.stderr, "utf8"));
    setTimeout(() => proc.emit("close", opts.exitCode ?? 0), opts.delayMs ?? 0);
  });
  return proc;
}

beforeEach(() => {
  messagesCreateMock.mockReset();
  spawnImpl = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("camoufoxFetch", () => {
  it("returns the parsed text content from MCP-style JSON output", async () => {
    spawnImpl = () =>
      makeProc({
        stdout: JSON.stringify({
          content: [{ type: "text", text: "<html><body>hello</body></html>" }],
        }),
      });

    const html = await camoufoxFetch("https://example.com");
    expect(html).toContain("<body>hello</body>");
  });

  it("falls back to raw stdout when output is not JSON", async () => {
    spawnImpl = () => makeProc({ stdout: "<html>plain</html>" });
    const html = await camoufoxFetch("https://example.com");
    expect(html).toBe("<html>plain</html>");
  });

  it("rejects on non-zero exit", async () => {
    spawnImpl = () => makeProc({ exitCode: 1, stderr: "boom", stdout: "  " });
    await expect(camoufoxFetch("https://example.com")).rejects.toThrow(/exited 1.*boom/);
  });

  it("rejects on spawn error", async () => {
    spawnImpl = () => makeProc({ spawnError: new Error("ENOENT") });
    await expect(camoufoxFetch("https://example.com")).rejects.toThrow(/spawn failed.*ENOENT/);
  });

  it("rejects on empty stdout with zero exit", async () => {
    spawnImpl = () => makeProc({ stdout: "" });
    await expect(camoufoxFetch("https://example.com")).rejects.toThrow(/empty output/);
  });
});

describe("extractStructured", () => {
  const draftSchema = z.object({
    name: z.string(),
    machines: z
      .array(
        z.object({
          name: z.string(),
          kind: z.string().optional(),
        })
      )
      .optional(),
    contact: z.string().optional(),
  });

  it("returns the parsed Zod object when Claude calls emit_result correctly", async () => {
    spawnImpl = () =>
      makeProc({
        stdout: JSON.stringify({
          content: [{ type: "text", text: "<html>Oakland Titanium Mills</html>" }],
        }),
      });
    messagesCreateMock.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "emit_result",
          id: "tu_1",
          input: {
            name: "Oakland Titanium Mills",
            machines: [{ name: "Mazak Integrex", kind: "5-axis" }],
            contact: "ops@example.com",
          },
        },
      ],
    });

    const result = await extractStructured({
      url: "https://example.com",
      schema: draftSchema,
      goal: "extract company profile",
    });

    expect(result.name).toBe("Oakland Titanium Mills");
    expect(result.machines).toHaveLength(1);
    expect(result.machines?.[0]?.name).toBe("Mazak Integrex");
    expect(result.contact).toBe("ops@example.com");

    // Verify we passed the schema-derived input_schema to Claude.
    expect(messagesCreateMock).toHaveBeenCalledOnce();
    const call = messagesCreateMock.mock.calls[0]?.[0];
    expect(call.tool_choice).toEqual({ type: "tool", name: "emit_result" });
    expect(call.tools[0].name).toBe("emit_result");
    expect(call.tools[0].input_schema.type).toBe("object");
    expect(call.tools[0].input_schema.required).toContain("name");
  });

  it("throws ZodError when tool_use input is malformed", async () => {
    spawnImpl = () =>
      makeProc({
        stdout: JSON.stringify({ content: [{ type: "text", text: "<html>x</html>" }] }),
      });
    messagesCreateMock.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "emit_result",
          id: "tu_2",
          input: { name: 12345 }, // wrong type — should be string
        },
      ],
    });

    await expect(
      extractStructured({
        url: "https://example.com",
        schema: draftSchema,
        goal: "extract",
      })
    ).rejects.toThrow();
  });

  it("throws when model never produces a tool_use block", async () => {
    spawnImpl = () =>
      makeProc({
        stdout: JSON.stringify({ content: [{ type: "text", text: "<html>x</html>" }] }),
      });
    messagesCreateMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "I refuse." }],
    });

    await expect(
      extractStructured({
        url: "https://example.com",
        schema: draftSchema,
        goal: "extract",
      })
    ).rejects.toThrow(/did not call emit_result/);
  });

  it("propagates camoufox errors before reaching Claude", async () => {
    spawnImpl = () => makeProc({ exitCode: 2, stderr: "stealth blocked" });
    await expect(
      extractStructured({
        url: "https://example.com",
        schema: draftSchema,
        goal: "extract",
      })
    ).rejects.toThrow(/exited 2/);
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });
});

describe("zodToJsonSchema", () => {
  it("emits object schema with required fields and additionalProperties=false", () => {
    const schema = z.object({
      name: z.string(),
      hours: z.string().optional(),
    });
    const j = zodToJsonSchema(schema);
    expect(j.type).toBe("object");
    expect(j.required).toEqual(["name"]);
    expect(j.properties?.name?.type).toBe("string");
    expect(j.properties?.hours?.type).toBe("string");
    expect(j.additionalProperties).toBe(false);
  });

  it("emits array of objects", () => {
    const schema = z.array(z.object({ name: z.string() }));
    const j = zodToJsonSchema(schema);
    expect(j.type).toBe("array");
    expect(j.items?.type).toBe("object");
    expect(j.items?.required).toEqual(["name"]);
  });

  it("emits enum from z.enum and union of literals", () => {
    const a = zodToJsonSchema(z.enum(["a", "b", "c"]));
    expect(a.enum).toEqual(["a", "b", "c"]);

    const b = zodToJsonSchema(z.union([z.literal("x"), z.literal("y")]));
    expect(b.enum).toEqual(["x", "y"]);
  });
});
