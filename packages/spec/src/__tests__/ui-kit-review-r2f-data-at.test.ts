/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(new NodeURL("../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js", import.meta.url), "utf8");
const bootTail = /  if \(document\.readyState === 'loading'\) document\.addEventListener\('DOMContentLoaded', mount\);\n  else mount\(\);/;
type Kit = { dataAt(raw: unknown, key: string | number): unknown };
function kit(): Kit {
  const target: { kit: Kit | undefined } = { kit: undefined };
  const sandbox = { window: target, document, URL };
  new Function(...Object.keys(sandbox), source.replace(bootTail, "  window.kit = { dataAt };"))(...Object.values(sandbox));
  return sandbox.window.kit!;
}

describe("review A-5: dataAt never returns a callable", () => {
  it.each(["assign", "values", "entries"])("withholds a function obtained from Object.%s", (method) => {
    const globalObject = document.defaultView!;
    const original = Object.getOwnPropertyDescriptor(globalObject, "alert")!;
    Object.defineProperty(globalObject, "alert", { ...original, enumerable: true });
    try {
      const k = kit();
      if (method === "assign") expect(k.dataAt(Object.assign({}, globalObject), "al" + "ert")).toBeUndefined();
      if (method === "values") expect(k.dataAt(Object.values<unknown>(globalObject), Object.values<unknown>(globalObject).indexOf(globalObject.alert))).toBeUndefined();
      if (method === "entries") expect(k.dataAt(Object.entries(globalObject).find(([key]) => key === "alert")!, 1)).toBeUndefined();
    } finally { Object.defineProperty(globalObject, "alert", original); }
  });
  it("never returns a callable from a changing length getter", () => {
    let reads = 0;
    const raw = Object.defineProperty({}, "length", { get() { return ++reads === 1 ? 1 : () => "claim"; } });
    const value = kit().dataAt(raw, "length");
    expect(typeof value).not.toBe("function");
    expect(reads).toBe(1);
  });
  it.each(["plain object", "array keyed", "array numeric", "array-like numeric"])("withholds %s callable and reads its field once", (kind) => {
    let reads = 0;
    const callable = () => "claim";
    const raw: Record<string, unknown> | unknown[] = kind === "plain object" ? {} : kind === "array-like numeric" ? { length: 1 } : [undefined];
    const key = kind === "plain object" ? "field" : kind === "array keyed" ? "0" : 0;
    Object.defineProperty(raw, key, { enumerable: true, configurable: true, get() { reads++; return callable; } });
    expect(kit().dataAt(raw, key)).toBeUndefined();
    expect(reads).toBe(1);
  });
});
