import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";
import { SAFE_STATUS_WORDS, boundStatusText, readText, type IrNode } from "./dashboard-ir.js";
import { bindSchemaCard, listWindow } from "./dashboard-ir-renderer.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAIM = "PAID IN FULL - verified by PCC";
const slot = () => ({ textContent: { t: "" } });
let currency: unknown;
let versionState: object;
let readVersion: (row: unknown, field: string) => { ok: boolean; text?: { t: string } };
let exportedModules: Record<string, Record<string, unknown>>;
beforeAll(async () => {
  const result = await build({ stdin: { contents: 'export {CURRENCY_ENUM, LIST_VERSION_RE, readListField} from "./dashboard-ir-renderer.js";', resolveDir: HERE, loader: "ts" }, bundle: true, write: false, platform: "browser", format: "iife", globalName: "testState", plugins: [{ name: "private-test-state", setup(b) { b.onLoad({ filter: /dashboard-ir-renderer\.ts$/ }, (args) => ({ contents: readFileSync(args.path, "utf8") + "\nexport { CURRENCY_ENUM, LIST_VERSION_RE, readListField };", loader: "ts", resolveDir: dirname(args.path) })); } }] });
  const realm: { testState?: { CURRENCY_ENUM: unknown; LIST_VERSION_RE: object; readListField: typeof readVersion } } = {};
  vm.runInNewContext(result.outputFiles[0]!.text, realm);
  currency = realm.testState!.CURRENCY_ENUM;
  versionState = realm.testState!.LIST_VERSION_RE;
  readVersion = realm.testState!.readListField;
  const exportsResult = await build({ stdin: { contents: 'export * as irCore from "./dashboard-ir.js"; export * as irBinder from "./dashboard-ir-binder.js"; export * as irRenderer from "./dashboard-ir-renderer.js"; export * as irEntry from "./dashboard-ir-browser-entry.js";', resolveDir: HERE, loader: "ts" }, bundle: true, write: false, platform: "browser", format: "iife", globalName: "exportedModules" });
  const exportsRealm: { exportedModules?: typeof exportedModules } = {};
  vm.runInNewContext(exportsResult.outputFiles[0]!.text, exportsRealm);
  exportedModules = exportsRealm.exportedModules!;
});
describe("r2f carried runtime trust boundaries", () => {
  it("keeps every exported non-function value deeply immutable", () => {
    const seen = new Set<object>();
    function visit(value: unknown, path: string): void {
      if (value === null || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      expect.soft(Object.isFrozen(value), path).toBe(true);
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if ("value" in descriptor) visit(descriptor.value, path + "." + String(key));
      }
    }
    for (const [moduleName, module] of Object.entries(exportedModules)) {
      for (const [name, value] of Object.entries(module)) {
        if (typeof value !== "function") visit(value, moduleName + "." + name);
      }
    }
  });
  it("W20: the exported safe status vocabulary cannot acquire a claim", () => {
    expect(Object.isFrozen(SAFE_STATUS_WORDS)).toBe(true);
    const add = Reflect.get(SAFE_STATUS_WORDS, "add");
    if (typeof add === "function") Reflect.apply(add, SAFE_STATUS_WORDS, [CLAIM.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()]);
    expect(readText(boundStatusText(CLAIM)).t).not.toBe(CLAIM);
  });
  it("W21: version validator state cannot be recompiled to show a claim", () => {
    const compile = Reflect.get(versionState, "compile");
    const source = Reflect.get(versionState, "source");
    try {
      if (typeof compile === "function") { try { Reflect.apply(compile, versionState, ["^.+$"]); } catch {} }
      const field = readVersion({ version: CLAIM }, "version");
      expect(field.ok ? field.text?.t : "—").not.toBe(CLAIM);
    } finally {
      if (typeof compile === "function" && typeof source === "string") Reflect.apply(compile, versionState, [source]);
    }
  });
  it("W22: the currency vocabulary is immutable at runtime", () => {
    expect(Object.isFrozen(currency)).toBe(true);
    expect(Reflect.get(currency as object, "add")).toBeUndefined();
    expect(Reflect.set(currency as object, "0", CLAIM)).toBe(false);
    const slots = Array.from({ length: 6 }, slot);
    expect(bindSchemaCard("capability-summary-v1", { name: "Printer", type: "fdm", pricing: { currency: CLAIM } }, slots as never)).toBe(false);
    expect(slots.map((s) => s.textContent.t)).not.toContain(CLAIM);
  });
  it("W51: tiers are read once into checked primitive values", () => {
    let reads = 0;
    const tiers = [1];
    Object.defineProperty(tiers, "0", { get: () => ++reads === 1 ? 1 : CLAIM });
    const slots = Array.from({ length: 6 }, slot);
    expect(bindSchemaCard("capability-summary-v1", { name: "Printer", type: "fdm", assuranceTiers: tiers }, slots as never)).toBe(true);
    expect(reads).toBe(1);
    expect(slots[4]!.textContent.t).toBe("1");
    expect(slots.map((s) => s.textContent.t)).not.toContain(CLAIM);
  });
  it("W50: a grammar-valid claim key cannot become a PCC filter label", () => {
    const n = { type: "list", id: "n1", props: {}, bind: { path: "/api/kernels", query: { PAID_IN_FULL_verified_by_PCC: true } } } as IrNode;
    expect(readText(listWindow(n, {}, 0).note).t).not.toContain("PAID_IN_FULL_verified_by_PCC");
  });
});

