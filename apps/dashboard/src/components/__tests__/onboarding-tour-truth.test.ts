// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { PUBLISHED_SURFACES, findClaimViolations, publishedText } from "../../lib/public-claims.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TOUR_PATH = "apps/dashboard/src/components/OnboardingTour.tsx";
const LOGIN_PATH = "apps/dashboard/src/pages/LoginPage.tsx";
const EXPECTED_STEPS = [
  { id: "welcome", title: "Welcome to the PCC dashboard", content: "This dashboard covers jobs, kernels, escrow and onboarding. Use the sidebar to navigate between sections." },
  { id: "kpi-row", title: "Key Performance Indicators", content: "See how many jobs are active and how many kernels are online." },
  { id: "discover", title: "Discover Capabilities", content: "Search the capabilities operators list on the network by name, type or description. Filter by type or by minimum assurance score." },
  { id: "process-select", title: "Build a Contract", content: "Pick a process type, such as FDM printing, CNC milling or liquid handling, to see its parameters." },
  { id: "configure", title: "Configure Parameters", content: "Every process type has its own configurable parameters. Parameters are grouped and cross-parameter constraints resolve automatically." },
  { id: "review", title: "Review Contract", content: "After Build Contract, the summary shows whether the contract is valid, its total price, the CWM step output and any validation errors." },
  { id: "workflow", title: "Workflow Builder", content: "Build multi-step workflows by adding steps from the palette and connecting them with dependency edges." },
  { id: "connect", title: "Connect Steps", content: "Drag between step handles to create dependency edges." },
  { id: "evidence", title: "Evidence & Proof", content: "Each assurance tier requires specific combinations of evidence." },
];

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

function readTourSteps() {
  const file = ts.createSourceFile(TOUR_PATH, read(TOUR_PATH), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = file.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === "tourSteps");
  const array = declaration?.initializer;
  if (!array || !ts.isArrayLiteralExpression(array)) throw new Error("tourSteps must be an array literal");
  return array.elements.map((element) => {
    if (!ts.isObjectLiteralExpression(element)) throw new Error("Each tour step must be an object literal");
    const text = (name: string): string => {
      const property = element.properties.find((candidate) => ts.isPropertyAssignment(candidate)
        && ts.isIdentifier(candidate.name) && candidate.name.text === name);
      if (!property || !ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer)) {
        throw new Error(`Tour step ${name} must be a string literal`);
      }
      return property.initializer.text;
    };
    return { id: text("id"), title: text("title"), content: text("content") };
  });
}

describe("onboarding tour and login copy", () => {
  it("keeps the approved step ids, titles and contents in order", () => {
    expect(readTourSteps()).toEqual(EXPECTED_STEPS);
  });

  it("omits unsupported claims from tour titles and contents", () => {
    const removed = [
      "pricing, queue depth", "Live Pricing", "real-time", "AI extracts", "heatmaps",
      "most profitable", "Find a Space", "Earn from every job", "funds release",
      "challenge window", "chromatograms", "TEE", "biotech", "PCCP",
    ];
    for (const step of readTourSteps()) {
      for (const phrase of removed) {
        expect(`${step.title} ${step.content}`.toLowerCase(), step.id).not.toContain(phrase.toLowerCase());
      }
    }
  });

  it("describes sign-in methods without publishing the invalid key creation route", () => {
    const text = publishedText(LOGIN_PATH, read(LOGIN_PATH));
    expect(text).toContain("Sign in with your wallet or an API key to continue.");
    expect(text).not.toContain("POST /api/auth/keys");
  });

  it("checks the tour and login as published surfaces without guarded claims", () => {
    for (const path of [TOUR_PATH, LOGIN_PATH]) {
      expect(PUBLISHED_SURFACES).toContain(path);
      expect(findClaimViolations(publishedText(path, read(path))), path).toEqual([]);
    }
  });

  it("flags wrapped automatic payouts and wallet or contributor payout claims", () => {
    const wrapped = "Every job that uses your work\n          pays you, automatically.";
    expect(findClaimViolations(wrapped)).toContainEqual({
      id: "automatic-contributor-payout",
      status: "roadmap",
      match: "Every job that uses your work\n          pays you",
    });
    for (const text of ["Your wallet (this is where you'll get paid)", "It pays contributors automatically."]) {
      expect(findClaimViolations(text).map((violation) => violation.id), text)
        .toContain("automatic-contributor-payout");
    }
  });
});
