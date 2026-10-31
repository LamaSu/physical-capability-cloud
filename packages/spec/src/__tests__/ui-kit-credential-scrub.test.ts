import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const source = readFileSync(new URL("../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js", import.meta.url), "utf8");
const file = ts.createSourceFile("pcc-ui.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declarations: ts.FunctionDeclaration[] = [];
function collect(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "bootKey") declarations.push(node);
  ts.forEachChild(node, collect);
}
collect(file);

function boot(hash: string, options: { host?: boolean; historyThrows?: boolean; storageThrows?: boolean } = {}) {
  expect(declarations).toHaveLength(1);
  const writes: unknown[][] = [], stored: unknown[][] = [], assignments: string[] = [];
  const location = {
    get hash() { return hash; },
    set hash(_value: string) { assignments.push("hash"); },
    pathname: "/ui/kit/current",
    search: "?mode=live&tab=2",
  };
  vm.runInNewContext(declarations[0]!.getText(file) + "\nbootKey();", {
    isHostEmbed: () => !!options.host,
    KEY_STORE: "pcc.key",
    location,
    history: { replaceState(...args: unknown[]) { writes.push(args); if (options.historyThrows) throw new Error("history unavailable"); } },
    sessionStorage: { setItem(...args: unknown[]) { stored.push(args); if (options.storageThrows) throw new Error("storage unavailable"); } },
    serverText: "https://server.example/claim",
    agentText: "https://agent.example/claim",
  });
  return { writes, stored, assignments };
}

describe("round 2f-b: bootKey scrub URL", () => {
  it.each([
    "#pcc_key=credential%20fixture",
    "#pcc_key=credential%20fixture&agent=https://agent.example/claim",
    "#server=https://server.example/claim&pcc_key=credential%20fixture",
    "#pcc_key=credential%20fixture&prose=%3Cscript%3Eclaim%3C/script%3E",
  ])("writes only the current path/query, dropping all fragment text: %s", (hash) => {
    const { writes, stored, assignments } = boot(hash);
    expect(stored).toEqual([["pcc.key", "credential fixture"]]);
    expect(writes).toEqual([[null, "", "/ui/kit/current?mode=live&tab=2"]]);
    expect(new URL(String(writes[0]![2]), "https://capability.network").hash).toBe("");
    expect(assignments).toEqual([]);
  });
  it("still scrubs when storage is unavailable", () => {
    expect(boot("#pcc_key=fixture", { storageThrows: true }).writes).toEqual([[null, "", "/ui/kit/current?mode=live&tab=2"]]);
  });
  it("does not add a location assignment when history throws", () => {
    const result = boot("#pcc_key=fixture", { historyThrows: true });
    expect(result.writes).toHaveLength(1);
    expect(result.assignments).toEqual([]);
  });
  it("leaves host mode and a fragment without a credential alone", () => {
    expect(boot("#pcc_key=fixture", { host: true })).toEqual({ writes: [], stored: [], assignments: [] });
    expect(boot("#agent=claim")).toEqual({ writes: [], stored: [], assignments: [] });
  });
});
