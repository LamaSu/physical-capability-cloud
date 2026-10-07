import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { enclosingNamedFunction, isElementCreation, isIdentifier, isMember, lintTextSinks, localConstInitializer, memberName } from "./ui-kit-text-sinks-lint.js";
import type { TextSinkConfig } from "./ui-kit-text-sinks-lint.js";

const gatewayMcp = new URL("../../../gateway/src/mcp/", import.meta.url);
const browserConfig: TextSinkConfig = {
  file: fileURLToPath(new URL("dashboard-ir-browser-entry.ts", gatewayMcp)),
  scriptKind: ts.ScriptKind.TS,
  sinks: ["setText"],
  attributeMethods: ["setAttribute", "setAttr"],
  allowedAttributes: ["data-tone", "data-source", "data-as-of"],
  allowedNodeCalls: [
    {
      reason: "inert replaces the mount with p, a local const created by document.createElement; it inserts a Node only",
      matches: (call) => enclosingNamedFunction(call) === "inert" && isMember(call.expression, "mount", "replaceChildren") && call.arguments.length === 1 && isIdentifier(call.arguments[0], "p") && isElementCreation(localConstInitializer(call, "p")),
    },
    {
      reason: "renderManifest replaces the mount with container._el, the DOM element of a local const wrapEl(document.createElement(...))",
      matches: (call) => {
        const origin = localConstInitializer(call, "container");
        return enclosingNamedFunction(call) === "renderManifest" && isMember(call.expression, "mount", "replaceChildren") && call.arguments.length === 1 && isMember(call.arguments[0], "container", "_el") && !!origin && ts.isCallExpression(origin) && isIdentifier(origin.expression, "wrapEl") && origin.arguments.length === 1 && isElementCreation(origin.arguments[0]);
      },
    },
    {
      reason: "startBinds commits only Array.from(staging.childNodes), a NodeList from a local const document.createElement result",
      matches: (call) => {
        const argument = call.arguments[0];
        if (enclosingNamedFunction(call) !== "startBinds" || !isMember(call.expression, "el", "replaceChildren") || call.arguments.length !== 1 || !ts.isSpreadElement(argument)) return false;
        const array = argument.expression;
        return ts.isCallExpression(array) && isMember(array.expression, "Array", "from") && array.arguments.length === 1 && isMember(array.arguments[0], "staging", "childNodes") && isElementCreation(localConstInitializer(call, "staging"));
      },
    },
    {
      reason: "startBinds calls el.replaceChildren() without arguments to clear stale rows; it cannot insert text",
      matches: (call) => enclosingNamedFunction(call) === "startBinds" && isMember(call.expression, "el", "replaceChildren") && call.arguments.length === 0,
    },
  ],
};
const plainConfig: TextSinkConfig = {
  file: fileURLToPath(new URL("../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js", import.meta.url)),
  scriptKind: ts.ScriptKind.JS,
  sinks: ["el", "setText", "setAttrText", "setValue", "agentEl"],
  attributeMethods: ["setAttribute", "setAttr"],
  allowedAttributes: [
    "aria-disabled", // Boolean accessibility state, never displayed prose.
    "for", // Associates a label with its generated input id.
    "data-theme", // Selects the closed dark/light theme.
    "data-mode", // Records the kit's transport mode for styling.
  ],
  // appendChild is Node-only; this kit has no string-capable insertion allowance.
  allowedNodeCalls: [],
  allowedComputedWrites: [
    { function: "plainBody", target: "out", reason: "Copies request data into its fresh plain object after rejecting __proto__; preserves the baseline body semantics" },
    { function: "collectForm", target: "out", reason: "Collects form data into its fresh plain object; preserves the baseline field and __proto__ semantics" },
    { function: "intentState", target: "INTENT_STATE", reason: "Stores per-request state in the module's fresh null-prototype dictionary; no DOM receiver is reachable" },
  ],
  agentText: { mint: "agentText", sink: "agentEl", reason: "One claim-checking agent mint and one sink that adds the IR's agent and untrusted classes; agent brands cannot enter kit sinks" },
  allowedNameArguments: [
    {
      reason: 'el("label", ...) selects the HTML label element, rather than writing its label property',
      matches: (call, argument) => isIdentifier(call.expression, "el") && call.arguments[0] === argument && ts.isStringLiteral(argument) && argument.text === "label",
    },
    {
      reason: 'setAttrText\'s second argument selects one of its two guarded display attributes, title or placeholder',
      matches: (call, argument) => isIdentifier(call.expression, "setAttrText") && call.arguments.length === 3 && call.arguments[1] === argument && ts.isStringLiteral(argument) && ["title", "placeholder"].includes(argument.text),
    },
    {
      reason: 'setAttribute("aria-disabled", ...) writes only a boolean accessibility state from the reviewed metadata list',
      matches: (call, argument) => memberName(call.expression) === "setAttribute" && call.arguments.length === 2 && call.arguments[0] === argument && ts.isStringLiteral(argument) && argument.text === "aria-disabled",
    },
  ],
  textMints: {
    mint: "mintText",
    kitText: "kitText",
    helpers: [
      { name: "kitText", reason: "PCC copy; all external calls require literal-only arguments" },
      { name: "joinText", reason: "Composes only WeakSet-branded parts; any other part becomes the closed marker" },
      { name: "enumValueText", reason: "Preserves the original enum option's wire value while untrustedLabel attributes its visible text" },
      { name: "requestValueText", reason: "Preserves existing wire-formatted offer, approval, and exact request terms without presenting them as settlement facts" },
      { name: "requestDestinationText", reason: "Displays only the validated canonical request URL pinned to the PCC origin" },
      { name: "requestReasonText", reason: "Displays the descriptor's kit-owned refusal reason" },
      { name: "apiBaseText", reason: "Displays the resolved pinned API origin in the PCC footer" },
      { name: "numberText", reason: "Admits only finite numbers; it cannot carry arbitrary server prose" },
      { name: "settlementCaptionText", reason: "Admits only the closed classifier's settlement captions" },
      { name: "baseUnitsText", reason: "Formats only decimal base units with checked decimal precision" },
      { name: "fmtUsd", reason: "Preserves the existing amount formatter, including invalid-input String bytes required by the task" },
      { name: "fmtTs", reason: "Preserves the existing timestamp formatter; timeText separately checks the canonical UTC grammar" },
      { name: "fmtVal", reason: "Preserves locale grouping for finite numeric metrics; other values use typed helpers" },
      { name: "statusPillText", reason: "Applies the surface's closed status vocabulary and attributes every other status" },
      { name: "reportedText", reason: "Attributes server prose as reported and qualifies unconfirmed money surfaces" },
      { name: "dataStatusText", reason: "Applies the binding's settlement classifier or closed status vocabulary" },
      { name: "untrustedLabel", reason: "Quotes and attributes manifest-authored labels using the existing presentation" },
      { name: "amountText", reason: "Preserves the existing exact sum formatter or wire JSON request term" },
      { name: "idText", reason: "Admits the canonical identifier grammar, otherwise uses reportedText" },
      { name: "hexText", reason: "Admits only 40- or 64-digit hexadecimal values with a 0x prefix" },
      { name: "timeText", reason: "Admits canonical UTC timestamps through fmtTs, otherwise states time not reported" },
      { name: "traceText", reason: "Admits only the closed 8–64-character trace identifier grammar" },
      { name: "nameText", reason: "Frames names with the PCC name label and withholds embedded claims" },
      { name: "fieldDefaultText", reason: "Admits the field kind's finite-number or string grammar and withholds claims" },
      { name: "chainFactText", reason: "R12: re-mints an already-branded value as a money fact only with a pin chainPin registered; otherwise 'pending'" },
      { name: "pinReferenceText", reason: "R12: formats only fields chainPin validated (the closed network name, addresses, hashes and a decimal block)" },
      { name: "pinValueText", reason: "R12: shows one field chainPin validated, by a fixed key" },
      { name: "blockNumberText", reason: "R12: a log-derived block number, shown only as a canonical safe non-negative integer, grouped" },
      { name: "injectStyles", reason: "The CSS stylesheet is composed entirely of immutable PCC string literals" },
    ],
  },
};
const kits: TextSinkConfig[] = [
  {
    file: fileURLToPath(new URL("dashboard-ir-renderer.ts", gatewayMcp)),
    scriptKind: ts.ScriptKind.TS,
    sinks: ["el", "setText", "agentEl"],
    attributeMethods: ["setAttribute", "setAttr"],
    allowedAttributes: ["data-tone", "data-source", "data-as-of"],
    allowedNameArguments: [{
      reason: 'paintProse\'s fourth argument "label" selects a validated IR prose field, rather than a DOM member',
      matches: (call, argument) => isIdentifier(call.expression, "paintProse") && call.arguments.length === 4 && call.arguments[3] === argument && ts.isStringLiteral(argument) && argument.text === "label",
    }],
  },
  browserConfig,
  plainConfig,
];

