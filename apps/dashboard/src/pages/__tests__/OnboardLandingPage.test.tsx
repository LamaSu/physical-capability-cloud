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

  it("gives the CLI's from-source command, never an unpublished npx or npm link (N26)", () => {
    // CHANGED (N26): this used to require "npx @pcc/onboard", but @pcc/onboard
    // is not published, so that command answers 404.
    expect(source).toContain("node packages/onboard-cli/dist/cli.js");
    expect(source).not.toMatch(/npx\s+(?:-y\s+)?@pcc\//);
    expect(source).not.toContain("npmjs.com/package/@pcc");
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

  it("links the CLI's source, not an npm page that answers 404 (N26)", () => {
    // CHANGED (N26): this used to require the npmjs.com page, but
    // @pcc/onboard is not published.
    expect(source).toContain("/tree/master/packages/onboard-cli");
    expect(source).not.toContain("npmjs.com/package/@pcc");
  });

  it("mentions the curl snippet.md path", () => {
    expect(source).toContain("snippet.md");
  });
});
