// @vitest-environment jsdom
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: { div: ({ children, className }: { children: ReactNode; className?: string }) => <div className={className}>{children}</div> },
}));

import { OnboardingTour } from "../components/OnboardingTour.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TITLES = [
  "Welcome to PCCP Command Center",
  "Key Performance Indicators",
  "Discover Capabilities",
  "Compare Capabilities",
  "Build a Contract",
  "Configure Parameters",
  "Live Pricing",
  "Review Contract",
  "Workflow Builder",
  "Connect Steps",
  "Evidence & Proof",
  "Settlement & Escrow",
  "Add an Instrument",
  "AI-Powered Setup",
  "Instrument Marketplace",
  "Find a Space",
  "Growing the Network",
] as const;

let container: HTMLDivElement;
let root: Root;
let originalSeen: string | null;

beforeEach(() => {
  originalSeen = localStorage.getItem("pcc-tour-seen");
  localStorage.removeItem("pcc-tour-seen");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (originalSeen === null) localStorage.removeItem("pcc-tour-seen");
  else localStorage.setItem("pcc-tour-seen", originalSeen);
});

describe("operator onboarding tour", () => {
  it("T17: keeps all 17 remaining steps and omits the removed operator step", async () => {
    await act(async () => root.render(<OnboardingTour />));

    for (const [index, title] of TITLES.entries()) {
      expect(container.querySelector("h3")?.textContent).toBe(title);
      expect(container.textContent).toContain(`Step ${index + 1} of 17`);
      expect(container.textContent).not.toMatch(/Operator Dashboard|earnings over time|certifications|schedule maintenance/);

      const label = index === TITLES.length - 1 ? "Get Started" : "Next →";
      const next = [...container.querySelectorAll("button")].find((button) => button.textContent === label);
      expect(next, label).toBeDefined();
      await act(async () => next!.click());
    }

    expect(container.textContent).toBe("");
    expect(localStorage.getItem("pcc-tour-seen")).toBe("true");
  });
});