// Run the same bypass corpus over both TS sources and the shipped JS source.
const bypasses = [
  "n.textContent = raw;",
  'n["innerText"] = raw;',
  'n[("innerText" satisfies string)] = raw;',
  "Object.assign(n, { textContent: raw });",
  'n.append("x");',
  'n.setAttribute("aria-label", raw);',
  "document.createTextNode(raw);",
  "n.outerText = raw;",
  "n.nodeValue = raw;",
  "n.data = raw;",
  'n["textContent"] += raw;',
  "n.textContent ||= raw;",
  "n.innerText ??= raw;",
  "n.data++;",
  "++n.data;",
  "for (n.textContent of values) {}",
  "for (n.innerText in values) {}",
  'Object["assign"](n, { ["innerText"]: raw });',
  "Object.assign(n, { textContent });",
  "Object.assign(n, { ...payload });",
  "Object.assign(n, payload);",
  "Object.assign(n, { [key]: raw });",
  "Object.assign.call(Object, n, { textContent: raw });",
  'n.insertAdjacentText("beforeend", raw);',
  "createTextNode(raw);",
  "document.createTextNode.call(document, raw);",
  "document.createTextNode.bind(document)(raw);",
  "document.title = raw;",
  'document["title"] = raw;',
  "n.title = raw;",
  "n.alt = raw;",
  "n.placeholder = raw;",
  "n.ariaLabel = raw;",
  'n["aria-description"] = raw;',
  'n.setAttribute("title", raw);',
  'n.setAttribute("alt", raw);',
  'n.setAttribute("placeholder", raw);',
  'n.setAttributeNS(null, "aria-label", raw);',
  'n.setAttr("aria-label", raw);',
  "n.setAttribute(attribute, raw);",
  'n["setAttribute"]("aria-label", raw);',
  'n["append"]("x");',
  "n.append.apply(n, [raw]);",
  "n.prepend(raw);",
  "n.before(raw);",
  "n.after(raw);",
  "n.replaceWith(raw);",
  "n.replaceChildren(raw);",
  "n.replaceChildren(document.createTextNode(raw));",
  "({ value: n.textContent } = payload);",
  "[n.innerText] = payload;",
  // Lane probes: each line must produce a finding, including indirect spellings.
  "const f = n.append; f.call(n, raw);",
  "const { append } = n; append.call(n, raw);",
  'Reflect.set(n, "textContent", raw);',
  "Reflect.apply(n.append, n, [raw]);",
  "n.appendChild(new Text(raw));",
  "n.appendChild(new Option(raw));",
  "n.firstChild.appendData(raw);",
  "n.firstChild.replaceData(0, 1, raw);",
  "n.innerHTML = raw;",
  "n.outerHTML = raw;",
  'n.insertAdjacentHTML("beforeend", raw);',
  "document.write(raw);",
  "n[k] = raw;",
  "alert(raw);",
  'n.setAttribute("value", raw);',
  'n.setAttribute("srcdoc", raw);',
  "n.value = raw;",
  "const assign = Object.assign; assign(n, { textContent: raw });",
  'const d = Object.getOwnPropertyDescriptor(Node.prototype, "textContent"); d.set.call(n, raw);',
  // toggleAttribute is now governed by the closed metadata-attribute list too.
  "n.toggleAttribute(raw);",
  // Every new surface, including reads, must fail without invoking it first.
  "const f = n.insertAdjacentHTML;",
  "const { setAttribute: f } = n;",
  "const { [k]: f } = n; f(raw);",
  "({ append: f } = n);",
  "const R = Reflect; R.set(n, k, raw);",
  "globalThis.Reflect.set(n, k, raw);",
  "globalThis.eval(raw);",
  "const F = globalThis.Function; F(raw);",
  "const O = globalThis.Object; O.assign(n, payload);",
  "const { eval: f } = globalThis; f(raw);",
  "({ Function: f } = globalThis); f(raw);",
  "const ownKeys = Reflect.ownKeys;",
  "new Proxy(n, {});",
  "eval(raw);",
  "new Function(raw);",
  "const O = Object; O.assign(n, payload);",
  "const { assign } = Object; assign(n, payload);",
  "Object.defineProperty(n, k, payload);",
  "Object.defineProperties(n, payload);",
  "Object.setPrototypeOf(n, payload);",
  "Object.getOwnPropertyDescriptors(n);",
  "n.__defineSetter__(k, setter);",
  "n.__lookupSetter__(k);",
  "new DOMParser();",
  "const TextConstructor = globalThis.Text; new TextConstructor(raw);",
  "n.createContextualFragment(raw);",
  "n.parseFromString(raw, mime);",
  "n.firstChild.insertData(0, raw);",
  "n.firstChild.replaceWholeText(raw);",
  "n.srcdoc = raw;",
  "document.writeln(raw);",
  "n.setHTMLUnsafe(raw);",
  "n.setHTML(raw);",
  "n.defaultValue = raw;",
  "n.label = raw;",
  'n.setAttribute("class", raw);',
  'n.setAttributeNS(null, "class", raw);',
  'n.toggleAttribute("class");',
  'n.setAttr("class", raw);',
  "n[k] += raw;",
  "n[k]++;",
  "++n[k];",
  "for (n[k] in values) {}",
  "for (n[k] of values) {}",
  "({ field: n[k] } = payload);",
  "[n[k]] = payload;",
  'anything("textContent");',
  'anything("append");',
  "confirm(raw);",
  "prompt(raw);",
  "const f = globalThis.alert; f(raw);",
  "const { prompt: f } = globalThis; f(raw);",
];

