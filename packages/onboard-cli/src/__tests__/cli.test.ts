/**
 * Tests for cli.ts argv parsing + the static --print-snippet flow.
 *
 * Interactive runs need stdin/stdout + Anthropic, so we don't exercise the
 * full REPL here — onboard-loop.test.ts covers the chat-loop machinery.
 */
import { describe, it, expect } from "vitest";
import { parseArgs, COPY_PASTE_SNIPPET, main } from "../cli.js";

describe("parseArgs", () => {
  it("parses --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("parses --version", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  it("parses --print-snippet", () => {
    expect(parseArgs(["--print-snippet"]).printSnippet).toBe(true);
  });

  it("parses string flags", () => {
    const args = parseArgs([
      "--api-key", "sk-test",
      "--gateway", "http://localhost:3000",
      "--model", "claude-haiku-4-5",
    ]);
    expect(args.apiKey).toBe("sk-test");
    expect(args.gateway).toBe("http://localhost:3000");
    expect(args.model).toBe("claude-haiku-4-5");
  });

  it("parses valid --role", () => {
    expect(parseArgs(["--role", "buyer"]).role).toBe("buyer");
    expect(parseArgs(["--role", "operator"]).role).toBe("operator");
    expect(parseArgs(["--role", "machine-owner"]).role).toBe("machine-owner");
  });

  it("collects unknown args into remaining", () => {
    const args = parseArgs(["--something-else", "value"]);
    expect(args.remaining).toContain("--something-else");
  });

  it("parses --persist", () => {
    expect(parseArgs(["--persist"]).persist).toBe(true);
  });

  it("parses --pcc-key", () => {
    expect(parseArgs(["--pcc-key", "pcc_live_abc"]).pccApiKey).toBe("pcc_live_abc");
  });
});

describe("COPY_PASTE_SNIPPET", () => {
  it("mentions capability.network", () => {
    expect(COPY_PASTE_SNIPPET).toContain("capability.network");
  });

  it("references agent-package.json", () => {
    expect(COPY_PASTE_SNIPPET).toContain("agent-package.json");
  });

  it("tells the host LLM to ask the user about role", () => {
    // The exact prompts vary in style ("buy", "offer", "connect"); we just
    // want to confirm the snippet primes the LLM to drive the conversation.
    expect(COPY_PASTE_SNIPPET.toLowerCase()).toMatch(/buy|offer|connect|register/);
  });

  it("includes how to call endpoints", () => {
    expect(COPY_PASTE_SNIPPET).toContain("endpoint");
  });
});

describe("main()", () => {
  it("--print-snippet writes the snippet and returns 0", async () => {
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: any) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await main(["--print-snippet"]);
      expect(code).toBe(0);
      const output = chunks.join("");
      expect(output).toContain("capability.network");
      expect(output).toContain("agent-package.json");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("--help writes usage and returns 0", async () => {
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: any) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await main(["--help"]);
      expect(code).toBe(0);
      const output = chunks.join("");
      expect(output).toContain("@pcc/onboard");
      expect(output).toContain("Usage:");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("--version prints the package version", async () => {
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: any) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await main(["--version"]);
      expect(code).toBe(0);
      expect(chunks.join("")).toMatch(/0\.1\.0/);
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
