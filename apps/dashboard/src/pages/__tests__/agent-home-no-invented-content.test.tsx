// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  GUARDED_CLAIMS,
  PUBLISHED_SURFACES,
  findClaimViolations,
  publishedText,
} from "../../lib/public-claims.js";
import { AgentChatPage } from "../AgentChatPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PAGE_PATH = "apps/dashboard/src/pages/AgentChatPage.tsx";
const source = readFileSync(resolve(process.cwd(), "src/pages/AgentChatPage.tsx"), "utf8");

describe("agent home published content", () => {
  it("gives every button a click handler or a disabled explanation", () => {
    const file = ts.createSourceFile(PAGE_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const failures: string[] = [];
    let buttons = 0;

    function visit(node: ts.Node) {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        if (opening.tagName.getText(file) === "button") {
          buttons++;
          const attributes = new Set(opening.attributes.properties
            .filter(ts.isJsxAttribute)
            .map((attribute) => attribute.name.getText(file)));
          if (!attributes.has("onClick") && !(attributes.has("disabled") && attributes.has("title"))) {
            const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
            const text = ts.isJsxElement(node)
              ? node.children.map((child) => child.getText(file)).join(" ").replace(/\s+/g, " ").trim()
              : "";
            failures.push(`line ${line}: ${text}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(file);
    expect(buttons).toBeGreaterThan(0);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("omits invented bounty, capability and operator content from published text", () => {
    const text = publishedText(PAGE_PATH, source);
    for (const removed of [
      "CLAIM BOUNTY",
      "Claim a bounty",
      "earn rewards",
      "USE THIS",
      "already live",
      "Ready to use",
      "Top operators on the network",
      "BOUNTIES",
      "LEADERBOARD",
    ]) {
      expect(text).not.toContain(removed);
    }
  });

  it("opens the catalog when Explore the Network is clicked", async () => {
    // The page and router render directly in jsdom; no mocks are needed.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/" element={<AgentChatPage />} />
            <Route path="/discover" element={<div data-testid="catalog" />} />
          </Routes>
        </MemoryRouter>,
      ));
      expect(host.querySelector('[data-testid="catalog"]')).toBeNull();
      const button = [...host.querySelectorAll("button")]
        .find((candidate) => candidate.textContent?.trim() === "Explore the Network");
      expect(button).toBeDefined();
      await act(async () => button!.click());
      expect(host.querySelector('[data-testid="catalog"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("checks the agent home and guards bounty reward claims without matching onboarding help", () => {
    expect(PUBLISHED_SURFACES).toContain(PAGE_PATH);
    const claim = GUARDED_CLAIMS.find((candidate) => candidate.id === "bounty-rewards");
    expect(claim).toBeDefined();
    expect(claim?.status).not.toBe("live");
    for (const text of [
      "Capabilities in demand right now. Claim a bounty, earn rewards.",
      "CLAIM BOUNTY",
    ]) {
      expect(findClaimViolations(text).map((violation) => violation.id)).toContain("bounty-rewards");
    }
    expect(findClaimViolations("Help them onboard equipment, configure kernels, manage jobs, earn rewards")).toEqual([]);
  });

  it("omits the retired hero tagline from published text", () => {
    const text = publishedText(PAGE_PATH, source);
    expect(text).not.toContain("AWS for the physical world");
  });

  it("omits the invented Capabilities stat from published text", () => {
    const text = publishedText(PAGE_PATH, source);
    expect(text).not.toContain("target={847}");
  });

  it("omits the invented Operators stat from published text", () => {
    const text = publishedText(PAGE_PATH, source);
    expect(text).not.toContain("target={163}");
  });

  it("omits the invented Jobs Completed stat from published text", () => {
    const text = publishedText(PAGE_PATH, source);
    expect(text).not.toContain("target={12438}");
    expect(text).not.toContain("Jobs Completed");
  });
});