const ruleMutations = [
  ["method value read", "const f = n.append;", "forbidden method read: append"],
  ["method destructuring", "const { append } = n;", "forbidden method destructuring: append"],
  ["dynamic method destructuring", "const { [k]: f } = n;", "dynamic method destructuring"],
  ["reflection reference", "const R = Reflect;", "forbidden Reflect reference"],
  ["qualified reflection", "globalThis.Reflect.set(n, k, raw);", "forbidden Reflect access"],
  ["reflection constructor", "new Proxy(n, {});", "forbidden reflection reference: Proxy"],
  ["reflection eval", "eval(raw);", "forbidden reflection reference: eval"],
  ["reflection Function", "new Function(raw);", "forbidden reflection reference: Function"],
  ["Object.assign alias", "const assign = Object.assign;", "Object.assign used as a value may write text properties"],
  ["descriptor reflection", "Object.getOwnPropertyDescriptor(n, k);", "forbidden Object reflection: getOwnPropertyDescriptor"],
  ["setter reflection", "n.__lookupSetter__(k);", "forbidden setter reflection: __lookupSetter__"],
  ["Text constructor", "new Text(raw);", "text-carrying constructor: Text"],
  ["Option constructor", "new Option(raw);", "text-carrying constructor: Option"],
  ["DOMParser constructor", "new DOMParser();", "text-carrying constructor: DOMParser"],
  ["contextual parser", "n.createContextualFragment(raw);", "text parser call: createContextualFragment"],
  ["DOM parser", "n.parseFromString(raw, mime);", "text parser call: parseFromString"],
  ["text-node write", "n.appendData(raw);", "text insertion call: appendData"],
  ["HTML property", "n.innerHTML = raw;", "text property write: innerHTML"],
  ["HTML call", 'n.insertAdjacentHTML("beforeend", raw);', "HTML insertion call: insertAdjacentHTML"],
  ["form value", "n.value = raw;", "text property write: value"],
  ["form default", "n.defaultValue = raw;", "text property write: defaultValue"],
  ["label", "n.label = raw;", "text property write: label"],
  ["closed attribute", 'n.setAttribute("class", raw);', "unapproved attribute write: class"],
  ["closed adapter attribute", 'n.setAttr("class", raw);', "unapproved attribute write: class"],
  ["dynamic attribute", "n.toggleAttribute(k);", "dynamic attribute write: toggleAttribute"],
  ["computed assignment", "n[k] = raw;", "dynamic computed property write"],
  ["computed compound", "n[k] += raw;", "dynamic computed property write"],
  ["computed postfix", "n[k]++;", "dynamic computed property write"],
  ["computed prefix", "++n[k];", "dynamic computed property write"],
  ["computed for-in", "for (n[k] in values) {}", "dynamic computed property write"],
  ["computed for-of", "for (n[k] of values) {}", "dynamic computed property write"],
  ["computed object destructuring", "({ field: n[k] } = payload);", "dynamic computed property write"],
  ["computed array destructuring", "[n[k]] = payload;", "dynamic computed property write"],
  ["smuggled property name", 'anything("textContent");', "forbidden member name argument: textContent"],
  ["smuggled method name", 'anything("append");', "forbidden member name argument: append"],
  ["alert", "alert(raw);", "text dialog call: alert"],
  ["confirm", "confirm(raw);", "text dialog call: confirm"],
  ["prompt", "prompt(raw);", "text dialog call: prompt"],
] as const;

