import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Scalar = string | number | boolean | null;
type Schema = {
  $schema?: string;
  title?: string;
  description?: string;
  type: "object" | "string" | "integer" | "boolean";
  const?: Scalar;
  enum?: Scalar[];
  pattern?: string;
  minimum?: number;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
};

const SCHEMA_PATH = fileURLToPath(new URL("../../deployments/vnext/CANONICAL.schema.json", import.meta.url));
const WRITER_PATH = fileURLToPath(new URL("../../script/DeployVNextSettlement.s.sol", import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/vnext-canonical-base-sepolia.json", import.meta.url));
const schema: Schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

/**
 * Exactly the committed schema's subset, with unknown keywords refused so a future schema extension
 * cannot silently weaken this test. validatePrimitiveParams in @pcc/spec handles object shapes but
 * refuses const, pattern and minimum, so it cannot validate this record; no dependency is added here.
 */
function validate(node: Schema, value: unknown, path = "$"): string[] {
  const supported = new Set([
    "$schema", "title", "description", "type", "const", "enum", "pattern", "minimum",
    "properties", "required", "additionalProperties",
  ]);
  for (const keyword of Object.keys(node)) {
    if (!supported.has(keyword)) throw new Error(`Unsupported schema keyword: ${path}.${keyword}`);
  }
  const errors: string[] = [];
  const object = value !== null && typeof value === "object" && !Array.isArray(value);
  const correctType = node.type === "object" ? object
    : node.type === "integer" ? typeof value === "number" && Number.isInteger(value)
    : node.type === "string" ? typeof value === "string"
    : node.type === "boolean" && typeof value === "boolean";
  if (!correctType) return [`${path}: expected ${node.type}`];
  if (Object.hasOwn(node, "const") && value !== node.const) errors.push(`${path}: const`);
  if (node.enum && !node.enum.includes(value as Scalar)) errors.push(`${path}: enum`);
  if (node.pattern && typeof value === "string" && !new RegExp(node.pattern).test(value)) {
    errors.push(`${path}: pattern`);
  }
  if (node.minimum !== undefined && typeof value === "number" && value < node.minimum) {
    errors.push(`${path}: minimum`);
  }
  if (object) {
    const record = value as Record<string, unknown>;
    const properties = node.properties ?? {};
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(record, key)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, entry] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) errors.push(...validate(properties[key], entry, `${path}.${key}`));
      else if (node.additionalProperties === false) errors.push(`${path}.${key}: additionalProperties`);
    }
  }
  return errors;
}

/** Ignore comments while preserving string literals, including quoted comment markers. */
function writerKeys(source: string): string[] {
  const uncommented = source.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (token) => token.startsWith("/") ? " " : token,
  );
  const serialized = [...uncommented.matchAll(/\bvm\.serialize\w+\s*\(\s*[^,]*,\s*"([^"\\]+)"/g)];
  if (!serialized.length) throw new Error("No record writer serialization calls found");
  return [...new Set(serialized.map((match) => match[1]))].sort();
}

/** Dummy deployment identities; the fixture describes Base Sepolia, never a published deployment. */
function baseSepoliaTestnetRecord(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

describe("V-next CANONICAL record schema", () => {
  it("describes every key serialized by the Solidity writer, and requires every property", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.additionalProperties).toBe(false);
    const properties = Object.keys(schema.properties ?? {}).sort();
    expect(properties).toEqual(writerKeys(readFileSync(WRITER_PATH, "utf8")));
    expect([...(schema.required ?? [])].sort()).toEqual(properties);
  });

  it("parses multiline calls and ignores commented calls", () => {
    expect(writerKeys(`
      // vm.serializeBool(j, "comment", false);
      /* vm.serializeUint(j, "blockComment", 0); */
      vm.serializeString(
        j,
        "realKey",
        "/* literal text */ // literal text"
      );
    `)).toEqual(["realKey"]);
  });

  it("validates a realistic Base Sepolia record built with the testnet schedule", () => {
    expect(validate(schema, baseSepoliaTestnetRecord())).toEqual([]);
  });

  it.each([
    ["missing scheduleTestnetOnly", (record: Record<string, unknown>) => { delete record.scheduleTestnetOnly; }, "required"],
    ["extra key", (record: Record<string, unknown>) => { record.unrecognized = true; }, "additionalProperties"],
    ["PROVISIONAL mode", (record: Record<string, unknown>) => { record.mode = "PROVISIONAL"; }, "const"],
    ["malformed address", (record: Record<string, unknown>) => { record.factory = "0x1234"; }, "pattern"],
    ["chainId 0", (record: Record<string, unknown>) => { record.chainId = 0; }, "minimum"],
  ] as const)("rejects %s", (_name, change, reason) => {
    const record = baseSepoliaTestnetRecord();
    change(record);
    expect(validate(schema, record).some((error) => error.endsWith(`: ${reason}`))).toBe(true);
  });
});
