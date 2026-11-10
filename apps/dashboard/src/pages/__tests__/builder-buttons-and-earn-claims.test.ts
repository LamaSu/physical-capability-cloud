// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  GUARDED_CLAIMS,
  PUBLISHED_SURFACES,
  findClaimViolations,
  publishedText,
} from "../../lib/public-claims.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const BUILDER_PATHS = [
  "apps/dashboard/src/pages/WorkflowPage.tsx",
  "apps/dashboard/src/pages/ProtocolBuilderPage.tsx",
  "apps/dashboard/src/pages/ProtocolDetailPage.tsx",
];
const EARN_PATH = "apps/dashboard/src/pages/EarnFromYourWorkPage.tsx";
const DISABLED_CLASS = "px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-xs text-white/30 cursor-not-allowed";
const NOTE_CLASS = "self-center text-[10px] text-white/30";

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

type Element = ts.JsxElement | ts.JsxSelfClosingElement;

function opening(element: Element): ts.JsxOpeningElement | ts.JsxSelfClosingElement {
  return ts.isJsxElement(element) ? element.openingElement : element;
}

function attribute(element: Element, name: string): ts.JsxAttribute | undefined {
  return opening(element).attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function attributeText(element: Element, name: string): string | undefined {
  const initializer = attribute(element, name)?.initializer;
  return initializer && ts.isStringLiteral(initializer) ? initializer.text : undefined;
}

function textContent(node: ts.Node): string {
  if (ts.isJsxText(node)) return node.text;
  if (ts.isJsxElement(node) || ts.isJsxFragment(node)) return node.children.map(textContent).join("");
  if (ts.isJsxExpression(node) && node.expression) {
    return ts.isStringLiteral(node.expression) ? node.expression.text : `{${node.expression.getText()}}`;
  }
  return "";
}

function handled(element: Element): boolean {
  const initializer = attribute(element, "onClick")?.initializer;
  const handler = initializer && ts.isJsxExpression(initializer) ? initializer.expression : undefined;
  if (!handler) return false;
  return !(ts.isArrowFunction(handler) && ts.isBlock(handler.body) && handler.body.statements.length === 0);
}

function explainedDisabled(element: Element): boolean {
  const disabled = attribute(element, "disabled");
  if (!disabled || !attribute(element, "title")) return false;
  const value = disabled.initializer && ts.isJsxExpression(disabled.initializer) ? disabled.initializer.expression : undefined;
  return value?.kind !== ts.SyntaxKind.FalseKeyword;
}

function elementText(element: Element): string {
  return textContent(element).replace(/\s+/g, " ").trim();
}

const pages = BUILDER_PATHS.map((path) => {
  const source = read(path);
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const elements: Element[] = [];
  function visit(node: ts.Node): void {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) elements.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { path, source, file, elements };
});

function location(page: (typeof pages)[number], element: Element): string {
  const line = page.file.getLineAndCharacterOfPosition(element.getStart(page.file)).line + 1;
  return `${page.path}:${line} button ${JSON.stringify(elementText(element))}`;
}

describe("builder buttons and contributor rate copy", () => {
  it("T1: every builder button has a click handler or a disabled explanation", () => {
    const unexplained = pages.flatMap((page) => page.elements
      .filter((element) => opening(element).tagName.getText() === "button")
      .filter((element) => !handled(element) && !explainedDisabled(element))
      .map((element) => location(page, element)));
    expect(unexplained).toEqual([]);
  });

  it("T2: builder pages omit unavailable actions and protocol edit mode", () => {
    const removedLabels = new Set(["Submit Workflow", "Save Draft", "Fork Protocol", "Create Fork", "Run Protocol", "Edit"]);
    const removedButtons = pages.flatMap((page) => page.elements
      .filter((element) => opening(element).tagName.getText() === "button" && removedLabels.has(elementText(element)))
      .map((element) => location(page, element)));
    expect(removedButtons).toEqual([]);
    expect(pages.find((page) => page.path.endsWith("ProtocolDetailPage.tsx"))!.source)
      .not.toContain("/edit");
    const builder = pages.find((page) => page.path.endsWith("ProtocolBuilderPage.tsx"))!.source;
    expect(builder).not.toContain("Edit Protocol");
    expect(builder).not.toContain("Editing ");
  });

  it("T3: local draft notes and disabled actions have the approved text and titles", () => {
    const expectedElements = [
      {
        page: "WorkflowPage.tsx",
        tag: "span",
        text: "Local draft, not saved",
        title: "This workflow lives only in this browser tab. It is not saved or sent anywhere.",
      },
      {
        page: "WorkflowPage.tsx",
        tag: "button",
        text: "Submit (not available yet)",
        title: "Submitting is not available yet: workflows built here are not sent to PCC.",
      },
      {
        page: "ProtocolBuilderPage.tsx",
        tag: "span",
        text: "Local draft, not saved",
        title: "This protocol lives only in this browser tab. It is not saved anywhere.",
      },
      {
        page: "ProtocolBuilderPage.tsx",
        tag: "button",
        text: "Publish (not available yet)",
        title: "Publishing is not available yet: the protocol library doesn't store protocols.",
      },
      {
        page: "ProtocolDetailPage.tsx",
        tag: "button",
        text: "Run (not available yet)",
        title: "Running a protocol from this page is not available yet.",
      },
    ];
    for (const expected of expectedElements) {
      const page = pages.find((candidate) => candidate.path.endsWith(expected.page))!;
      const matches = page.elements.filter((element) => opening(element).tagName.getText() === expected.tag
        && elementText(element) === expected.text && attributeText(element, "title") === expected.title);
      const context = `${page.path}: ${expected.text}`;
      expect(matches, context).toHaveLength(1);
      const element = matches[0];
      expect(attributeText(element, "className"), context).toBe(expected.tag === "button" ? DISABLED_CLASS : NOTE_CLASS);
      if (expected.tag === "button") {
        expect(attributeText(element, "type"), context).toBe("button");
        expect(attribute(element, "disabled"), context).toBeDefined();
        expect(attribute(element, "disabled")?.initializer, context).toBeUndefined();
      }
    }
  });

  it("T4: earn copy describes published rates without promising payouts", () => {
    const text = publishedText(EARN_PATH, read(EARN_PATH));
    for (const removed of [
      "CompositionManifest", "smart contract", "sends your cut", "pays you", "on-chain",
      "where you'll get paid", "Your cut", "of every job", "Get paid every time", "payout",
    ]) {
      expect(text).not.toContain(removed);
    }
    for (const approved of [
      "Your rate is published.",
      "Your wallet",
      " Paying published rates isn't live yet. No job settlement reads a published rate today, so nothing is sent to the wallet above.",
      "Publish a rate for your work.",
      "Pick what you do. Set your rate. PCC keeps it on record. Paying published rates isn't live yet.",
      "Your rate: ",
    ]) {
      expect(text).toContain(approved);
    }
  });

  it("T5: earn is a published surface and automatic contributor payouts remain guarded", () => {
    expect(PUBLISHED_SURFACES).toContain(EARN_PATH);
    const claim = GUARDED_CLAIMS.find((candidate) => candidate.id === "automatic-contributor-payout");
    expect(claim).toBeDefined();
    expect(claim?.status).not.toBe("live");
    for (const text of [
      "Every job that uses your work pays you, automatically.",
      "When the job settles, the smart contract sends your cut directly to the wallet above.",
      "Get paid every time your work is used.",
      "Every job that uses your work pays you 2% of the job value.",
      "Every job that uses your work\n          pays you, automatically.",
      "It pays you automatically.",
    ]) {
      expect(findClaimViolations(text).map((violation) => violation.id), text).toContain("automatic-contributor-payout");
    }
  });
});
