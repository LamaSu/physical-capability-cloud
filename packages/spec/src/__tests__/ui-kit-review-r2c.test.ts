/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(new NodeURL("../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js", import.meta.url), "utf8");
const bootTail = /  if \(document\.readyState === 'loading'\) document\.addEventListener\('DOMContentLoaded', mount\);\n  else mount\(\);/;
type Kit = { dataAt(raw: unknown, key: string | number): unknown; dot(raw: unknown, path: string): unknown };
function kit() {
  // Evaluate in the tested data's realm so ordinary objects share Object.prototype.
  const sandbox = { window: { kit: undefined as Kit | undefined }, document, URL };
  new Function(...Object.keys(sandbox), source.replace(bootTail, "  window.kit = { dataAt, dot };"))(...Object.values(sandbox));
  return sandbox.window.kit!;
}

describe("review N4: dataAt keyed reads accept only plain objects and arrays", () => {
  it.each([
    ["alert", (): string => "alert"],
    ["computed alert", (): string => "al" + "ert"],
    ["document", (): string => "document"],
    ["setTimeout", (): string => "setTimeout"],
  ] as const)("does not hand out the global object's %s member", (_name, key) => {
    const k = kit();
    const globalObject = document.defaultView!;
    // Vitest makes some globals non-enumerable; restore browser WebIDL enumerability for this probe.
    const original = Object.getOwnPropertyDescriptor(globalObject, key())!;
    Object.defineProperty(globalObject, key(), { ...original, enumerable: true });
    try {
      expect(Object.prototype.propertyIsEnumerable.call(globalObject, key())).toBe(true);
      expect(k.dataAt(globalObject, key())).toBeUndefined();
    } finally { Object.defineProperty(globalObject, key(), original); }
  });

  it.each([
    ["class instance", () => new (class { field = "hidden"; })()],
    ["Map", () => Object.assign(new Map(), { field: "hidden" })],
  ] as const)("does not hand out keyed fields of a %s", (_name, raw) => {
    expect(kit().dataAt(raw(), "field")).toBeUndefined();
  });

  it("preserves plain objects, null-prototype objects, arrays, nested paths and own enumerable fields", () => {
    const k = kit();
    const raw = JSON.parse('{"field":1,"nested":{"rows":[{"value":"exact"}]}}') as Record<string, unknown>;
    Object.defineProperty(raw, "nonenumerable", { value: "hidden" });
    expect(k.dataAt(raw, "field")).toBe(1);
    expect(k.dataAt(raw, "toString")).toBeUndefined();
    expect(k.dataAt(raw, "nonenumerable")).toBeUndefined();
    raw.field = 2;
    expect(k.dataAt(raw, "field")).toBe(2);
    delete raw.field;
    expect(k.dataAt(raw, "field")).toBeUndefined();
    expect(k.dot(raw, "nested.rows.0.value")).toBe("exact");
    expect(k.dot(raw, "nested.absent.value")).toBeUndefined();
    const dictionary = Object.assign(Object.create(null), { field: "null prototype", nested: raw });
    expect(k.dataAt(dictionary, "field")).toBe("null prototype");
    expect(k.dot(dictionary, "nested.nested.rows.0.value")).toBe("exact");
    const array = Object.assign(["zero", "one"], { field: "array field" });
    expect(k.dataAt(array, 1)).toBe("one");
    expect(k.dataAt(array, "1")).toBe("one");
    expect(k.dataAt(array, "length")).toBe(2);
    expect(k.dataAt(array, "field")).toBe("array field");
    expect(k.dataAt(array, "map")).toBeUndefined();
  });

  it("keeps numeric arguments and NodeList reads and the length path", () => {
    const k = kit();
    const args = (function (..._values: unknown[]) { return arguments; })("first", "second");
    const parent = document.createElement("div");
    parent.append(document.createElement("span"));
    expect(k.dataAt(args, 1)).toBe("second");
    expect(k.dataAt(args, "length")).toBe(2);
    expect(k.dataAt(parent.childNodes, 0)).toBe(parent.firstChild);
    expect(k.dataAt(parent.childNodes, "length")).toBe(1);
    expect(() => k.dataAt(null, "field")).toThrow("Cannot read absent data");
  });
});
