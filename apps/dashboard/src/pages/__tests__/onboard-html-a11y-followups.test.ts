// @vitest-environment jsdom
/**
 * Follow-ups to /onboard.html PR #463 (board row N74), raised by astra's review of #463 @b0bc8301
 * (SHIP, with these tracked follow-ups).
 *
 * Same harness as onboard-html-a11y.test.ts: loads the shipped static file's <style>/<body>/<script>
 * and runs the inline script with `new Function(SCRIPT)()`, exactly as a browser would. jsdom does
 * not turn a key press into a click, so "press Space" is modelled as a native-button click, per the
 * original suite's header note.
 *
 * Findings pinned here:
 *   F1 (MEDIUM) — activating the CURRENT stepper pip rebuilds the stepper and drops focus to <body>.
 *   F2 (MEDIUM) — reduced-motion handling (the CSS guard) doesn't cover go()'s JS-driven smooth scroll.
 *   F3 (LOW)    — the original suite is narrower than its description. This widens coverage for:
 *                 the switch's aria-describedby, segmented-button aria-pressed sync, and
 *                 unreached-pip disabling.
 *
 * NOT pinned here:
 *   - "plan-region identity": that the plan-and-execute code (S, buildPlan(), activate() through
 *     resolveBody()) is byte-identical to master. It is a check made per PR (recorded in the PR), not
 *     a lasting invariant, since later work may change that code on purpose.
 *   - real keyboard events: jsdom does not turn a key press into a click. The real Tab/Space walk runs
 *     in headless Chromium (keywalk.cjs) and is recorded in the PR.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
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
  // jsdom has no window.matchMedia by default; start every test from that same clean baseline so a
  // stub installed by one test never leaks into the next (window/document persist across `it`s).
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  // The page's inline script, run as the browser would (it wires handlers and renders step 1).
  new Function(SCRIPT)();
}

function type(field: string, value: string) {
  const el = $(`[data-f="${field}"]`) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const next = () => ($("#nextBtn") as HTMLButtonElement).click();

function stubMatchMedia(reducedMotionMatches: boolean) {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = ((q: string) => ({
    matches: reducedMotionMatches && q === "(prefers-reduced-motion: reduce)",
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as (q: string) => MediaQueryList;
}

beforeEach(boot);

describe("/onboard.html follow-up F1: activating the current stepper pip keeps focus", () => {
  it("does not drop focus to <body> when the CURRENT pip is clicked", () => {
    $('[data-lane="machine"]')!.click();
    next(); // -> step 1 (Identity)
    type("name", "Test");
    type("type", "3d-printing");
    next(); // -> step 2 (Configure); maxReached = 2
    ($("#backBtn") as HTMLButtonElement).click(); // -> step 1 again; its pip is now "current"

    const currentPip = $('.step-pip[aria-current="step"]') as HTMLButtonElement;
    expect(currentPip).toBeTruthy();
    const stepIndex = currentPip.dataset.i;

    currentPip.focus();
    expect(document.activeElement).toBe(currentPip);

    currentPip.click(); // what Space does on a focused, native button

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.classList.contains("step-pip")).toBe(true);
    expect((document.activeElement as HTMLElement).dataset.i).toBe(stepIndex);
  });
});

describe("/onboard.html follow-up F2: reduced motion covers JS-driven scrolling", () => {
  it("requests behavior: auto, never smooth, when prefers-reduced-motion: reduce matches", () => {
    stubMatchMedia(true);
    const scrollSpy = vi.fn();
    (window as unknown as { scrollTo: typeof window.scrollTo }).scrollTo = scrollSpy as unknown as typeof window.scrollTo;

    $('[data-lane="machine"]')!.click();
    next(); // triggers go(1) -> window.scrollTo(...)

    expect(scrollSpy).toHaveBeenCalled();
    for (const call of scrollSpy.mock.calls) {
      const opts = call[0] as { behavior?: string } | undefined;
      expect(opts?.behavior).not.toBe("smooth");
    }
  });

  it("control: still requests smooth scrolling when matchMedia is absent (today's default)", () => {
    const scrollSpy = vi.fn();
    (window as unknown as { scrollTo: typeof window.scrollTo }).scrollTo = scrollSpy as unknown as typeof window.scrollTo;

    $('[data-lane="machine"]')!.click();
    next();

    expect(scrollSpy).toHaveBeenCalled();
    const opts = scrollSpy.mock.calls[0]?.[0] as { behavior?: string } | undefined;
    expect(opts?.behavior).toBe("smooth");
  });

  it("control: still requests smooth scrolling when reduced motion is present but not matching", () => {
    stubMatchMedia(false);
    const scrollSpy = vi.fn();
    (window as unknown as { scrollTo: typeof window.scrollTo }).scrollTo = scrollSpy as unknown as typeof window.scrollTo;

    $('[data-lane="machine"]')!.click();
    next();

    expect(scrollSpy).toHaveBeenCalled();
    const opts = scrollSpy.mock.calls[0]?.[0] as { behavior?: string } | undefined;
    expect(opts?.behavior).toBe("smooth");
  });
});

describe("/onboard.html follow-up F3: widening the a11y suite's actual coverage", () => {
  it("the owner-approval switch's aria-describedby resolves to a real, non-empty hint", () => {
    $('[data-lane="asset"]')!.click();
    next();
    type("name", "Warehouse Bay 7");
    type("type", "warehouse-bay");
    next();

    const ck = $("#reqApprovalCk") as HTMLInputElement;
    const describedBy = ck.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const hint = document.getElementById(describedBy as string);
    expect(hint).not.toBeNull();
    expect(hint?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it("clicking a segmented button (presence, human lane) syncs aria-pressed to only that button", () => {
    $('[data-lane="human"]')!.click();
    next();
    type("name", "Test Courier");
    type("type", "courier");
    next(); // step 2: configure, has the presence segment

    const buttons = $$('[data-seg="presence"] button') as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    const target = buttons.find((b) => b.dataset.v === "busy")!;
    expect(target).toBeTruthy();

    target.click();

    const pressed = buttons.filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toBe(target);
    for (const b of buttons) {
      if (b !== target) expect(b.getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("clicking a segmented button (optimize, asset lane) syncs aria-pressed to only that button", () => {
    $('[data-lane="asset"]')!.click();
    next();
    type("name", "Warehouse Bay 7");
    type("type", "warehouse-bay");
    next(); // step 2: configure
    next(); // step 3: terms, has the optimize segment for the asset lane

    const buttons = $$('[data-seg="optimize"] button') as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    const target = buttons.find((b) => b.dataset.v === "speed")!;
    expect(target).toBeTruthy();

    target.click();

    const pressed = buttons.filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toBe(target);
  });

  it("every pip beyond the furthest step reached is disabled; reached pips are not", () => {
    $('[data-lane="machine"]')!.click();
    next(); // step 1
    type("name", "Test");
    type("type", "3d-printing");
    next(); // step 2; maxReached = 2

    const pips = $$("#stepper .step-pip") as HTMLButtonElement[];
    expect(pips.length).toBeGreaterThan(0);
    for (const p of pips) {
      const idx = +(p.dataset.i as string);
      expect(p.disabled).toBe(idx > 2);
    }
  });
});
