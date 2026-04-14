/**
 * AssuranceScoreBadge unit tests.
 *
 * No React Testing Library is wired into the dashboard, so tests exercise:
 *   1. The exported pure helpers (scoreToColor, formatScore)
 *   2. The component invoked as a function, inspecting the returned element's
 *      props (className, children). Valid for pure functional components.
 */

import { describe, it, expect } from "vitest";
import React from "react";
import {
  AssuranceScoreBadge,
  scoreToColor,
  formatScore,
  COLOR_CLASSES,
  SIZE_CLASSES,
} from "../AssuranceScoreBadge.js";

// Helper: invoke the component as a function and return the resulting element.
function render(props: React.ComponentProps<typeof AssuranceScoreBadge>) {
  return AssuranceScoreBadge(props) as React.ReactElement<{
    className: string;
    children: React.ReactNode;
    title?: string;
    "aria-label"?: string;
    "data-assurance-color"?: string;
    "data-assurance-size"?: string;
  }>;
}

// ── scoreToColor ────────────────────────────────────────────────────────────

describe("scoreToColor", () => {
  it("returns red for score at 0.3 (< 0.5)", () => {
    expect(scoreToColor(0.3)).toBe("red");
  });

  it("returns amber for score at 0.6 (0.5 ≤ s < 0.7)", () => {
    expect(scoreToColor(0.6)).toBe("amber");
  });

  it("returns yellow for score at 0.8 (0.7 ≤ s < 0.85)", () => {
    expect(scoreToColor(0.8)).toBe("yellow");
  });

  it("returns green for score at 0.95 (≥ 0.85)", () => {
    expect(scoreToColor(0.95)).toBe("green");
  });

  it("returns neutral for null", () => {
    expect(scoreToColor(null)).toBe("neutral");
  });

  it("returns neutral for undefined", () => {
    expect(scoreToColor(undefined)).toBe("neutral");
  });

  it("returns neutral for NaN", () => {
    expect(scoreToColor(NaN)).toBe("neutral");
  });

  it("returns neutral for out-of-range scores", () => {
    expect(scoreToColor(-0.1)).toBe("neutral");
    expect(scoreToColor(1.5)).toBe("neutral");
  });

  it("uses strict lower bound at 0.5 (amber not red)", () => {
    expect(scoreToColor(0.5)).toBe("amber");
  });

  it("uses strict lower bound at 0.7 (yellow not amber)", () => {
    expect(scoreToColor(0.7)).toBe("yellow");
  });

  it("uses strict lower bound at 0.85 (green not yellow)", () => {
    expect(scoreToColor(0.85)).toBe("green");
  });

  it("handles exact boundary at 1.0 as green", () => {
    expect(scoreToColor(1.0)).toBe("green");
  });

  it("handles exact boundary at 0.0 as red", () => {
    expect(scoreToColor(0.0)).toBe("red");
  });
});

// ── formatScore ─────────────────────────────────────────────────────────────

describe("formatScore", () => {
  it("formats 2-digit precision by default", () => {
    expect(formatScore(0.926)).toBe("0.93");
  });

  it("rounds down when third digit is < 5", () => {
    expect(formatScore(0.924)).toBe("0.92");
  });

  it("rounds up when third digit is ≥ 5", () => {
    expect(formatScore(0.925)).toBe("0.93");
  });

  it("formats as percent when showPercent=true", () => {
    expect(formatScore(0.926, true)).toBe("93%");
  });

  it("percent rounds to nearest integer", () => {
    expect(formatScore(0.924, true)).toBe("92%");
  });

  it("renders em-dash for null", () => {
    expect(formatScore(null)).toBe("—");
  });

  it("renders em-dash for undefined", () => {
    expect(formatScore(undefined)).toBe("—");
  });

  it("renders em-dash for null regardless of showPercent", () => {
    expect(formatScore(null, true)).toBe("—");
  });

  it("renders em-dash for NaN", () => {
    expect(formatScore(NaN)).toBe("—");
  });

  it("handles zero correctly", () => {
    expect(formatScore(0)).toBe("0.00");
    expect(formatScore(0, true)).toBe("0%");
  });

  it("handles one correctly", () => {
    expect(formatScore(1)).toBe("1.00");
    expect(formatScore(1, true)).toBe("100%");
  });
});

// ── AssuranceScoreBadge (component via function invocation) ─────────────────

