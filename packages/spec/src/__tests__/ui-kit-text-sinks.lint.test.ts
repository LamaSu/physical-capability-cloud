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
    sinks: ["el", "setText"],
    attributeMethods: ["setAttribute", "setAttr"],
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
];

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
    expect(lintTextSinks('const t = n.textContent; n.setAttribute("data-tone", t); n.appendChild(child);', { file: "kit", scriptKind: ts.ScriptKind.JS, sinks: [] })).toEqual([]);
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
