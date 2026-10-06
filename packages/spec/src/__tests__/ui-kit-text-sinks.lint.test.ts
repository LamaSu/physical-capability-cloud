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
];

// The same lint accepts ScriptKind.JS and a different sink list for task 2.
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