describe.each(kits)("text sinks in $file", (config) => {
  const source = readFileSync(config.file, "utf8");
  it("has no displayed-text writes outside the designated sinks", () => {
    expect(lintTextSinks(source, config)).toEqual([]);
  });
  it.each(bypasses)("reports injected bypass with its line: %s", (bypass) => {
    const prefix = source + "\nfunction injectedBypass(n, raw) {\n";
    const line = prefix.split("\n").length;
    const issues = lintTextSinks(prefix + "  " + bypass + "\n}\n", config);
    expect(issues.some((issue) => issue.line === line && issue.column > 0), JSON.stringify(issues)).toBe(true);
  });
});

describe("generic lint guard", () => {
  it.each(ruleMutations)("reports rule %s on its own injected line", (_name, source, rule) => {
    expect(lintTextSinks("\n" + source + "\n", { file: "kit", scriptKind: ts.ScriptKind.JS, sinks: [], attributeMethods: ["setAttr"], allowedAttributes: ["data-tone", "data-source", "data-as-of"] })).toContainEqual(expect.objectContaining({ line: 2, rule }));
  });
  it.each([ts.ScriptKind.TS, ts.ScriptKind.JS])("parses script kind %s and exempts only its configured sink", (scriptKind) => {
    const config = { file: "kit", scriptKind, sinks: ["writeText"] };
    expect(lintTextSinks("function writeText(n, t) { n.textContent = t; }", config)).toEqual([]);
    expect(lintTextSinks("function other(n, t) { n.textContent = t; }\nfunction writeText(n, t) { n.textContent = t; }", config)).toEqual([expect.objectContaining({ line: 1, rule: "text property write: textContent" })]);
  });
  it("does not exempt a nested callback inside a sink", () => {
    const issues = lintTextSinks("function setText(n, t) { (() => { n.textContent = t; })(); }", { file: "kit", scriptKind: ts.ScriptKind.JS, sinks: ["setText"] });
    expect(issues).toEqual([expect.objectContaining({ line: 1, rule: "text property write: textContent" })]);
  });
  it("fails closed on missing or duplicate sink definitions", () => {
    const config = { file: "kit", scriptKind: ts.ScriptKind.JS, sinks: ["setText"] };
    expect(lintTextSinks("", config)[0].rule).toContain("exactly one definition");
    expect(lintTextSinks("function setText(n, t) { n.textContent = t; } function setText(n, t) { n.textContent = t; }", config).some((issue) => issue.rule.includes("exactly one definition"))).toBe(true);
  });
  it("does not mistake reads or non-text attributes for bypasses", () => {
    expect(lintTextSinks('const t = n.textContent; n.setAttribute("data-tone", t); n.appendChild(child); Reflect.ownKeys(n);', { file: "kit", scriptKind: ts.ScriptKind.JS, sinks: [], allowedAttributes: ["data-tone"] })).toEqual([]);
  });
  it("allows Object.assign only when its first argument is a fresh object literal", () => {
    const config: TextSinkConfig = { file: "kit", scriptKind: ts.ScriptKind.JS, sinks: [] };
    expect(lintTextSinks('Object.assign({}, payload, { textContent: raw }); Object["assign"](({ seed: 1 }), payload);', config)).toEqual([]);
    // Mutating either the first argument or its position removes the allowance.
    for (const source of ['Object.assign(n, payload, { textContent: raw });', 'Object.assign(payload, {});', 'Object.assign(out, { safe: true });', 'Object.assign();']) {
      expect(lintTextSinks(source, config)).toContainEqual(expect.objectContaining({ rule: "Object.assign target must be a fresh object literal" }));
    }
    expect(lintTextSinks('Object.assign.call(Object, {}, payload);', config)).toContainEqual(expect.objectContaining({ rule: "indirect Object.assign may write text properties" }));
  });
  it("does not mistake manifest confirmation data for the global confirm dialog", () => {
    expect(lintTextSinks('const confirmation = action.confirm === "inline";', { file: "kit", scriptKind: ts.ScriptKind.JS, sinks: [] })).toEqual([]);
    expect(lintTextSinks('const confirmation = window.confirm;', { file: "kit", scriptKind: ts.ScriptKind.JS, sinks: [] })).toContainEqual(expect.objectContaining({ rule: "text dialog reference: confirm" }));
    expect(lintTextSinks('const receiver = window; const confirmation = receiver.confirm; confirmation(raw);', { file: "kit", scriptKind: ts.ScriptKind.JS, sinks: [] })).toContainEqual(expect.objectContaining({ rule: "text dialog reference: confirm" }));
  });
  it("permits numeric and other literal computed keys that cannot name text properties", () => {
    expect(lintTextSinks('n[1] = raw; n[-1] = raw; n[0n] = raw; n[true] = raw; n[null] = raw;', { file: "kit", scriptKind: ts.ScriptKind.JS, sinks: [] })).toEqual([]);
  });
  it("ignores type-position references to forbidden APIs", () => {
    expect(lintTextSinks('type Constructor = typeof Proxy; type Append = typeof n.append; type Reflection = typeof Reflect.set;', { file: "kit", scriptKind: ts.ScriptKind.TS, sinks: [] })).toEqual([]);
  });
  it("closes attributes by default and permits only configured metadata for every attribute API", () => {
    const config: TextSinkConfig = { file: "kit", scriptKind: ts.ScriptKind.JS, sinks: [], attributeMethods: ["setAttr"] };
    expect(lintTextSinks('n.setAttribute("data-tone", raw);', config)).toContainEqual(expect.objectContaining({ rule: "unapproved attribute write: data-tone" }));
    expect(lintTextSinks('n.setAttribute("data-tone", raw); n.setAttributeNS(null, "data-source", raw); n.toggleAttribute("data-as-of"); n.setAttr("data-tone", raw);', { ...config, allowedAttributes: ["data-tone", "data-source", "data-as-of"] })).toEqual([]);
  });
  it("the Node-only allowances reject strings at every approved replacement site", () => {
    const source = readFileSync(browserConfig.file, "utf8");
    const file = ts.createSourceFile(browserConfig.file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && memberName(node.expression) === "replaceChildren") calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(calls).toHaveLength(4);
    expect(browserConfig.allowedNodeCalls).toHaveLength(4);
    for (const call of calls) {
      const mutated = source.slice(0, call.getStart(file)) + call.expression.getText(file) + '("raw bypass")' + source.slice(call.end);
      const line = file.getLineAndCharacterOfPosition(call.getStart(file)).line + 1;
      expect(lintTextSinks(mutated, browserConfig)).toContainEqual(expect.objectContaining({ line, rule: "string-capable insertion call: replaceChildren" }));
    }
  });
});

