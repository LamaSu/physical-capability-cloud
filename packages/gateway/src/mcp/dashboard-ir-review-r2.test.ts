import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { boundValueText, boundStatusText, RECORD_CLAIM_NOTE, RECORD_STATUS_NOTE } from "./dashboard-ir.js";
import { listFieldLabel, UNAVAILABLE } from "./dashboard-ir-renderer.js";

const source = readFileSync(new URL("dashboard-ir-renderer.ts", import.meta.url), "utf8");
function functionSource(name: string): string {
  const file = ts.createSourceFile("renderer.ts", source, ts.ScriptTarget.Latest, true);
  const fn = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!fn) throw new Error(`Missing ${name}`);
  return fn.getText(file);
}
describe("review F7: narrow approved bound mints", () => {
  it("has no unused recordValueText mint", () => {
    const source = readFileSync(new URL("dashboard-ir.ts", import.meta.url), "utf8");
    expect(source).toMatch(/export function recordValueText\(field: string, value: string\): string/);
    expect(source.match(/export function recordValueText[^}]+/s)?.[0]).not.toContain("as KitText");
  });
  it("attributes non-status bound values", () => {
    expect(boundValueText("name", "Printer")).toBe("reported: Printer");
    expect(boundValueText("status", "custom")).toBe("custom" + RECORD_CLAIM_NOTE);
  });
  it("reads status by field kind even when its key is state", () => {
    const code = ts.transpile(functionSource("readOwnPath") + "\n" + functionSource("readField") + '\nreadField({ state: "Verification passed" }, { kind: "status", key: "state" });', { target: ts.ScriptTarget.ES2022 });
    const result = vm.runInNewContext(code, { boundValueText, boundStatusText, UNAVAILABLE });
    expect(result.text).toBe("Verification passed" + RECORD_CLAIM_NOTE);
  });
});
describe("review F9: own-key list labels", () => {
  it.each(["toString", "constructor", "__proto__"])("returns unavailable for inherited key %s", (key) => {
    expect(listFieldLabel(key)).toBe(UNAVAILABLE);
  });
});
