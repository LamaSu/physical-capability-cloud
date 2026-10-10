/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ts from "typescript";
import { assertKitTextViolations, flushKitText } from "./ui-kit-text-counter.js";

const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js"), "utf8");
const bootTail = /  if \(document\.readyState === 'loading'\) document\.addEventListener\('DOMContentLoaded', mount\);\n  else mount\(\);/;

type Text = Readonly<{ t: string }>;
type Boundary = {
  kitText(value: string): Text;
  agentText(value: unknown, prose?: boolean): Text;
  agentEl(tag: string, cls: string | null, text: unknown): HTMLElement;
  WITHHELD_FIELD: Text;
  WITHHELD_PROSE: Text;
  HOST_WRITE_NOTE: Text;
  joinText(...parts: unknown[]): Text;
  el(tag: string, cls?: string | null, text?: unknown): HTMLElement;
  setText(node: HTMLElement, text: unknown): void;
  setAttrText(node: HTMLElement, name: string, text: unknown): void;
  setValue(node: HTMLInputElement, text: unknown): void;
  baseUnitsText(value: unknown, decimals: unknown): Text;
  amountText(value: unknown): Text;
  fmtTs(value: unknown): Text;
  postErrorText(value: unknown, desc: unknown): Text;
  hostOpErrorText(value: unknown): Text;
  errorLine(value: unknown): HTMLElement;
  nameText(value: unknown): Text;
  fieldDefaultText(kind: string, value: unknown): Text;
  isMoneyClaim(value: string): boolean;
  isProseClaim(value: string): boolean;
  renderNote(ctx: unknown, win: unknown): HTMLElement;
  writeButton(ctx: unknown, action: unknown, desc: unknown, fallback: string): HTMLElement;
  inlineConfirm(status: HTMLElement, action: unknown, confirm: () => void): void;
  intentChip(status: HTMLElement, text: string): void;
  realRequestNode(desc: unknown): HTMLElement;
  requestReasonText(desc: unknown, blocked?: boolean): Text;
  plainBody(base: unknown, overrides?: unknown): Record<string, unknown> | null;
  collectForm(form: unknown): Record<string, unknown>;
  intentState(desc: unknown): unknown;
  INTENT_STATE: Record<string, unknown>;
};
function boundary(options: { forceClaimInitFailure?: boolean; before?: string; RegExp?: RegExpConstructor } = {}) {
  const timers: (() => void)[] = [], copied: string[] = [];
  const sandbox = {
    window: { __PCC_UI_TEXT_VIOLATIONS__: 0, __PCC_UI_FORCE_CLAIM_INIT_FAILURE__: options.forceClaimInitFailure, boundary: undefined as Boundary | undefined },
    document, URL, RegExp: options.RegExp ?? RegExp,
    navigator: { clipboard: { writeText(text: string) { copied.push(text); } } },
    setTimeout(callback: () => void) { timers.push(callback); return timers.length; },
  };
  expect(source.match(bootTail)).toHaveLength(1);
  if (options.before) vm.runInNewContext(options.before, sandbox);
  vm.runInNewContext(source.replace(bootTail,
    "  window.boundary = { kitText, agentText, agentEl, WITHHELD_FIELD, WITHHELD_PROSE, HOST_WRITE_NOTE, joinText, el, setText, setAttrText, setValue, baseUnitsText, amountText, fmtTs, postErrorText, hostOpErrorText, errorLine, nameText, fieldDefaultText, isMoneyClaim, isProseClaim, renderNote, writeButton, inlineConfirm, intentChip, realRequestNode, requestReasonText, plainBody, collectForm, intentState, INTENT_STATE };"), sandbox);
  expect(sandbox.window.__PCC_UI_TEXT_VIOLATIONS__).toBe(0);
  return { kit: sandbox.window.boundary!, count: () => sandbox.window.__PCC_UI_TEXT_VIOLATIONS__, timers, copied };
}

