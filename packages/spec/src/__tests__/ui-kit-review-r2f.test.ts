/** @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { assertKitTextViolations } from "./ui-kit-text-counter.js";

const source = readFileSync(process.env.PCC_R2F_KIT_SOURCE ?? new NodeURL("../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js", import.meta.url), "utf8");
const file = ts.createSourceFile("pcc-ui.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
type Tracked = { site: number; node: HTMLElement };
type TestWindow = Window & {
  __PCC_UI_BOOTED__?: boolean;
  __PCC_UI_FORCE_CLAIM_INIT_FAILURE__?: boolean;
  __recordAgent?: (site: number, node: HTMLElement) => HTMLElement;
};

// Parse the shipped declaration rather than recreating its labels in the test.
function shippedCss(): string {
  let expression: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "css" && node.initializer) expression = node.initializer.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(expression).toBeDefined();
  return new Function("return (" + expression + ");")();
}
const css = shippedCss();
function labelSelectors(): string[] {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  const selectors = Array.from(style.sheet!.cssRules).flatMap((rule) => {
    if (!("selectorText" in rule) || !("style" in rule)) return [];
    const typed = rule as CSSStyleRule;
    return typed.style.content === '"agent-authored"' ? typed.selectorText.split(",").map((selector) => selector.trim().replace(/::before$/, "")) : [];
  });
  style.remove();
  expect(selectors.length).toBeGreaterThan(0);
  return selectors;
}
const sites: ts.CallExpression[] = [];
function findSites(node: ts.Node): void {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "agentEl") sites.push(node);
  ts.forEachChild(node, findSites);
}
findSites(file);
function trackedSource(): string {
  let code = source;
  for (let i = sites.length - 1; i >= 0; i--) {
    const site = sites[i]!;
    code = code.slice(0, site.getStart(file)) + "window.__recordAgent(" + i + ", " + site.getText(file) + ")" + code.slice(site.end);
  }
  return code;
}
async function settle(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }
async function boot(manifest: unknown, snapshot?: unknown, code = source): Promise<void> {
  document.head.textContent = "";
  document.body.innerHTML = '<main id="pcc-root"></main>';
  (window as TestWindow).__PCC_UI_BOOTED__ = false;
  (window as TestWindow).__PCC_UI_FORCE_CLAIM_INIT_FAILURE__ = false;
  const manifestNode = document.createElement("script");
  manifestNode.id = "pcc-manifest";
  manifestNode.type = "application/json";
  manifestNode.textContent = JSON.stringify(manifest);
  document.body.appendChild(manifestNode);
  if (snapshot !== undefined) {
    const snapshotNode = document.createElement("script");
    snapshotNode.id = "pcc-snapshot";
    snapshotNode.type = "application/json";
    snapshotNode.textContent = JSON.stringify(snapshot);
    document.body.appendChild(snapshotNode);
  }
  (0, eval)(code);
  if (!document.querySelector(".pcc-wrap")) document.dispatchEvent(new Event("DOMContentLoaded"));
  await settle();
  assertKitTextViolations();
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as TestWindow).__recordAgent;
  document.head.textContent = "";
  document.body.textContent = "";
});

describe("r2f T6: the rendered A view withholds raw bidi controls", () => {
  it.each([0x202e, 0x070f])("withholds U+%s in every manifest prose sink", async (codePoint) => {
    const claim = String.fromCodePoint(codePoint) + "deifirev tnemyaP";
    await boot({ sections: [{ heading: claim, windows: [
      { kind: "note", text: claim },
      { kind: "metric", label: claim, binding: { path: "/api/jobs/j1" }, select: "id" },
      { kind: "actions", actions: [{ label: claim, kind: "post", path: "/api/feedback" }] },
    ] }] }, { "/api/jobs/j1": { id: "job-1" } });
    for (const selector of [".pcc-section-heading", ".pcc-note-p", ".pcc-win-title", ".pcc-btn-label"]) {
      const node = document.querySelector(selector)!;
      expect(node.classList.contains("pcc-withheld"), selector).toBe(true);
      expect(node.textContent, selector).toBe("Agent text withheld: it stated an amount or a payment or verification status. Money facts appear only in PCC cards.");
    }
    expect(document.getElementById("pcc-root")!.textContent).not.toContain(String.fromCodePoint(codePoint));
  });
});

describe("r2f T8: every agentEl call site draws the shipped attribution", () => {
  it("covers every source call site through mounted manifests and actions", async () => {
    vi.useFakeTimers();
    const produced: Tracked[] = [];
    (window as TestWindow).__recordAgent = (site, node) => { produced.push({ site, node }); return node; };
    const action = { label: "Save feedback", kind: "post", path: "/api/feedback", confirm: "inline", intentText: "Ask the assistant to save feedback" };
    const manifest = { sections: [{ heading: "Operations", windows: [
      { kind: "note", text: "Make the next batch" },
      { kind: "metric", label: "Job identifier", binding: { path: "/api/jobs/j1" }, select: "id" },
      { kind: "list", binding: { path: "/api/kernels" }, item: { title: "Fallback title" } },
      { kind: "chain", composeRef: { outcomeType: "Certified by PCC", steps: ["Print a part"], optimizeFor: "speed" } },
      { kind: "actions", actions: [action] },
    ] }] };
    await boot(manifest, { "/api/jobs/j1": { id: "job-1" }, "/api/kernels": [{}] }, trackedSource());
    const outcome = document.querySelector(".pcc-chain-outcome")!;
    expect(outcome.textContent).toBe("Certified by PCC");
    (document.querySelector(".pcc-actionbar .pcc-btn-label.pcc-agent")!.closest("button") as HTMLButtonElement).click();
    const chip = document.querySelector(".pcc-chip") as HTMLButtonElement;
    expect(chip).not.toBeNull();
    chip.click();
    await vi.advanceTimersByTimeAsync(1400);
    // The live manifest takes the same action through the inline confirmation path.
    await boot({ sections: [{ windows: [{ kind: "actions", actions: [action] }] }] }, undefined, trackedSource());
    (document.querySelector(".pcc-actionbar .pcc-btn") as HTMLButtonElement).click();
    expect(document.querySelector(".pcc-confirm-q")).not.toBeNull();
    const selectors = labelSelectors();
    expect(new Set(produced.map(({ site }) => site))).toEqual(new Set(sites.map((_, index) => index)));
    for (const { site, node } of produced) {
      expect(selectors.some((selector) => node.matches(selector)), "agentEl source line " + file.getLineAndCharacterOfPosition(sites[site]!.getStart(file)).line).toBe(true);
    }
  });
});

describe("r2f T9: an absent amount has no currency unit", () => {
  it("omits units in capability, receipt and chain budget notices", async () => {
    await boot({ sections: [{ windows: [
      { kind: "capability", binding: { path: "/api/capabilities/c1" } },
      { kind: "receipt", binding: { path: "/api/escrow/e1" } },
      { kind: "chain", composeRef: { outcomeType: "Print parts", budgetUSD: "not an amount" } },
    ] }] }, {
      "/api/capabilities/c1": { name: "Printer", pricing: { baseCost: "not an amount", currency: "USDC" } },
      "/api/escrow/e1": { totalAmount: "not an amount", currency: "USDC" },
    });
    expect(document.querySelector(".pcc-price-chip")!.textContent).toBe("amount not reported");
    expect(document.querySelector(".pcc-receipt-amount")!.textContent).toBe("amount not reported");
    expect(document.querySelector(".pcc-chain-budget")!.textContent).toBe("budget amount not reported");
  });
  it("omits units in plan step and total notices after the real Plan click", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ steps: [{ capabilityType: "fdm", estimatedPriceUSD: "not an amount" }], totalPriceUSD: "not an amount" }) })));
    await boot({ sections: [{ windows: [{ kind: "chain", composeRef: { outcomeType: "Print parts" } }] }] });
    (document.querySelector(".pcc-chain-head")!.closest(".pcc-win")!.querySelector(".pcc-btn") as HTMLButtonElement).click();
    await settle();
    expect(document.querySelector(".pcc-plan-row .pcc-tnum")!.textContent).toBe("amount not reported");
    expect(document.querySelector(".pcc-plan-total")!.textContent).toBe("total amount not reported");
  });
});

describe("r2f T11: the rendered style node is pinned", () => {
  it("keeps the exact shipped stylesheet after render and every shipped rule", async () => {
    await boot({ sections: [{ heading: "Operations", windows: [{ kind: "note", text: "Make parts" }] }] }, {});
    const node = document.getElementById("pcc-ui-styles");
    expect(node).not.toBeNull();
    expect(node!.textContent).toBe(css);
    const expected = document.createElement("style");
    expected.textContent = css;
    document.head.appendChild(expected);
    expect(Array.from((node as HTMLStyleElement).sheet!.cssRules, (rule) => rule.cssText))
      .toEqual(Array.from(expected.sheet!.cssRules, (rule) => rule.cssText));
    expected.remove();
    // Updated only with an intentional reviewed stylesheet change; any removed rule changes this pin.
    expect(createHash("sha256").update(css).digest("hex")).toBe("9fa72a736853448590d602053bcce7f07a7c820f74514b9e1d065c3842e22e36");
  });
});
