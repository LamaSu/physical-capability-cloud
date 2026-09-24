/**
 * POST /api/capabilities/templates/match returns only {slug, score, reason}.
 * The card's name, description and class come from the template directory
 * (GET /api/orchestrator/templates). Before, the card read them from the
 * match and rendered a blank name, a blank description, and a "digital"
 * (gold) badge for every template, the physical one included.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateMatchFinder } from "../TemplateMatchFinder.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MATCHES = {
  matches: [
    { slug: "physical-operator", score: 0.8, reason: "mentions a 3D printer" },
    { slug: "data-product", score: 0.1, reason: "few data words" },
  ],
};
const DIRECTORY = {
  templates: [
    { slug: "physical-operator", display_name: "Physical Operator", description: "Offer a machine you run.", capability_class: "physical" },
    { slug: "data-product", display_name: "Data Product", description: "Publish a queryable dataset.", capability_class: "digital" },
  ],
};

let container: HTMLDivElement;
let root: Root;
let directoryReply: { status: number; body: unknown } | "network-error";
let matchReply: { status: number; body: unknown };

beforeEach(() => {
  directoryReply = { status: 200, body: DIRECTORY };
  matchReply = { status: 200, body: MATCHES };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const reply = url.endsWith("/api/orchestrator/templates") ? directoryReply : matchReply;
      if (reply === "network-error") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function match(query: string) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <TemplateMatchFinder />
      </MemoryRouter>,
    );
  });
  const input = container.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Match")!;
  await act(async () => {
    button.click();
    await new Promise((r) => setTimeout(r, 20));
  });
}

const cards = () => [...container.querySelectorAll("button")].filter((b) => b.textContent?.includes("match "));

describe("TemplateMatchFinder", () => {
  it("names each match from the template directory, with its real class", async () => {
    await match("I run a 3D printing shop");
    const [first, second] = cards();
    expect(first!.textContent).toContain("Physical Operator");
    expect(first!.textContent).toContain("physical");
    expect(first!.textContent).toContain("Offer a machine you run.");
    expect(first!.textContent).toContain("match 80%");
    expect(second!.textContent).toContain("Data Product");
    expect(second!.textContent).toContain("digital");
  });

  it("when the directory can't be read, shows the slug and no class rather than blanks or a guess", async () => {
    directoryReply = "network-error";
    await match("I run a 3D printing shop");
    const [first] = cards();
    expect(first!.textContent).toContain("physical-operator");
    expect(first!.textContent).not.toMatch(/\bdigital\b|\bphysical\b(?!-)/);
    expect(first!.textContent).toContain("Template details couldn't be loaded from the gateway.");
  });

  it("a failed match says so", async () => {
    matchReply = { status: 500, body: { error: "boom" } };
    await match("anything");
    expect(container.textContent).toContain("HTTP 500");
    expect(cards()).toHaveLength(0);
  });
});