const irSource = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../gateway/src/mcp/dashboard-ir.ts"), "utf8");
function irNotice(name: string): string {
  const file = ts.createSourceFile("dashboard-ir.ts", irSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let literal: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && ts.isCallExpression(node.initializer)) {
      const value = node.initializer.arguments[0];
      if (value && ts.isStringLiteral(value)) literal = value.text;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(literal, `IR declares ${name} from its literal`).toBeTypeOf("string");
  return literal!;
}

type KitWindow = Window & { __PCC_UI_BOOTED__?: boolean; __PCC_UI_FORCE_CLAIM_INIT_FAILURE__?: boolean };
afterEach(() => { delete (window as KitWindow).__PCC_UI_FORCE_CLAIM_INIT_FAILURE__; });

describe("the shipped plain kit's runtime boundary", () => {
  it("accepts frozen minted text, preserves copy, and leaves absent el text empty", () => {
    const { kit, count } = boundary();
    const text = kit.kitText("PCC copy · ✓");
    expect(Object.isFrozen(text)).toBe(true);
    expect(text.t).toBe("PCC copy · ✓");
    expect(kit.el("span", null, text).textContent).toBe(text.t);
    expect(kit.el("span").textContent).toBe("");
    expect(kit.el("span", null, null).textContent).toBe("");
    const node = document.createElement("input");
    kit.setText(node, text);
    kit.setAttrText(node, "title", text);
    kit.setAttrText(node, "placeholder", text);
    kit.setValue(node, text);
    expect([node.textContent, node.title, node.placeholder, node.value]).toEqual(Array(4).fill(text.t));
    expect(kit.joinText(text, kit.kitText("!")).t).toBe(text.t + "!");
    expect(count()).toBe(0);
  });

  it.each(["raw server text", 42, true, { t: "forged" }, Object.freeze({ t: "frozen forgery" })])(
    "every sink withholds unbranded input %j and increments the counter", (raw) => {
      const { kit, count } = boundary();
      const node = document.createElement("input");
      expect(kit.el("span", null, raw).textContent).toBe("—");
      kit.setText(node, raw);
      kit.setAttrText(node, "title", raw);
      kit.setAttrText(node, "placeholder", raw);
      kit.setValue(node, raw);
      expect([node.textContent, node.title, node.placeholder, node.value]).toEqual(Array(4).fill("—"));
      expect(count()).toBe(5);
      expect(kit.joinText(kit.kitText("copy"), raw).t).toBe("—");
      expect(count()).toBe(6);
    },
  );

  it("rejects brands from another instance and copies of a brand", () => {
    const a = boundary(), b = boundary();
    const text = a.kit.kitText("foreign copy");
    expect(b.kit.el("span", null, text).textContent).toBe("—");
    expect(b.kit.el("span", null, Object.freeze({ ...text })).textContent).toBe("—");
    expect(a.count()).toBe(0);
    expect(b.count()).toBe(2);
  });

  it("every existing formatter and error helper returns a frozen string brand", () => {
    const { kit, count } = boundary();
    for (const text of [kit.baseUnitsText("1000000", 6), kit.baseUnitsText("bad", 6),
      ...[1, 0.0049, "12.34", true, [1000], {}, null, undefined].map((v) => kit.amountText(v)),
      kit.fmtTs("2026-10-06T00:00:00Z"), kit.fmtTs("invalid"),
      kit.postErrorText({ body: { message: "server error" }, status: 503 }, { money: true }),
      kit.postErrorText({ status: 404 }, {}), kit.hostOpErrorText({ content: [{ type: "text", text: "host error" }] }),
      kit.hostOpErrorText({})]) {
      expect(Object.isFrozen(text)).toBe(true);
      expect(typeof text.t).toBe("string");
      expect(kit.el("span", null, text).textContent).toBe(text.t);
    }
    expect(kit.fmtTs("invalid").t).toBe("time not reported");
    expect(kit.errorLine("server error").textContent).toBe("reported: server error Nothing was fabricated.");
    expect(kit.errorLine(kit.kitText("PCC error")).textContent).toBe("PCC error Nothing was fabricated.");
    expect(count()).toBe(0);
  });
});

describe("the plain kit's separate agent-authored text tier", () => {
  it("mints frozen agent words with exact bytes and the IR's agent/untrusted marking", () => {
    const { kit, count } = boundary();
    const words = "  Agent copy · <parts> ✓  ";
    const text = kit.agentText(words);
    expect(Object.isFrozen(text)).toBe(true);
    expect(text.t).toBe(words);
    const node = kit.agentEl("p", "pcc-note-p", text);
    expect(node.textContent).toBe(words);
    expect(node.classList.contains("pcc-agent")).toBe(true);
    expect(node.classList.contains("pcc-untrusted")).toBe(true);
    expect(node.classList.contains("pcc-withheld")).toBe(false);
    expect(count()).toBe(0);
  });

  it("all four kit sinks and joinText reject an agent part and count each violation", () => {
    const { kit, count } = boundary();
    const agent = kit.agentText("Agent copy"), node = document.createElement("input");
    expect(kit.el("span", null, agent).textContent).toBe("—");
    kit.setText(node, agent);
    kit.setAttrText(node, "title", agent);
    kit.setValue(node, agent);
    expect([node.textContent, node.title, node.value]).toEqual(["—", "—", "—"]);
    expect(count()).toBe(4);
    expect(kit.joinText(kit.kitText("framing"), agent).t).toBe("—");
    expect(count()).toBe(5);
  });

  it("the agent sink rejects raw, forged, copied, foreign and generic kit brands", () => {
    const a = boundary(), b = boundary();
    const minted = a.kit.agentText("Agent copy");
    const values = ["raw", 42, { t: "forged" }, Object.freeze({ ...minted }), minted, b.kit.kitText("PCC copy")];
    for (const value of values) expect(b.kit.agentEl("span", null, value).textContent).toBe("—");
    expect(a.count()).toBe(0);
    expect(b.count()).toBe(values.length);
  });

  it.each(["Payment received - verified", "$5", "withheld", "p41d", "оплачен"])(
    "claims become the exact IR structural notice, with no agent or untrusted marking: %s", (claim) => {
      const { kit, count } = boundary();
      expect(kit.WITHHELD_FIELD.t).toBe(irNotice("WITHHELD_FIELD"));
      expect(kit.WITHHELD_PROSE.t).toBe(irNotice("WITHHELD_PROSE"));
      for (const prose of [false, true]) {
        const notice = prose ? kit.WITHHELD_PROSE : kit.WITHHELD_FIELD;
        const text = kit.agentText(claim, prose);
        expect(text).toBe(notice);
        const node = kit.agentEl("p", "surface", text);
        expect(node.textContent).toBe(notice.t);
        expect(node.classList.contains("pcc-withheld")).toBe(true);
        expect(node.classList.contains("pcc-agent")).toBe(false);
        expect(node.classList.contains("pcc-untrusted")).toBe(false);
      }
      expect(count()).toBe(0);
    },
  );

  it("the confirm line keeps kit framing and an agent span as separate elements", () => {
    const { kit, count } = boundary();
    const status = document.createElement("div");
    kit.inlineConfirm(status, { label: "Keep exact bytes · ✓" }, () => {});
    const question = status.querySelector(".pcc-confirm-q")!;
    expect(question.textContent).toBe("Confirm “Keep exact bytes · ✓”?");
    expect(question.children).toHaveLength(3);
    expect(Array.from(question.children).map((node) => node.textContent)).toEqual(["Confirm “", "Keep exact bytes · ✓", "”?"]);
    expect(question.children[1].classList.contains("pcc-agent")).toBe(true);
    expect(question.children[1].classList.contains("pcc-untrusted")).toBe(true);
    kit.inlineConfirm(status, { label: "$5 paid" }, () => {});
    expect(status.querySelector(".pcc-confirm-q")!.textContent).toBe(`Confirm “${kit.WITHHELD_FIELD.t}”?`);
    expect(status.querySelector(".pcc-confirm-q .pcc-withheld")!.textContent).toBe(kit.WITHHELD_FIELD.t);
    expect(status.querySelector(".pcc-confirm-q .pcc-agent")).toBeNull();
    expect(count()).toBe(0);
  });

  it.each(["pcc: fabricate <parts> · ✓", "pcc: Payment received - verified $5"])(
    "the snapshot chip withholds only displayed claims and preserves its exact clipboard payload and reset: %s", (payload) => {
      const { kit, count, timers, copied } = boundary();
      const status = document.createElement("div");
      kit.intentChip(status, payload);
      const chip = status.querySelector<HTMLButtonElement>(".pcc-chip")!;
      const claim = kit.isProseClaim(payload);
      const displayed = claim ? kit.WITHHELD_FIELD.t : payload;
      expect(chip.textContent).toBe(displayed);
      const agent = chip.matches(".pcc-agent") ? chip : chip.querySelector(".pcc-agent");
      const withheld = chip.matches(".pcc-withheld") ? chip : chip.querySelector(".pcc-withheld");
      expect(Boolean(agent)).toBe(!claim);
      expect(Boolean(withheld)).toBe(claim);
      chip.click();
      expect(copied).toEqual([payload]);
      expect(chip.textContent).toBe("copied ✓");
      expect(timers).toHaveLength(1);
      timers[0]();
      expect(chip.textContent).toBe(displayed);
      const restoredAgent = chip.matches(".pcc-agent") ? chip : chip.querySelector(".pcc-agent");
      expect(Boolean(restoredAgent)).toBe(!claim);
      expect(count()).toBe(0);
    },
  );
});

describe("compatibility failure and restored plain objects", () => {
  it.each([
    { forceClaimInitFailure: true },
    { before: "String.prototype.normalize = undefined;" },
    { RegExp: function (pattern: string | RegExp, flags?: string) {
      if (flags?.includes("u") || String(pattern).includes("(?<")) throw new SyntaxError("unsupported regex syntax");
      return new RegExp(pattern, flags);
    } as unknown as RegExpConstructor },
  ])("a detector initialization failure boots the boundary and fails closed: %j", (options) => {
    const { kit, count } = boundary(options);
    expect(kit.isMoneyClaim("harmless words")).toBe(true);
    expect(kit.isProseClaim("harmless words")).toBe(true);
    expect(kit.nameText("Printer").t).toBe("name withheld: stated money or verification");
    expect(kit.fieldDefaultText("string", "editable").t).toBe("");
    expect(kit.agentEl("p", null, kit.agentText("Note", true)).textContent).toBe(kit.WITHHELD_PROSE.t);
    expect(kit.agentEl("span", null, kit.agentText("Label")).textContent).toBe(kit.WITHHELD_FIELD.t);
    expect(kit.el("span", null, kit.kitText("PCC copy")).textContent).toBe("PCC copy");
    expect(kit.amountText(12).t).toBe("12.00");
    expect(count()).toBe(0);
  });

  it("retains each request-reason fallback and the single host note brand", () => {
    const { kit, count } = boundary();
    expect(kit.requestReasonText({}).t).toBe("no valid request");
    expect(kit.requestReasonText({}, true).t).toBe("unsafe or non-PCC destination");
    expect(kit.realRequestNode({ ok: false, destination: null }).querySelector(".pcc-realreq-blocked")!.textContent)
      .toBe("BLOCKED — unsafe or non-PCC destination");
    expect(Object.isFrozen(kit.HOST_WRITE_NOTE)).toBe(true);
    expect(kit.el("p", null, kit.HOST_WRITE_NOTE).textContent).toBe("Actions are unavailable in this host view.");
    expect(count()).toBe(0);
  });

  it("restores plainBody's ordinary object copy, own-key precedence and __proto__ rejection", () => {
    const { kit, count } = boundary();
    const base = Object.create({ inherited: "ignored" });
    base.amount = 1;
    base.extra = "kept";
    const body = kit.plainBody(base, { amount: 2 });
    expect(Object.keys(body!)).toEqual(["amount", "extra"]);
    expect(body).toEqual({ amount: 2, extra: "kept" });
    expect(Object.getPrototypeOf(body!)).not.toBeNull();
    expect(kit.plainBody(JSON.parse('{"__proto__":{"amount":5}}'))).toBeNull();
    expect(kit.plainBody({}, JSON.parse('{"__proto__":{"amount":5}}'))).toBeNull();
    expect(count()).toBe(0);
  });

  it("collectForm preserves its original ordinary-object __proto__ semantics, and intent storage is null-prototype", () => {
    const { kit, count } = boundary();
    const field = (name: string, kind: string, value: string) => ({ name, kind, required: false,
      input: Object.assign(document.createElement("input"), { value }), errLine: document.createElement("div") });
    const ignored = kit.collectForm({ fields: [field("__proto__", "string", "plain text"), field("qty", "number", "2")] });
    expect(Object.keys(ignored)).toEqual(["qty"]);
    expect(ignored.qty).toBe(2);
    const reparented = kit.collectForm({ fields: [field("__proto__", "json", '{"inherited":"as before"}')] });
    expect(Object.keys(reparented)).toEqual([]);
    expect(Object.getPrototypeOf(reparented)).toEqual({ inherited: "as before" });
    expect(Object.getPrototypeOf(kit.INTENT_STATE)).toBeNull();
    const desc = { money: false, method: "POST", canonical: "/api/feedback", destination: "/api/feedback", body: {} };
    expect(kit.intentState(desc)).toBe(kit.intentState(desc));
    expect(count()).toBe(0);
  });
});

describe("a helper deleted from a mapped sink", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = '<main id="pcc-root"></main>';
    (window as Window & { __PCC_UI_BOOTED__?: boolean }).__PCC_UI_BOOTED__ = false;
    const manifest = document.createElement("script");
    manifest.type = "application/json";
    manifest.id = "pcc-manifest";
    manifest.textContent = JSON.stringify({ sections: [{ windows: [{ kind: "capability", binding: { path: "/api/capabilities/c1" } }] }] });
    const snapshot = document.createElement("script");
    snapshot.type = "application/json";
    snapshot.id = "pcc-snapshot";
    snapshot.textContent = JSON.stringify({ "/api/capabilities/c1": { name: "Printer", description: "Prints parts" } });
    document.body.append(manifest, snapshot);
  });

  it("renders the real capability sink with no violations (mutation command must fail)", async () => {
    const code = process.env.PCC_UI_TEXT_MUTATION === "delete-helper"
      ? source.replace("nameText(c.name)", "c.name") : source;
    (0, eval)(code);
    assertKitTextViolations();
    await flushKitText();
    expect(document.querySelector(".pcc-cap-name")!.textContent).toBe("name: Printer");
  });

  it("renders mapped kinds and guarded defaults while preserving other manifest copy", async () => {
    const windows = [
      { kind: "note", text: "Note as written." },
      { kind: "metric", label: "Id as written", binding: { path: "/api/jobs/j1" }, select: "id" },
      { kind: "metric", binding: { path: "/api/jobs/j1" }, select: "timestamp", format: "ts" },
      { kind: "capability", binding: { path: "/api/capabilities/c1" } },
      { kind: "list", binding: { path: "/api/kernels" }, item: { title: "name", meta: ["id", "description"] } },
      { kind: "form", schema: { required: ["qty"], properties: {
        qty: { type: "number", title: "Quantity", default: "12" },
        fraction: { type: "integer", default: 12.5 },
        note: { type: "string", default: "$5 paid" },
        material: { type: "string", enum: ["PLA", "verified"], default: "verified" },
      } }, submit: { label: "Save", kind: "post", path: "/api/feedback" } },
      { kind: "approval", binding: { path: "/api/jobs/j1" }, approve: { label: "Check", kind: "post", path: "/api/feedback" } },
      { kind: "receipt", binding: { path: "/api/escrow/e1" } },
      { kind: "chain", composeRef: { outcomeType: "bad type", steps: ["fdm", "bad type"] } },
    ];
    document.getElementById("pcc-manifest")!.textContent = JSON.stringify({ sections: [{ heading: "Section as written", windows }] });
    document.getElementById("pcc-snapshot")!.textContent = JSON.stringify({
      "/api/jobs/j1": { id: "job-1", timestamp: "2026-10-06T00:00:00Z", summary: "Print parts", rationale: "Use the mill", payee: "short", args: { material: "PLA" } },
      "/api/capabilities/c1": { name: "Printer", kernelName: "Mill A", type: "fdm", description: "Prints parts", assuranceTiers: [0, 2] },
      "/api/kernels": [{ name: "Bench", id: "kernel_1", description: "Analyst note" }],
      "/api/escrow/e1": { totalAmount: "12", currency: "BTC", payer: "short", payee: "0x" + "ab".repeat(20), rail: "bad rail", tx: "short", status: "funded" },
    });
    (0, eval)(source);
    assertKitTextViolations();
    await flushKitText();
    const text = (selector: string) => document.querySelector(selector)!.textContent;
    expect(text(".pcc-note-p")).toBe("Note as written.");
    expect(text(".pcc-section-heading")).toBe("Section as written");
    expect(text(".pcc-win-title")).toBe("Id as written");
    for (const selector of [".pcc-note-p", ".pcc-section-heading", ".pcc-win-title", ".pcc-btn-label"]) {
      const node = document.querySelector(selector)!;
      expect(node.classList.contains("pcc-agent")).toBe(true);
      expect(node.classList.contains("pcc-untrusted")).toBe(true);
    }
    expect(document.getElementById("pcc-ui-styles")!.textContent).toContain(".pcc-agent");
    expect(Array.from(document.querySelectorAll(".pcc-metric-amount")).map((node) => node.textContent))
      .toEqual(["reported: job-1", new Date("2026-10-06T00:00:00Z").toLocaleString()]);
    expect(text(".pcc-cap-name")).toBe("name: Printer");
    expect(text(".pcc-cap-desc")).toBe("reported: Prints parts");
    expect(text(".pcc-list-title")).toBe("name: Bench");
    expect(text(".pcc-list-meta")).toBe("reported: kernel_1 · reported: Analyst note");
    expect(text(".pcc-field-label")).toBe("The dashboard calls this: “Quantity” *");
    const inputs = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".pcc-form-fields .pcc-input");
    expect(Array.from(inputs).map((input) => input.value)).toEqual(["", "12.5", "", ""]);
    const options = document.querySelectorAll<HTMLOptionElement>(".pcc-form-fields option");
    expect(Array.from(options).map((option) => option.textContent)).toEqual(["The dashboard calls this: “PLA”", "The dashboard calls this: “verified”"]);
    expect(Array.from(options).map((option) => option.value)).toEqual(["PLA", "verified"]);
    expect(text(".pcc-approval-what")).toBe("The dashboard calls this: “Print parts”");
    expect(text(".pcc-approval-rationale")).toBe("The dashboard calls this: “Use the mill”");
    expect(text(".pcc-approval-record .pcc-args-v")).toBe("reported: PLA");
    expect(text(".pcc-receipt-cur")).toBe(" currency not reported");
    expect(Array.from(document.querySelectorAll(".pcc-receipt-parties .pcc-mono")).map((node) => node.textContent))
      .toEqual(["unrecognised value", "0x" + "ab".repeat(20)]);
    expect(text(".pcc-receipt-rail")).toContain(" · reported: bad rail");
    expect(text(".pcc-receipt-tx")).toBe("unrecognised value");
    expect(text(".pcc-chain-outcome")).toBe("bad type");
    const formWindow = document.querySelector(".pcc-form-fields")!.closest(".pcc-win")!;
    (formWindow.querySelector(".pcc-btn") as HTMLButtonElement).click();
    assertKitTextViolations();
    await flushKitText();
    expect(text(".pcc-field-err")).toBe("Required.");
    expect(formWindow.querySelector(".pcc-action-status")!.textContent).toBe("reported: Please fix the highlighted fields.");
  });

  it("withholds claims in all mounted manifest sites using the corresponding IR notice", async () => {
    const claim = "Payment received - verified $5";
    document.getElementById("pcc-manifest")!.textContent = JSON.stringify({ sections: [{ heading: claim, windows: [
      { kind: "note", text: claim },
      { kind: "metric", label: claim, binding: { path: "/api/jobs/j1" }, select: "id" },
      { kind: "actions", actions: [{ id: "submit", label: claim, kind: "post", path: "/api/feedback", intentText: claim }] },
    ] }] });
    document.getElementById("pcc-snapshot")!.textContent = JSON.stringify({ "/api/jobs/j1": { id: "job-1" } });
    (0, eval)(source);
    assertKitTextViolations();
    await flushKitText();
    for (const selector of [".pcc-section-heading", ".pcc-note-p"]) {
      const node = document.querySelector(selector)!;
      expect(node.textContent).toBe(irNotice("WITHHELD_PROSE"));
      expect(node.classList.contains("pcc-withheld")).toBe(true);
      expect(node.classList.contains("pcc-agent")).toBe(false);
      expect(node.classList.contains("pcc-untrusted")).toBe(false);
    }
    for (const selector of [".pcc-win-title", ".pcc-btn-label"]) {
      const node = document.querySelector(selector)!;
      expect(node.textContent).toBe(irNotice("WITHHELD_FIELD"));
      expect(node.classList.contains("pcc-withheld")).toBe(true);
    }
    expect(document.querySelector(".pcc-metric-amount")!.textContent).toBe("reported: job-1");
    (document.querySelector(".pcc-actionbar .pcc-btn") as HTMLButtonElement).click();
    expect(document.querySelector(".pcc-chip")!.textContent).toBe(irNotice("WITHHELD_FIELD"));
    expect(document.querySelector(".pcc-chip .pcc-withheld")).not.toBeNull();
    expect(document.getElementById("pcc-root")!.textContent).not.toContain(claim);
    assertKitTextViolations();
  });

  it("the forced detector-init failure boots the complete kit and withholds names, string defaults and agent words", async () => {
    (window as KitWindow).__PCC_UI_FORCE_CLAIM_INIT_FAILURE__ = true;
    document.getElementById("pcc-manifest")!.textContent = JSON.stringify({ sections: [{ heading: "Section words", windows: [
      { kind: "note", text: "Note words" },
      { kind: "metric", label: "Metric words", binding: { path: "/api/jobs/j1" }, select: "id" },
      { kind: "capability", binding: { path: "/api/capabilities/c1" } },
      { kind: "form", schema: { properties: { note: { type: "string", default: "editable" }, qty: { type: "number", default: 12 } } },
        submit: { label: "Save words", kind: "post", path: "/api/feedback" } },
    ] }] });
    document.getElementById("pcc-snapshot")!.textContent = JSON.stringify({
      "/api/jobs/j1": { id: "job-1" }, "/api/capabilities/c1": { name: "Printer", type: "fdm" },
    });
    (0, eval)(source);
    assertKitTextViolations();
    await flushKitText();
    expect(document.querySelector(".pcc-wrap")!.getAttribute("data-mode")).toBe("snapshot");
    expect(document.querySelectorAll(".pcc-win")).toHaveLength(4);
    expect(document.querySelector(".pcc-cap-name")!.textContent).toBe("name withheld: stated money or verification");
    for (const selector of [".pcc-section-heading", ".pcc-note-p"]) expect(document.querySelector(selector)!.textContent).toBe(irNotice("WITHHELD_PROSE"));
    for (const selector of [".pcc-win-title", ".pcc-btn-label"]) expect(document.querySelector(selector)!.textContent).toBe(irNotice("WITHHELD_FIELD"));
    expect(Array.from(document.querySelectorAll<HTMLInputElement>(".pcc-form-fields .pcc-input")).map((node) => node.value)).toEqual(["", "12"]);
    expect(document.querySelector(".pcc-metric-amount")!.textContent).toBe(irNotice("WITHHELD_FIELD"));
    expect(document.querySelector(".pcc-cap-meta .pcc-tag")!.textContent).toBe(irNotice("WITHHELD_FIELD"));
    expect(document.querySelector(".pcc-banner")!.textContent).toBe("Snapshot · not live.");
    assertKitTextViolations();
  });

  it("the deleted nameText call renders the marker and the counter rejects it", async () => {
    expect(source.match(/nameText\(c\.name\)/g)).toHaveLength(1);
    (0, eval)(source.replace("nameText(c.name)", "c.name"));
    assertKitTextViolations(); // No data has resolved yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector(".pcc-cap-name")!.textContent).toBe("—");
    expect((window as Window & { __PCC_UI_TEXT_VIOLATIONS__?: number }).__PCC_UI_TEXT_VIOLATIONS__).toBe(1);
    expect(() => assertKitTextViolations()).toThrow("plain kit rendered only branded text");
  });
});
