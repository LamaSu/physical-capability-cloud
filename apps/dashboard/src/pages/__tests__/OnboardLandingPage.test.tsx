/**
 * Tests for OnboardLandingPage's static surface.
 *
 * The dashboard has no React Testing Library wired in, so we focus on
 * what's testable in isolation: the file imports cleanly, exports the
 * page component, and the embedded copy-paste snippet is well-formed.
 *
 * We READ the source as text and assert on the snippet string so we don't
 * have to import @pcc/ui (which needs the full Tailwind/JSX runtime).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, "../OnboardLandingPage.tsx");
const source = readFileSync(sourcePath, "utf-8");

describe("OnboardLandingPage — embedded snippet", () => {
  it("references the gateway", () => {
    expect(source).toContain("https://capability.network");
  });

  it("instructs the host LLM to fetch agent-package.json", () => {
    expect(source).toContain("agent-package.json");
  });

  it("uses the system_prompt field from the package", () => {
    expect(source).toContain("system_prompt");
  });

  it("primes the LLM to ask about role (buy/offer/connect)", () => {
    // The snippet should make the host LLM lead the conversation, not just dump info.
    expect(source.toLowerCase()).toMatch(/buy|offer|connect|register/);
  });

  it("includes the npx command", () => {
    expect(source).toContain("npx @pcc/onboard");
  });
});

describe("OnboardLandingPage — three-card hero", () => {
  it("renders the 'Chat right now' card", () => {
    expect(source).toContain("Chat right now");
  });

  it("renders the paste-into-your-AI card", () => {
    expect(source).toMatch(/Paste into|paste/i);
  });

  it("renders the npx install card", () => {
    expect(source).toMatch(/Install via npx|npx/i);
  });

  it("keeps secondary pathways for power users", () => {
    expect(source).toContain("Add a Machine");
    expect(source).toContain("Onboard Kit");
    expect(source).toContain("Marketplace");
    expect(source).toContain("Find a Space");
  });

  it("provides a copy-to-clipboard affordance", () => {
    expect(source).toContain("clipboard");
  });

  it("links the npm page", () => {
    expect(source).toContain("npmjs.com/package/@pcc/onboard");
  });

  it("mentions the curl snippet.md path", () => {
    expect(source).toContain("snippet.md");
  });
});