it("T8 IR: every agentEl-produced role matches a rendered label selector from the shipped view CSS", () => {
  const source = readFileSync(resolve(HERE, "mcp-app-view.ts"), "utf8");
  const irView = source.slice(source.indexOf("export function buildMcpAppIrDashboardHtml"));
  const css = irView.slice(irView.indexOf("<style>") + 7, irView.indexOf("</style>"));
  expect(createHash("sha256").update(css.replace(/\r\n/g, "\n")).digest("hex")).toBe("c3cbec05c7ac649078bd865e58ff4d1bcd420ac1640cba75c46ef7e15decca9f");
  const kit = readFileSync(resolve(HERE, "../../../../apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js"), "utf8");
  const renderer = readFileSync(resolve(HERE, "dashboard-ir-renderer.ts"), "utf8");
  expect([...renderer.matchAll(/\bagentEl\(/g)]).toHaveLength(2); // declaration and shared paintProse call
  const dom = new JSDOM('<!doctype html><html><head><style>' + css + '</style></head><body><main id="pcc-ir-root"></main></body></html>', { url: "https://capability.network/", runScripts: "outside-only" });
  const w = dom.window;
  try {
    w.parent.postMessage = () => {};
    Reflect.set(w, "__PCC_IR_ORIGIN__", "https://capability.network");
    w.eval(kit);
    w.dispatchEvent(new w.MessageEvent("message", { source: w.parent, data: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2026-01-26" } } }));
    const manifest = { csd: "pcc://artifacts/dashboard/v1", title: "T8 title", sections: [{ heading: "T8 heading", windows: [ { kind: "note", text: "T8 note" }, { kind: "actions", actions: [{ id: "a", label: "T8 action" }] }, { kind: "form", schema: { type: "object", properties: { message: { title: "T8 field", type: "string" } } } } ] }] };
    w.dispatchEvent(new w.MessageEvent("message", { source: w.parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { manifest: w.JSON.parse(w.JSON.stringify(manifest)) } } } }));
    const selectors = [...w.document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).filter((rule) => "style" in rule && (rule as CSSStyleRule).style.getPropertyValue("content").replace(/["']/g, "") === "agent-authored").flatMap((rule) => (rule as CSSStyleRule).selectorText.split(",").map((s) => s.replace(/::before/g, "")));
    const agents = [...w.document.querySelectorAll(".pcc-agent")];
    expect(agents.map((e) => e.textContent)).toEqual(expect.arrayContaining(["T8 title", "T8 heading", "T8 note", "T8 action", "T8 field"]));
    for (const el of agents) expect(selectors.some((s) => el.matches(s)), `${el.className}: ${el.textContent}`).toBe(true);
    for (const sheet of [...w.document.styleSheets]) {
      const pendingRules = [...sheet.cssRules];
      for (let index = 0; index < pendingRules.length; index++) {
        const rule = pendingRules[index]!;
        if ("cssRules" in rule) pendingRules.push(...Array.from((rule as CSSGroupingRule).cssRules));
        if (!("selectorText" in rule) || !("style" in rule)) continue;
        const typed = rule as CSSStyleRule;
        for (const selector of typed.selectorText.split(",")) {
          const trimmed = selector.trim();
          if (!/::before$/.test(trimmed)) continue;
          for (const el of agents) {
            if (el.matches(trimmed.replace(/::before$/, ""))) expect(["", '"agent-authored"', "'agent-authored'"]).toContain(typed.style.getPropertyValue("content"));
          }
        }
      }
    }
    expect(Reflect.get(w, "__PCC_UI_TEXT_VIOLATIONS__") ?? 0).toBe(0);
  } finally { w.close(); }
});