describe("closed computed data writes", () => {
  const config: TextSinkConfig = {
    file: "kit.js", scriptKind: ts.ScriptKind.JS, sinks: [],
    allowedComputedWrites: [{ function: "collect", target: "out", reason: "Fresh data object; no DOM receiver is reachable" }],
  };
  const fresh = 'function collect(k, raw) { var out = {}; out[k] = raw; return out; }';
  it("accepts a fresh plain object and a fresh null-prototype object", () => {
    expect(lintTextSinks(fresh, config)).toEqual([]);
    expect(lintTextSinks(fresh.replace('var out = {}', 'var out = Object.create(null)'), config)).toEqual([]);
    expect(lintTextSinks('var out = Object.create(null); function collect(k, raw) { out[k] = raw; }', config)).toEqual([]);
  });
  it("reports the same write on another target", () => {
    expect(lintTextSinks(fresh.replace('out[k]', 'other[k]'), config)).toContainEqual(expect.objectContaining({ rule: "dynamic computed property write" }));
  });
  it.each([
    fresh.replace('var out = {}', 'var out = n'),
    fresh.replace('var out = {}', 'var out = Object.create(proto)'),
    fresh.replace('var out = {}', 'var out = { existing: true }'),
    fresh.replace('out[k] = raw;', 'out = n; out[k] = raw;'),
    fresh.replace('return out;', 'out = n; return out;'),
    fresh.replace('return out;', 'var out = n; return out;'),
    fresh.replace('out[k] = raw;', '({ data: out } = payload); out[k] = raw;'),
    fresh.replace('out[k] = raw;', '[out] = payload; out[k] = raw;'),
    fresh.replace('out[k] = raw;', 'for (out in payload) {} out[k] = raw;'),
    fresh.replace('var out = {};', ''),
    'var out = {}; function collect(out, k, raw) { out[k] = raw; }',
    'var out = {}; function collect(k, raw) { let out = n; out[k] = raw; }',
  ])("rejects a target whose binding is absent, shadowed, nonfresh or reassigned: %s", (source) => {
    expect(lintTextSinks(source, config)).toContainEqual(expect.objectContaining({ rule: "computed write target must be a fresh unreassigned object: collect.out" }));
  });
  it("does not transfer permission into another function or nested callback", () => {
    expect(lintTextSinks(fresh + ' function other(k, raw) { var out = {}; out[k] = raw; }', config)).toContainEqual(expect.objectContaining({ rule: "dynamic computed property write" }));
    expect(lintTextSinks(fresh + ' function nested(k, raw) { var out = {}; (function () { out[k] = raw; })(); }', config)).toContainEqual(expect.objectContaining({ rule: "dynamic computed property write" }));
  });
  it("requires a reason, rejects duplicate allowances, and detects stale entries", () => {
    const allowance = config.allowedComputedWrites![0];
    expect(lintTextSinks(fresh, { ...config, allowedComputedWrites: [{ ...allowance, reason: "" }] })).toContainEqual(expect.objectContaining({ rule: "computed write allowance collect.out requires a reason" }));
    expect(lintTextSinks(fresh, { ...config, allowedComputedWrites: [allowance, allowance] })).toContainEqual(expect.objectContaining({ rule: "duplicate computed write allowance: collect.out" }));
    expect(lintTextSinks('function collect() { var out = {}; }', config)).toContainEqual(expect.objectContaining({ rule: "stale computed write allowance: collect.out" }));
  });
  it("mutates every shipped computed-write allowance's exact receiver", () => {
    const source = readFileSync(plainConfig.file, "utf8");
    const file = ts.createSourceFile(plainConfig.file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const targets: ts.ElementAccessExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isElementAccessExpression(node.left) && plainConfig.allowedComputedWrites!.some((allowance) => enclosingNamedFunction(node) === allowance.function && isIdentifier(node.left.expression, allowance.target))) targets.push(node.left);
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(targets).toHaveLength(6); // plainBody 1, collectForm 4, intentState 1.
    for (const target of targets) {
      const receiver = target.expression;
      const mutated = source.slice(0, receiver.getStart(file)) + 'other' + source.slice(receiver.end);
      const line = file.getLineAndCharacterOfPosition(target.getStart(file)).line + 1;
      expect(lintTextSinks(mutated, plainConfig)).toContainEqual(expect.objectContaining({ line, rule: "dynamic computed property write" }));
    }
  });
  it("mutates the first argument of all three shipped Object.assign calls", () => {
    const source = readFileSync(plainConfig.file, "utf8");
    const file = ts.createSourceFile(plainConfig.file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && isMember(node.expression, "Object", "assign")) calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const target = call.arguments[0];
      expect(ts.isObjectLiteralExpression(target)).toBe(true);
      const mutated = source.slice(0, target.getStart(file)) + 'other' + source.slice(target.end);
      const line = file.getLineAndCharacterOfPosition(call.getStart(file)).line + 1;
      expect(lintTextSinks(mutated, plainConfig)).toContainEqual(expect.objectContaining({ line, rule: "Object.assign target must be a fresh object literal" }));
    }
  });
});

