import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toFunctionSelector, type Abi, type AbiFunction } from "viem";
import { submitEvidenceAbiItem } from "../src/operator-signing.js";

// A variable import keeps the contracts package's sources outside this package's
// test TypeScript program. This is the TS ABI re-exported by its vnext subpath.
const escrowAbiModulePath = "../../contracts/ts/vnext/abi.ts";
const escrowSourcePath = fileURLToPath(new URL("../../contracts/src/VNextSettlementEscrow.sol", import.meta.url));
const prohibitedName = ["invoke", "Backup"].join("");
const sourceDirectory = fileURLToPath(new URL("../src", import.meta.url));

type SourceViolation = { path: string; kind: "name" | "selector" };

function solidityFunction(source: string, name: string) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declarations = [...source.matchAll(new RegExp(`\\bfunction\\s+${escapedName}\\s*\\(`, "g"))];
  if (declarations.length !== 1) {
    throw new Error(`Solidity source must declare exactly one ${name} operation; found ${declarations.length}`);
  }
  const declaration = declarations[0];
  const parameterStart = declaration.index! + declaration[0].length;
  const parameterEnd = source.indexOf(")", parameterStart);
  if (parameterEnd === -1) throw new Error("Solidity function parameter list is unterminated");
  const parameterList = source.slice(parameterStart, parameterEnd).trim();
  const parameterTypes = parameterList === "" ? [] : parameterList.split(",").map(parameter => {
    const tokens = parameter.trim().split(/\s+/).filter(token => !["memory", "storage", "calldata"].includes(token));
    if (!tokens[0]) throw new Error("Solidity function parameter type is missing");
    return tokens[0];
  });
  const signature = `${name}(${parameterTypes.join(",")})`;
  return { parameterTypes, selector: toFunctionSelector(signature) };
}

async function scanSource(directory: string, selector: string): Promise<SourceViolation[]> {
  const violations: SourceViolation[] = [];
  const lowerName = prohibitedName.toLowerCase();
  // Searching bare hex also catches prefixed hex, in either case.
  const lowerSelector = selector.slice(2).toLowerCase();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      violations.push(...await scanSource(path, selector));
    } else {
      const contents = (await readFile(path, "utf8")).toLowerCase();
      if (contents.includes(lowerName)) violations.push({ path, kind: "name" });
      if (contents.includes(lowerSelector)) violations.push({ path, kind: "selector" });
    }
  }
  return violations;
}

describe("operator source restrictions", () => {
  it("rejects prohibited operation names and selectors in every source file", async () => {
    const source = await readFile(escrowSourcePath, "utf8");
    const { parameterTypes, selector } = solidityFunction(source, prohibitedName);
    expect(parameterTypes, "prohibited Solidity operation must take exactly one bytes32").toEqual(["bytes32"]);
    expect(await scanSource(sourceDirectory, selector)).toEqual([]);

    const directory = await mkdtemp(join(tmpdir(), "print-host-source-guard-"));
    try {
      const nested = join(directory, "nested", "deeper");
      await mkdir(nested, { recursive: true });
      const namePath = join(nested, "name.txt");
      const barePath = join(nested, "bare.txt");
      const prefixedPath = join(directory, "prefixed.txt");
      await writeFile(namePath, `// ${prohibitedName.toUpperCase()}\n`);
      await writeFile(barePath, `// ${selector.slice(2).toUpperCase()}\n`);
      await writeFile(prefixedPath, `// ${selector.toUpperCase()}\n`);
      expect(await scanSource(directory, selector)).toEqual(expect.arrayContaining([
        { path: namePath, kind: "name" },
        { path: barePath, kind: "selector" },
        { path: prefixedPath, kind: "selector" },
      ]));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a missing Solidity function declaration", () => {
    expect(() => solidityFunction("function anotherOperation(bytes32 unitId) external {}", prohibitedName))
      .toThrow(/must declare exactly one .* operation; found 0/);
  });

  it("refuses repeated Solidity function declarations", () => {
    const source = `function ${prohibitedName}(bytes32 unitId) external {}
      function\n${prohibitedName} ( bytes32 unitId ) external {}`;
    expect(() => solidityFunction(source, prohibitedName))
      .toThrow(/must declare exactly one .* operation; found 2/);
  });

  it("pins the Solidity submission selector to the canonical escrow ABI and host ABI", async () => {
    const { VNextSettlementEscrowABI } = await import(escrowAbiModulePath) as {
      VNextSettlementEscrowABI: Abi;
    };
    const submissionItems = VNextSettlementEscrowABI.filter((item): item is AbiFunction =>
      item.type === "function" && item.name === submitEvidenceAbiItem.name);
    expect(submissionItems).toHaveLength(1);
    const source = await readFile(escrowSourcePath, "utf8");
    const { selector } = solidityFunction(source, submitEvidenceAbiItem.name);
    expect(selector).toBe(toFunctionSelector(submissionItems[0]));
    expect(selector).toBe(toFunctionSelector(submitEvidenceAbiItem));
  });
});
