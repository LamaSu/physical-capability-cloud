import { beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import type { AgentText, KitText } from "./dashboard-ir.js";
import { ambientValue } from "./dashboard-ir-runtime-ambient.type-test.js";

const CLAIM = "PAID IN FULL - verified by PCC";
const HERE = dirname(fileURLToPath(import.meta.url));
interface PhysicalNode {
  textContent: unknown;
  className: string;
  children: PhysicalNode[];
  setAttr(name: string, value: string): void;
  appendChild(child: PhysicalNode): PhysicalNode;
}
function node(): PhysicalNode {
  let rendered: unknown = "";
  return {
    get textContent() { return rendered; },
    set textContent(value: unknown) {
      rendered = value !== null && typeof value === "object" && "t" in value
        ? (value as { t: unknown }).t : value;
    },
    className: "", children: [], setAttr() {},
    appendChild(child) { this.children.push(child); return child; },
  };
}
const doc = { createElement: () => node() };
interface Harness {
  kitText(text: string): KitText;
  registerKitText(text: unknown): KitText;
  registerAgentText(text: unknown): AgentText;
  boundValueText(field: string, value: unknown): KitText;
  boundStatusText(value: unknown): KitText;
  identifierText(field: string, value: unknown): KitText;
  reportedFieldText(field: string, value: unknown): KitText;
  httpStatusText(value: unknown): KitText;
  filterTerm(key: unknown, value: unknown): KitText;
  countText(value: unknown): KitText;
  isKitText(value: unknown): boolean;
  joinKitText(...parts: unknown[]): KitText;
  joinKitTextWith(sep: unknown, parts: readonly unknown[]): KitText;
  manifestProseText(n: { props: { text: string } }, key: "text"): AgentText;
  rendererSetText(n: PhysicalNode, value: unknown): void;
  el(d: typeof doc, cls: string, value: unknown): PhysicalNode;
  agentEl(d: typeof doc, cls: string, value: unknown): PhysicalNode;
  browserSetText(n: PhysicalNode, value: unknown): void;
  setAuthoredText(n: PhysicalNode, value: unknown): void;
  wrapEl(n: PhysicalNode): PhysicalNode;
}
let api: Harness;
let realm: { __PCC_UI_TEXT_VIOLATIONS__?: number };
let bundledSource: string;

beforeAll(async () => {
  // The appended exports only exist in this in-memory test build. Every production
  // function and all mints are bundled once, sharing the same private brand sets.
  const result = await build({
    stdin: {
      contents: `import * as core from "./dashboard-ir.js";
export {kitText, joinKitText, registerKitText, registerAgentText, boundValueText, boundStatusText, identifierText, reportedFieldText} from "./dashboard-ir.js";
export {httpStatusText} from "./dashboard-ir-binder.js";
export function isKitText(value) { const check = Reflect.get(core, "isKitText"); return typeof check === "function" && check(value); }
export {setText as rendererSetText, el, agentEl, manifestProseText, joinKitTextWith, filterTerm, countText} from "./dashboard-ir-renderer.js";
export {setText as browserSetText, setAuthoredText, wrapEl} from "./dashboard-ir-browser-entry.js";`,
      resolveDir: HERE,
      sourcefile: "runtime-brand-harness.ts",
      loader: "ts",
    },
    bundle: true, write: false, format: "iife", platform: "browser", globalName: "runtimeHarness",
    plugins: [{ name: "private-test-exports", setup(builder) {
      builder.onLoad({ filter: /dashboard-ir-(renderer|browser-entry)\.ts$/ }, (args) => {
        const exports = args.path.endsWith("renderer.ts")
          ? "\nexport { manifestProseText, joinKitTextWith, filterTerm, countText };\n"
          : "\nexport { wrapEl };\n";
        return { contents: readFileSync(args.path, "utf8") + exports, loader: "ts", resolveDir: dirname(args.path) };
      });
    } }],
  });
  realm = {};
  bundledSource = result.outputFiles[0]!.text;
  vm.runInNewContext(bundledSource, realm);
  api = (realm as typeof realm & { runtimeHarness: Harness }).runtimeHarness;
});

interface Sink { name: string; tier: "kit" | "agent" | "authored"; write(value: unknown): unknown }
const sinks: Sink[] = [
  { name: "renderer setText", tier: "kit", write(value) { const n = node(); api.rendererSetText(n, value); return n.textContent; } },
  { name: "renderer el", tier: "kit", write(value) { return api.el(doc, "pcc-x", value).textContent; } },
  { name: "renderer agentEl", tier: "agent", write(value) { return api.agentEl(doc, "pcc-x", value).textContent; } },
  { name: "browser setText", tier: "kit", write(value) { const n = node(); api.browserSetText(n, value); return n.textContent; } },
  { name: "browser setAuthoredText", tier: "authored", write(value) { const n = node(); api.setAuthoredText(n, value); return n.textContent; } },
  { name: "browser wrapEl setter", tier: "authored", write(value) { const n = node(); api.wrapEl(n).textContent = value; return n.textContent; } },
];
function agent(): AgentText { return api.manifestProseText({ props: { text: "Agent-authored description" } }, "text"); }
function expectFailedComposition(combined: KitText): void {
  expect(api.isKitText(combined)).toBe(true);
  expect(Object.isFrozen(combined)).toBe(true);
  expect(combined.t).toBe("—");
  expect(realm.__PCC_UI_TEXT_VIOLATIONS__).toBe(1);
  expect(sinks[0]!.write(combined)).toBe("—");
  expect(realm.__PCC_UI_TEXT_VIOLATIONS__).toBe(1);
}
const invalidValues: Array<[string, () => unknown]> = [
  ["raw string", () => CLAIM],
  ["forged frozen object", () => Object.freeze({ t: CLAIM })],
  ["object carrying a brand property", () => Object.freeze({ t: CLAIM, __kitText: Symbol("KitText"), __agentText: Symbol("AgentText") })],
  ["Proxy of a real brand", () => {
    const real = api.kitText("PCC-owned copy");
    // Before the port the mint returns a primitive, which cannot be proxied. Its
    // boxed representation preserves this test's invalid-object baseline.
    return new Proxy(typeof real === "object" ? real : Object(real), {});
  }],
  ["String object", () => new String(CLAIM)],
  ["null", () => null],
  ["number", () => 23],
];

describe("IR opaque runtime text brands", () => {
  for (const sink of sinks) {
    for (const [kind, value] of invalidValues) {
      it(`${sink.name} fails closed for ${kind} and counts one violation`, () => {
        realm.__PCC_UI_TEXT_VIOLATIONS__ = 0;
        expect(sink.write(value())).toBe("—");
        expect(realm.__PCC_UI_TEXT_VIOLATIONS__).toBe(1);
      });
    }
    it(`${sink.name} renders a real mint in its accepted tier without a violation`, () => {
      realm.__PCC_UI_TEXT_VIOLATIONS__ = 0;
      expect(sink.write(sink.tier === "agent" ? agent() : api.kitText("PCC-owned copy")))
        .toBe(sink.tier === "agent" ? "Agent-authored description" : "PCC-owned copy");
      expect(realm.__PCC_UI_TEXT_VIOLATIONS__).toBe(0);
    });
    it(`${sink.name} enforces its other authorship tier`, () => {
      realm.__PCC_UI_TEXT_VIOLATIONS__ = 0;
      const result = sink.write(sink.tier === "agent" ? api.kitText("PCC-owned copy") : agent());
      expect(result).toBe(sink.tier === "authored" ? "Agent-authored description" : "—");
      expect(realm.__PCC_UI_TEXT_VIOLATIONS__).toBe(sink.tier === "authored" ? 0 : 1);
    });
  }

  for (const [kind, value] of invalidValues) {
    it(`joinKitText fails closed when one member is a ${kind}`, () => {
      realm.__PCC_UI_TEXT_VIOLATIONS__ = 0;
      const combined = api.joinKitText(api.kitText("Prefix"), value());
      expectFailedComposition(combined);
    });
    it(`joinKitTextWith fails closed when one member is a ${kind}`, () => {
      realm.__PCC_UI_TEXT_VIOLATIONS__ = 0;
      const combined = api.joinKitTextWith(api.kitText(", "), [api.kitText("Prefix"), value()]);
      expectFailedComposition(combined);
    });
    it(`joinKitTextWith checks a ${kind} separator even with one member`, () => {
      realm.__PCC_UI_TEXT_VIOLATIONS__ = 0;
      const combined = api.joinKitTextWith(value(), [api.kitText("Checked")]);
      expectFailedComposition(combined);
    });
    it(`joinKitTextWith checks a sole ${kind} member`, () => {
      realm.__PCC_UI_TEXT_VIOLATIONS__ = 0;
      const combined = api.joinKitTextWith(api.kitText(", "), [value()]);
      expectFailedComposition(combined);
    });
  }
  it("combines real mints without losing their text or authorship", () => {
    expect(sinks[0]!.write(api.joinKitText(api.kitText("PCC"), api.kitText(" copy")))).toBe("PCC copy");
    expect(sinks[0]!.write(api.joinKitTextWith(api.kitText(", "), [api.kitText("First"), api.kitText("Second")]))).toBe("First, Second");
  });

  const crossedBoundaries: Array<[string, () => unknown]> = [
    ["JSON serialization", () => JSON.parse(JSON.stringify(api.kitText("PCC-owned copy")))],
    ["structuredClone", () => structuredClone(api.kitText("PCC-owned copy"))],
    ["another module realm", () => {
      const other: { runtimeHarness?: Harness } = {};
      vm.runInNewContext(bundledSource, other);
      return other.runtimeHarness!.kitText("PCC-owned copy");
    }],
  ];
  for (const [name, value] of crossedBoundaries) {
    it(`a KitText crossing ${name} loses membership and fails closed`, () => {
      const crossed = value();
      realm.__PCC_UI_TEXT_VIOLATIONS__ = 0;
      expect(sinks[1]!.write(crossed)).toBe("—");
      expect(realm.__PCC_UI_TEXT_VIOLATIONS__).toBe(1);
    });
  }

  // Each route is ordinary TypeScript code: the runtime sink receives a raw claim
  // whose static type has been laundered to KitText through Romeo's seven families.
  const identity = (value: KitText): KitText => value;
  function erase<T>(value: T): unknown { return value; }
  function genericErasure(): KitText {
    const g = erase(identity) as (value: string) => KitText;
    return g(CLAIM);
  }
  function libraryCallback(): KitText {
    return [identity].map((g: unknown) => (g as (value: string) => KitText)(CLAIM))[0]!;
  }
  class Overload {
    take(value: string | object): KitText;
    take(value: KitText): KitText { return value; }
  }
  function topTypeRoundTrip(): KitText {
    const branded = { payload: api.kitText("Checked") };
    const hidden: unknown = branded;
    const writable = hidden as { payload: string };
    writable.payload = CLAIM;
    return branded.payload;
  }
  function doubleAssertion(): KitText {
    const branded = { payload: api.kitText("Checked") };
    const writable = (branded as {}) as { payload: string };
    writable.payload = CLAIM;
    return branded.payload;
  }
  function prototypeInstanceof(): KitText {
    interface Constructor { readonly prototype: { t: KitText }; new (): object }
    const Constructor: Constructor = class { t = api.kitText("Checked"); };
    const spoof: unknown = { __proto__: Constructor.prototype, t: CLAIM };
    return spoof instanceof Constructor ? spoof.t : api.kitText("Checked");
  }
  const routes: Array<[string, () => KitText]> = [
    ["generic erasure", genericErasure],
    ["library callback", libraryCallback],
    ["overload implementation", () => new Overload().take(CLAIM)],
    ["top-type round trip", topTypeRoundTrip],
    ["double assertion through {}", doubleAssertion],
    ["ambient augmentation in a test-local module", () => ambientValue(CLAIM).valueOf()],
    ["instanceof through a branded prototype", prototypeInstanceof],
  ];
  for (const [name, route] of routes) {
    it(`fails closed for Romeo family: ${name}`, () => {
      const value: KitText = route();
      expect(value).toBe(CLAIM); // Proves the route produced the raw claim, not a mint.
      realm.__PCC_UI_TEXT_VIOLATIONS__ = 0;
      expect(sinks[1]!.write(value)).toBe("—");
      expect(realm.__PCC_UI_TEXT_VIOLATIONS__).toBe(1);
    });
  }

  const primitiveTampering: Array<[string, string]> = [
    ["WeakSet.prototype.has", "WeakSet.prototype.has = function () { return true; }"],
    ["WeakSet.prototype.add", "WeakSet.prototype.add = function () { return this; }"],
    ["WeakMap.prototype.get", "WeakMap.prototype.get = function () { return 'PAID IN FULL - verified by PCC'; }"],
    ["WeakMap.prototype.set", "WeakMap.prototype.set = function () { return this; }"],
    ["Object.freeze", "Object.freeze = function (value) { return value; }"],
    ["Reflect.apply", "Reflect.apply = function () { return 'PAID IN FULL - verified by PCC'; }"],
    ["Function.prototype.call", "Function.prototype.call = function () { throw new Error('live call'); }"],
    ["Function.prototype.apply", "Function.prototype.apply = function () { throw new Error('live apply'); }"],
  ];
  for (const [name, tamper] of primitiveTampering) {
    it(`captures ${name} before tampering after load`, () => {
      const isolated: { runtimeHarness?: Harness; __PCC_UI_TEXT_VIOLATIONS__?: number } = {};
      vm.runInNewContext(bundledSource, isolated);
      vm.runInNewContext(tamper, isolated);
      const loaded = isolated.runtimeHarness!;
      isolated.__PCC_UI_TEXT_VIOLATIONS__ = 0;
      const forgedNode = node();
      let threw = false;
      try { loaded.setAuthoredText(forgedNode, { t: CLAIM }); } catch { threw = true; }
      expect(threw).toBe(false);
      expect(forgedNode.textContent).toBe("—");
      expect(isolated.__PCC_UI_TEXT_VIOLATIONS__).toBe(1);
      const genuine = loaded.kitText("PCC-owned copy");
      expect(Object.isFrozen(genuine)).toBe(true);
      const genuineNode = node();
      loaded.setAuthoredText(genuineNode, genuine);
      expect(genuineNode.textContent).toBe("PCC-owned copy");
      expect(isolated.__PCC_UI_TEXT_VIOLATIONS__).toBe(1);
    });
  }

  for (const name of ["kitText", "registerKitText", "registerAgentText"] as const) {
    it(`${name} rejects non-string registrar input with one violation`, () => {
      const hostile = { toString: () => CLAIM };
      realm.__PCC_UI_TEXT_VIOLATIONS__ = 0;
      const mint = api[name] as (value: unknown) => KitText | AgentText;
      const minted = mint(hostile);
      expect(minted.t).toBe("—");
      expect(Object.isFrozen(minted)).toBe(true);
      const n = node();
      api.setAuthoredText(n, minted);
      expect(n.textContent).toBe("—");
      expect(realm.__PCC_UI_TEXT_VIOLATIONS__).toBe(1);
    });
  }
  it("freezes AgentText identity brands", () => {
    expect(Object.isFrozen(agent())).toBe(true);
  });

  const stringMints: Array<[string, (value: unknown) => KitText]> = [
    ["boundValueText", (value) => api.boundValueText("note", value)],
    ["boundStatusText", (value) => api.boundStatusText(value)],
    ["identifierText", (value) => api.identifierText("id", value)],
    ["reportedFieldText", (value) => api.reportedFieldText("note", value)],
  ];
  for (const [name, mint] of stringMints) {
    it(`${name} checks the runtime string type before inspecting or coercing input`, () => {
      let inspected = 0;
      const hostile = { normalize: () => { inspected += 1; return "ok"; }, toString: () => { inspected += 1; return CLAIM; } };
      realm.__PCC_UI_TEXT_VIOLATIONS__ = 0;
      expect(sinks[0]!.write(mint(hostile))).toBe("—");
      expect(realm.__PCC_UI_TEXT_VIOLATIONS__).toBe(1);
      expect(inspected).toBe(0);
    });
    it(`${name} rejects a genuine KitText used as a string input`, () => {
      realm.__PCC_UI_TEXT_VIOLATIONS__ = 0;
      expect(sinks[0]!.write(mint(api.kitText("PCC-owned copy")))).toBe("—");
      expect(realm.__PCC_UI_TEXT_VIOLATIONS__).toBe(1);
    });
  }
  it("httpStatusText rejects a genuine KitText used as a number input", () => {
    realm.__PCC_UI_TEXT_VIOLATIONS__ = 0;
    expect(sinks[0]!.write(api.httpStatusText(api.kitText("PCC-owned copy")))).toBe("—");
    expect(realm.__PCC_UI_TEXT_VIOLATIONS__).toBe(1);
  });
  it("filterTerm rejects a genuine KitText used as a key input", () => {
    realm.__PCC_UI_TEXT_VIOLATIONS__ = 0;
    expect(sinks[0]!.write(api.filterTerm(api.kitText("PCC-owned copy"), true))).toBe("—");
    expect(realm.__PCC_UI_TEXT_VIOLATIONS__).toBe(1);
  });
  for (const invalid of [CLAIM, 99, 600, 200.5, Number.NaN, Number.POSITIVE_INFINITY, {}, null]) {
    it(`httpStatusText rejects invalid status ${String(invalid)}`, () => {
      realm.__PCC_UI_TEXT_VIOLATIONS__ = 0;
      expect(sinks[0]!.write(api.httpStatusText(invalid))).toBe("—");
      expect(realm.__PCC_UI_TEXT_VIOLATIONS__).toBe(1);
    });
  }
  for (const valid of [100, 200, 599]) {
    it(`httpStatusText preserves valid status ${valid}`, () => {
      realm.__PCC_UI_TEXT_VIOLATIONS__ = 0;
      expect(sinks[0]!.write(api.httpStatusText(valid))).toBe(`HTTP ${valid}`);
      expect(realm.__PCC_UI_TEXT_VIOLATIONS__).toBe(0);
    });
  }
  for (const invalid of [CLAIM, "__proto__", "a.constructor", "a..b", "a".repeat(257), {}, null]) {
    it(`filterTerm rejects a key outside the bind-selector grammar ${String(invalid)}`, () => {
      realm.__PCC_UI_TEXT_VIOLATIONS__ = 0;
      expect(sinks[0]!.write(api.filterTerm(invalid, true))).toBe("—");
      expect(realm.__PCC_UI_TEXT_VIOLATIONS__).toBe(1);
    });
  }
  for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "23", {}, null, Number.NaN]) {
    it(`countText renders unavailable for a negative, fractional, unsafe or non-number count ${String(invalid)}`, () => {
      expect(sinks[0]!.write(api.countText(invalid))).toBe("—");
    });
  }
});