describe("closed agent text boundary", () => {
  const config: TextSinkConfig = {
    file: "kit.js", scriptKind: ts.ScriptKind.JS, sinks: ["agentEl"],
    agentText: { mint: "agentText", sink: "agentEl", reason: "One checked mint and one marked sink" },
  };
  const fixture = 'function agentText(raw) { return raw; }\nfunction agentEl(tag, cls, text) { n.textContent = text; }\n';
  it("allows only direct calls to the sole mint and sink", () => {
    expect(lintTextSinks(fixture + 'agentEl("span", "", agentText(raw));', config)).toEqual([]);
  });
  it.each([
    'var f = agentText; f(raw);', 'var f = agentEl; f(raw);',
    'agentText.call(null, raw);', 'agentEl.apply(null, args);',
    'agentText.bind(null)(raw);', 'agentEl.bind(null)(raw);',
    'source.agentText(raw);', 'source["agentEl"](raw);',
    'var { agentText: f } = source;', '({ agentEl: f } = source);',
    'agentText = foreignMint;', 'agentEl = foreignSink;',
  ])("reports the boundary mutation on its own line: %s", (source) => {
    expect(lintTextSinks(fixture + source, config)).toContainEqual(expect.objectContaining({ line: 3 }));
  });
  it.each(["agentText", "agentEl"])("requires exactly one %s definition", (name) => {
    expect(lintTextSinks(fixture + `function ${name}() {}`, config)).toContainEqual(expect.objectContaining({ rule: `agent text function ${name} must have exactly one definition (found 2)` }));
    const omitted = fixture.replace(new RegExp(`function ${name}[^\\n]*\\n`), "");
    expect(lintTextSinks(omitted, config)).toContainEqual(expect.objectContaining({ rule: `agent text function ${name} must have exactly one definition (found 0)` }));
  });
  it("requires a reason and registers only the one designated agent sink", () => {
    expect(lintTextSinks(fixture, { ...config, agentText: { ...config.agentText!, reason: "" } })).toContainEqual(expect.objectContaining({ rule: "agent text boundary requires a reason" }));
    expect(lintTextSinks(fixture, { ...config, sinks: [] })).toContainEqual(expect.objectContaining({ rule: "agent text sink must be a designated sink: agentEl" }));
  });
  it.each(['var f = agentText;', 'var f = agentEl;', 'agentText.call(null, raw);', 'agentEl.call(null, raw);'])("closes a shipped-kit agent boundary mutation: %s", (source) => {
    const kit = readFileSync(plainConfig.file, "utf8");
    const prefix = kit + '\nfunction injectedAgentBoundary(raw) {\n';
    expect(lintTextSinks(prefix + source + '\n}', plainConfig)).toContainEqual(expect.objectContaining({ line: prefix.split('\n').length }));
  });
});

