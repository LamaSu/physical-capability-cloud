import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Scalar = string | number | boolean | null;
type Schema = {
  $schema?: string;
  title?: string;
  description?: string;
  type?: "object" | "string" | "integer" | "boolean";
  const?: Scalar;
  enum?: Scalar[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  allOf?: Schema[];
  oneOf?: Schema[];
  if?: Schema;
  then?: Schema;
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
const SUPPORTED_KEYWORDS = new Set([
  "$schema", "title", "description", "type", "const", "enum", "pattern", "minLength", "maxLength",
  "minimum", "maximum", "properties", "required", "additionalProperties", "allOf", "oneOf", "if", "then",
]);

/** Inspect every branch before evaluating values, including absent properties and unmatched branches. */
function assertSupportedKeywords(node: Schema, path: string): void {
  for (const keyword of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) throw new Error(`Unsupported schema keyword: ${path}.${keyword}`);
  }
  for (const [key, property] of Object.entries(node.properties ?? {})) {
    assertSupportedKeywords(property, `${path}.properties.${key}`);
  }
  for (const keyword of ["allOf", "oneOf"] as const) {
    node[keyword]?.forEach((branch, index) => assertSupportedKeywords(branch, `${path}.${keyword}[${index}]`));
  }
  if (node.if) assertSupportedKeywords(node.if, `${path}.if`);
  if (node.then) assertSupportedKeywords(node.then, `${path}.then`);
}

function validate(node: Schema, value: unknown, path = "$"): string[] {
  assertSupportedKeywords(node, path);
  return validateSupported(node, value, path);
}

function validateSupported(node: Schema, value: unknown, path: string): string[] {
  const errors: string[] = [];
  const object = value !== null && typeof value === "object" && !Array.isArray(value);
  const correctType = node.type === undefined || (node.type === "object" ? object
    : node.type === "integer" ? typeof value === "number" && Number.isInteger(value)
    : node.type === "string" ? typeof value === "string"
    : node.type === "boolean" && typeof value === "boolean");
  if (!correctType) return [`${path}: expected ${node.type}`];
  if (Object.hasOwn(node, "const") && value !== node.const) errors.push(`${path}: const`);
  if (node.enum && !node.enum.includes(value as Scalar)) errors.push(`${path}: enum`);
  if (node.pattern && typeof value === "string" && !new RegExp(node.pattern).test(value)) {
    errors.push(`${path}: pattern`);
  }
  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (node.minLength !== undefined && length < node.minLength) errors.push(`${path}: minLength`);
    if (node.maxLength !== undefined && length > node.maxLength) errors.push(`${path}: maxLength`);
  }
  if (node.minimum !== undefined && typeof value === "number" && value < node.minimum) {
    errors.push(`${path}: minimum`);
  }
  if (node.maximum !== undefined && typeof value === "number" && value > node.maximum) {
    errors.push(`${path}: maximum`);
  }
  if (object) {
    const record = value as Record<string, unknown>;
    const properties = node.properties ?? {};
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(record, key)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, entry] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) errors.push(...validateSupported(properties[key], entry, `${path}.${key}`));
      else if (node.additionalProperties === false) errors.push(`${path}.${key}: additionalProperties`);
    }
  }
  for (const branch of node.allOf ?? []) errors.push(...validateSupported(branch, value, path));
  if (node.if && node.then && validateSupported(node.if, value, path).length === 0) {
    errors.push(...validateSupported(node.then, value, path));
  }
  if (node.oneOf && node.oneOf.filter((branch) => validateSupported(branch, value, path).length === 0).length !== 1) {
    errors.push(`${path}: oneOf`);
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

  it("validates the mainnet schedule on Base and Base Sepolia", () => {
    const record = baseSepoliaTestnetRecord();
    Object.assign(record, {
      scheduleId: "vnext-mainnet-v1", scheduleTestnetOnly: false,
      challengeWindowSec: 172800, appealWindowSec: 432000, backupWindowSec: 172800,
      emergencyReviewWindowSec: 432000, minReclaimDelaySec: 864000, maxReclaimDelaySec: 31536000,
      reverify: "forge script script/DeployVNextSettlement.s.sol --sig 'verify(address)' <factory>",
    });
    for (const chainId of [8453, 84532]) expect(validate(schema, { ...record, chainId })).toEqual([]);
  });

  it("validates the testnet schedule on anvil", () => {
    expect(validate(schema, { ...baseSepoliaTestnetRecord(), chainId: 31337 })).toEqual([]);
  });

  it("requires the testnet reverify command to select its build profile", () => {
    expect(baseSepoliaTestnetRecord().reverify).toBe(
      "FOUNDRY_PROFILE=testnet forge script script/DeployVNextSettlement.s.sol --sig 'verify(address)' <factory>",
    );
  });

  it("refuses unknown keywords even in unmatched branches and absent properties", () => {
    const unknown = { unsupportedKeyword: true } as unknown as Schema;
    for (const branch of [
      { type: "object", properties: { absent: unknown } },
      { if: { const: false }, then: unknown },
      { oneOf: [{ const: true }, { const: false, ...unknown }] },
      { allOf: [{ const: false }, unknown] },
    ] as Schema[]) {
      expect(() => validate(branch, true)).toThrow("Unsupported schema keyword:");
    }
  });

  it("requires exactly one matching oneOf branch", () => {
    expect(validate({ oneOf: [{ const: true }, { type: "boolean" }] }, true)).toEqual(["$: oneOf"]);
  });

  it.each([
    ["missing scheduleTestnetOnly", (record: Record<string, unknown>) => { delete record.scheduleTestnetOnly; }, "required"],
    ["extra key", (record: Record<string, unknown>) => { record.unrecognized = true; }, "additionalProperties"],
    ["PROVISIONAL mode", (record: Record<string, unknown>) => { record.mode = "PROVISIONAL"; }, "const"],
    ["malformed address", (record: Record<string, unknown>) => { record.factory = "0x1234"; }, "pattern"],
    ["chainId 0", (record: Record<string, unknown>) => { record.chainId = 0; }, "minimum"],
    ["testnet-only on Base", (record: Record<string, unknown>) => { record.chainId = 8453; }, "enum"],
    ["unknown scheduleId", (record: Record<string, unknown>) => { record.scheduleId = "unknown"; }, "oneOf"],
    ["mismatched schedule tuple", (record: Record<string, unknown>) => { record.scheduleTestnetOnly = false; }, "oneOf"],
    ["zero challenge window", (record: Record<string, unknown>) => { record.challengeWindowSec = 0; }, "minimum"],
    ["specVersion 1", (record: Record<string, unknown>) => { record.specVersion = 1; }, "const"],
    ["specVersion 3", (record: Record<string, unknown>) => { record.specVersion = 3; }, "const"],
    ["address with trailing newline", (record: Record<string, unknown>) => { record.factory = `${record.factory}\n`; }, "maxLength"],
    ["bytes32 with trailing newline", (record: Record<string, unknown>) => { record.digest = `${record.digest}\n`; }, "maxLength"],
    ["unsafe integer parsed from JSON", (record: Record<string, unknown>) => {
      record.primaryCohortId = JSON.parse("9007199254740993");
    }, "maximum"],
  ] as const)("rejects %s", (_name, change, reason) => {
    const record = baseSepoliaTestnetRecord();
    change(record);
    expect(validate(schema, record).some((error) => error.endsWith(`: ${reason}`))).toBe(true);
  });
});
