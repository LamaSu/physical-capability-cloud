// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PCC_BETA_STATUS, PCC_BRAND, PCC_THESIS } from "../positioning.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

// Surfaces that say in one line what PCC is: to a visitor, a search or answer
// engine, or an agent. Each carries the thesis (the claims check makes sure the
// public-beta status sits beside it).
const THESIS_SURFACES = [
  "apps/dashboard/public/landing.html",
  "apps/dashboard/index.html",
  "apps/dashboard/public/about.html",
  "apps/dashboard/public/about.md",
  "apps/dashboard/public/index.md",
  "apps/dashboard/public/llms.txt",
  "apps/dashboard/public/.well-known/ai-agent.json",
  "apps/dashboard/public/unbrowse-skills.json",
  "packages/gateway/src/routes/start.ts",
  "packages/gateway/src/routes/docs.ts",
  "packages/gateway/src/routes/context-pack.ts",
  "packages/gateway/src/server.ts",
  "docs/quickstart/README.md",
];

describe("PCC positioning", () => {
  it("keeps the operator's thesis word for word", () => {
    expect(PCC_THESIS).toBe(
      "Turn abilities and inventions into trusted, economically callable capacity that other agents can immediately build on.",
    );
    expect(PCC_BETA_STATUS).toBe("Public beta: payments settle on a test network.");
  });

  it.each(THESIS_SURFACES.map((path) => [path]))("%s states the thesis", (path) => {
    // Prose can lower-case the first word ("PCC: turn abilities…").
    expect(read(path).toLowerCase()).toContain(PCC_THESIS.toLowerCase());
  });

  it("titles the dashboard with the name and the brand handle", () => {
    expect(read("apps/dashboard/index.html")).toContain(
      `<title>Physical Capability Cloud — ${PCC_BRAND}</title>`,
    );
  });

  it("keeps the brand handle in the landing hero label, directly above the H1", () => {
    const label = /<p class="label[^"]*">([^<]*)<\/p>\s*<h1\b/.exec(read("apps/dashboard/public/landing.html"));
    expect(label, "landing.html: expected a label paragraph directly above the hero <h1>").not.toBeNull();
    expect(label![1].toLowerCase()).toBe(PCC_BRAND);
  });
});