describe("syntactic runtime text mint boundary", () => {
  const config: TextSinkConfig = {
    file: "runtime-kit.js",
    scriptKind: ts.ScriptKind.JS,
    sinks: [],
    textMints: {
      mint: "mintText",
      kitText: "kitText",
      helpers: [
        { name: "kitText", reason: "External PCC copy calls are restricted to literals" },
        { name: "safeText", reason: "This fixture models a helper that checks a closed grammar" },
      ],
    },
  };
  const fixture = 'function mintText(t) { return t; }\nfunction kitText(t) { return mintText(t); }\nfunction safeText(t) { return mintText(t); }\n';
  it("allows direct helper mints and literal-only PCC copy calls", () => {
    expect(lintTextSinks(fixture + 'kitText("Copy"); kitText(ok ? "Yes" : (other ? "Maybe" : "No"));', config)).toEqual([]);
    expect(lintTextSinks(fixture.replace('function safeText(t) { return mintText(t); }', 'function safeText(t) { return kitText(t); }'), config)).toEqual([]);
  });
  it.each([
    'mintText(raw);',
    'kitText(raw);',
    'kitText("reported: " + raw);',
    'kitText(ok ? "Safe" : raw);',
    'kitText(`Copy`);',
    'kitText();',
    'kitText("Copy", raw);',
    'const mint = mintText; mint(raw);',
    'const copy = kitText; copy(raw);',
    'mintText.call(null, raw);',
    'mintText.apply(null, [raw]);',
    'mintText.bind(null)(raw);',
    'kitText.call(null, "Copy");',
    'kitText.apply(null, ["Copy"]);',
    'kitText.bind(null)("Copy");',
    'const { kitText: copy } = source; copy(raw);',
    '({ mintText: mint } = source); mint(raw);',
    'const source = { kitText };',
    'source["kitText"](raw);',
    'mintText = foreignMint;',
  ])("reports mint bypass on the injected line: %s", (bypass) => {
    expect(lintTextSinks(fixture + bypass, config)).toContainEqual(expect.objectContaining({ line: 4 }));
  });
  it("does not extend a helper's permission into a nested callback", () => {
    const source = fixture.replace('function safeText(t) { return mintText(t); }', 'function safeText(t) { mintText(t); (() => mintText(t))(); }');
    expect(lintTextSinks(source, config)).toContainEqual(expect.objectContaining({ line: 3, rule: "text mint call outside approved helpers: mintText" }));
  });
  it("does not permit a sink to mint its input", () => {
    expect(lintTextSinks(fixture + 'function setText(n, t) { n.textContent = kitText(t); }', { ...config, sinks: ["setText"] })).toContainEqual(expect.objectContaining({ line: 4, rule: "kit text requires a literal-only argument: kitText" }));
  });
  it.each([
    fixture.replace('function safeText(t) { return mintText(t); }', ''),
    fixture.replace('function safeText(t) { return mintText(t); }', 'function safeText(t) { return t; }'),
    fixture.replace('function safeText(t) { return mintText(t); }', 'function safeText(t) { return kitText("fixed"); }'),
  ])("rejects stale mint helper entries", (source) => {
    expect(lintTextSinks(source, config)).toContainEqual(expect.objectContaining({ rule: "stale text mint helper allowance: safeText" }));
  });
  it("requires one definition and a reason for each helper", () => {
    expect(lintTextSinks(fixture + 'function safeText(t) { return mintText(t); }', config)).toContainEqual(expect.objectContaining({ rule: "text mint function safeText must have exactly one definition (found 2)" }));
    const invalid = { ...config, textMints: { ...config.textMints!, helpers: [{ name: "kitText", reason: "" }] } };
    expect(lintTextSinks(fixture, invalid)).toContainEqual(expect.objectContaining({ rule: "text mint helper kitText requires a reason" }));
  });
  it.each(['kitText(raw);', 'mintText(raw);', 'const copy = kitText; copy(raw);', 'kitText.call(null, raw);'])('closes a shipped-kit mint bypass: %s', (bypass) => {
    const source = readFileSync(plainConfig.file, "utf8");
    const prefix = source + "\nfunction injectedMintBypass(raw) {\n";
    expect(lintTextSinks(prefix + bypass + "\n}", plainConfig)).toContainEqual(expect.objectContaining({ line: prefix.split("\n").length }));
  });
});