describe("AssuranceScoreBadge", () => {
  it("applies red color class at score 0.3", () => {
    const el = render({ score: 0.3 });
    expect(el.props.className).toContain("text-red-400");
    expect(el.props["data-assurance-color"]).toBe("red");
    expect(el.props.children).toBe("0.30");
  });

  it("applies amber color class at score 0.6", () => {
    const el = render({ score: 0.6 });
    expect(el.props.className).toContain("text-amber-400");
    expect(el.props["data-assurance-color"]).toBe("amber");
    expect(el.props.children).toBe("0.60");
  });

  it("applies yellow color class at score 0.8", () => {
    const el = render({ score: 0.8 });
    expect(el.props.className).toContain("text-yellow-300");
    expect(el.props["data-assurance-color"]).toBe("yellow");
    expect(el.props.children).toBe("0.80");
  });

  it("applies green color class at score 0.95", () => {
    const el = render({ score: 0.95 });
    expect(el.props.className).toContain("text-green-400");
    expect(el.props["data-assurance-color"]).toBe("green");
    expect(el.props.children).toBe("0.95");
  });

  it("renders em-dash in neutral gray for null", () => {
    const el = render({ score: null });
    expect(el.props.children).toBe("—");
    expect(el.props["data-assurance-color"]).toBe("neutral");
    expect(el.props.className).toContain("text-white/40");
  });

  it("renders em-dash in neutral gray for undefined", () => {
    const el = render({ score: undefined });
    expect(el.props.children).toBe("—");
    expect(el.props["data-assurance-color"]).toBe("neutral");
  });

  it("formats 0.926 as '0.93' with 2-digit precision", () => {
    const el = render({ score: 0.926 });
    expect(el.props.children).toBe("0.93");
  });

  it("formats as percent when showPercent=true", () => {
    const el = render({ score: 0.92, showPercent: true });
    expect(el.props.children).toBe("92%");
  });

  it("size='sm' uses small size classes", () => {
    const el = render({ score: 0.9, size: "sm" });
    expect(el.props.className).toContain(SIZE_CLASSES.sm);
    expect(el.props["data-assurance-size"]).toBe("sm");
  });

  it("size='lg' uses large size classes", () => {
    const el = render({ score: 0.9, size: "lg" });
    expect(el.props.className).toContain(SIZE_CLASSES.lg);
    expect(el.props["data-assurance-size"]).toBe("lg");
  });

  it("default size is 'md'", () => {
    const el = render({ score: 0.9 });
    expect(el.props["data-assurance-size"]).toBe("md");
    expect(el.props.className).toContain(SIZE_CLASSES.md);
  });

  it("size='sm' and size='lg' produce different class strings", () => {
    const sm = render({ score: 0.9, size: "sm" });
    const lg = render({ score: 0.9, size: "lg" });
    expect(sm.props.className).not.toBe(lg.props.className);
  });

  it("merges a user-provided className", () => {
    const el = render({ score: 0.9, className: "ml-2 custom-class" });
    expect(el.props.className).toContain("custom-class");
    expect(el.props.className).toContain("ml-2");
  });

  it("sets a tooltip describing the assurance score", () => {
    const el = render({ score: 0.9 });
    expect(el.props.title).toContain("Assurance Score");
    expect(el.props.title).toContain("ALCOA+");
  });

  it("sets a descriptive aria-label for screen readers", () => {
    const el = render({ score: 0.9 });
    expect(el.props["aria-label"]).toBe("Assurance score 0.90");
  });

  it("sets a 'not available' aria-label when score is null", () => {
    const el = render({ score: null });
    expect(el.props["aria-label"]).toBe("Assurance score not available");
  });
});

// ── COLOR_CLASSES table ─────────────────────────────────────────────────────

describe("COLOR_CLASSES table", () => {
  it("defines a class string for every AssuranceColor value", () => {
    const expected = ["red", "amber", "yellow", "green", "neutral"];
    for (const c of expected) {
      expect(COLOR_CLASSES[c as keyof typeof COLOR_CLASSES]).toBeTruthy();
      expect(typeof COLOR_CLASSES[c as keyof typeof COLOR_CLASSES]).toBe(
        "string",
      );
    }
  });

  it("red and green classes are distinct", () => {
    expect(COLOR_CLASSES.red).not.toBe(COLOR_CLASSES.green);
  });
});
