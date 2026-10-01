// @vitest-environment jsdom
/**
 * /onboard.html keyboard and screen-reader contract (board row N74).
 *
 * The page is the shipped static file, loaded as-is: its markup, its <style> and its inline
 * script. jsdom does not turn a key press into a click, so "press Space" is modelled the way a
 * browser performs it on a native control: the control must be a real <button> or checkbox in the
 * tab order, and activating it (click) must do what a pointer click does. The real key walk
 * (Tab / Space in headless Chromium) is recorded in the PR.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HTML = readFileSync(resolve(__dirname, "../../../public/onboard.html"), "utf8");
const between = (a: string, b: string, from = 0) => {
  const i = HTML.indexOf(a, from) + a.length;
  return HTML.slice(i, HTML.indexOf(b, i));
};
const CSS = between("<style>", "</style>");
const BODY = between("<body>", "<script>");
const SCRIPT = between("<script>", "</script>", HTML.indexOf("</style>"));

const $ = (s: string) => document.querySelector(s) as HTMLElement | null;
const $$ = (s: string) => Array.from(document.querySelectorAll(s)) as HTMLElement[];

function boot() {
  document.head.innerHTML = `<style>${CSS}</style>`;
  document.body.innerHTML = BODY;
  (window as unknown as { scrollTo: () => void }).scrollTo = () => {};
  // The page's inline script, run as the browser would (it wires handlers and renders step 1).
  new Function(SCRIPT)();
}

function type(field: string, value: string) {
  const el = $(`[data-f="${field}"]`) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const next = () => ($("#nextBtn") as HTMLButtonElement).click();

/** In the sequential focus order: focusable, not disabled, not display:none. */
function inTabOrder(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.tabIndex < 0) return false;
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    if (getComputedStyle(n).display === "none" || n.hidden) return false;
  }
  return true;
}

/** Has an accessible name from a label, aria-label or aria-labelledby. */
function named(el: HTMLElement): boolean {
  if (el.getAttribute("aria-label")?.trim()) return true;
  const by = el.getAttribute("aria-labelledby");
  if (by && by.split(/\s+/).every((id) => document.getElementById(id)?.textContent?.trim())) return true;
  if (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim()) return true;
  return !!el.closest("label")?.textContent?.trim();
}

beforeEach(boot);

describe("/onboard.html step 1: choosing a lane by keyboard", () => {
  it("offers each lane as a native button that reports its pressed state", () => {
    const lanes = $$("[data-lane]");
    expect(lanes.map((l) => l.dataset.lane)).toEqual(["machine", "human", "asset"]);
    for (const l of lanes) {
      expect(l.tagName, l.dataset.lane).toBe("BUTTON");
      expect(l.getAttribute("type")).toBe("button");
      expect(l.getAttribute("aria-pressed")).toBe("false");
      expect(inTabOrder(l)).toBe(true);
    }
    expect(($("#nextBtn") as HTMLButtonElement).disabled).toBe(true);
  });

  it("selecting a lane keeps keyboard focus on it and enables Continue", () => {
    const asset = $('[data-lane="asset"]')!;
    asset.focus();
    asset.click(); // what Space/Enter does on a native button
    const again = $('[data-lane="asset"]')!;
    expect(again.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(again); // focus survives the re-render
    expect(($("#nextBtn") as HTMLButtonElement).disabled).toBe(false);
  });

  it("Continue moves focus to the next step's question", () => {
    $('[data-lane="machine"]')!.click();
    next();
    expect(document.activeElement?.classList.contains("q")).toBe(true);
    expect(document.activeElement?.textContent).toMatch(/Describe it/);
  });
});

describe("/onboard.html: the asset lane's owner-approval switch", () => {
  function toAssetConfigure() {
    $('[data-lane="asset"]')!.click();
    next();
    type("name", "Warehouse Bay 7");
    type("type", "warehouse-bay");
    next();
  }

  it("is never display:none", () => {
    expect(CSS).not.toMatch(/\.tog\s+input\s*\{[^}]*display\s*:\s*none/);
    toAssetConfigure();
    const ck = $("#reqApprovalCk")!;
    expect(getComputedStyle(ck).display).not.toBe("none");
  });

  it("is a named switch in the tab order", () => {
    toAssetConfigure();
    const ck = $("#reqApprovalCk") as HTMLInputElement;
    expect(ck.type).toBe("checkbox");
    expect(ck.getAttribute("role")).toBe("switch");
    expect(inTabOrder(ck)).toBe(true);
    expect(named(ck)).toBe(true);
    expect(ck.closest("label")?.textContent).toMatch(/Require owner approval/);
  });

  it("toggling it puts requiresOwnerApproval: true into the plan", () => {
    toAssetConfigure();
    expect($("#console")!.textContent).toMatch(/"requiresOwnerApproval":\s*false/);
    const ck = $("#reqApprovalCk") as HTMLInputElement;
    ck.focus();
    ck.click(); // what Space does on a focused checkbox
    expect(ck.checked).toBe(true);
    expect($("#console")!.textContent).toMatch(/"requiresOwnerApproval":\s*true/);
  });

  it("has a visible focus indicator on the switch", () => {
    expect(CSS).toMatch(/\.tog\s+input:focus-visible\s*\+\s*\.sw\s*\{[^}]*outline/);
  });
});

describe("/onboard.html: every control is operable and named", () => {
  const LANES = ["machine", "human", "asset"] as const;

  it.each(LANES)("%s lane: choice controls are native buttons and every field is named, steps 1-5", (lane) => {
    $(`[data-lane="${lane}"]`)!.click();
    for (let step = 1; step <= 4; step++) {
      next();
      if (step === 1) {
        type("name", "Test");
        type("type", "courier");
      }
      for (const el of $$("#stepBody [data-chip], #stepBody [data-allow], #stepBody [data-tier], #stepBody [data-ev], #stepBody [data-seg] button")) {
        expect(el.tagName, `${lane} step ${step + 1}: ${el.outerHTML.slice(0, 60)}`).toBe("BUTTON");
      }
      for (const el of $$("#stepBody input, #stepBody select, #stepBody textarea")) {
        expect(named(el), `${lane} step ${step + 1}: unnamed ${el.outerHTML.slice(0, 80)}`).toBe(true);
      }
    }
  });

  it("the stepper is a list of buttons that marks the current step", () => {
    const pips = $$("#stepper .step-pip");
    expect(pips).toHaveLength(6);
    for (const p of pips) expect(p.tagName).toBe("BUTTON");
    expect(pips[0].getAttribute("aria-current")).toBe("step");
  });

  it("announces toasts to assistive tech", () => {
    const t = $("#toast")!;
    expect(t.getAttribute("role")).toBe("status");
  });
});
