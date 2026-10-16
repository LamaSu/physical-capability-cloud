import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
const RECORDS_ROOT = fileURLToPath(new URL("../../deployments/vnext", import.meta.url));
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

function committedRecord(slug: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(RECORDS_ROOT, slug, "CANONICAL.json"), "utf8"));
}

/** The directory check needs the record path, which JSON Schema cannot inspect. */
function validateCommittedRecord(slug: string, record: Record<string, unknown>): string[] {
  const errors = validate(schema, record);
  const namedChains = new Map([["base", 8453], ["base-sepolia", 84532], ["anvil", 31337]]);
  const chainSlug = /^chain-([1-9][0-9]*)$/.exec(slug);
  const expectedChainId = namedChains.get(slug) ?? (chainSlug ? Number(chainSlug[1]) : undefined);
  if (expectedChainId === undefined || record.chainId !== expectedChainId) {
    errors.push("$.chainId: directory mismatch");
  }
  return errors;
}

describe("V-next CANONICAL record schema", () => {
  it("describes every key serialized by the Solidity writer, and requires every property", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.additionalProperties).toBe(false);
    const properties = Object.keys(schema.properties ?? {}).sort();
    expect(properties).toEqual(writerKeys(readFileSync(WRITER_PATH, "utf8")));
    expect([...(schema.required ?? [])].sort()).toEqual(properties);
  });

  it("bounds every hex-pattern string and non-const integer property", () => {
    let hexProperties = 0;
    let integerProperties = 0;
    const check = (node: Schema, path: string): void => {
      for (const [key, property] of Object.entries(node.properties ?? {})) {
        const propertyPath = `${path}.${key}`;
        if (property.pattern?.startsWith("^0x")) {
          hexProperties++;
          const hexPattern = /^\^0x\[0-9a-fA-F\]\{([0-9]+)\}\$$/.exec(property.pattern);
          expect(hexPattern, propertyPath).not.toBeNull();
          expect(hexPattern![0], propertyPath).toBe(property.pattern);
          const length = Number(hexPattern![1]) + 2;
          expect(property.minLength, propertyPath).toBe(length);
          expect(property.maxLength, propertyPath).toBe(length);
        }
        if (property.type === "integer" && !Object.hasOwn(property, "const")) {
          integerProperties++;
          expect(property.minimum, propertyPath).toBeTypeOf("number");
          expect(property.maximum, propertyPath).toBeTypeOf("number");
          expect(property.maximum, propertyPath).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
        }
        check(property, propertyPath);
      }
      for (const keyword of ["allOf", "oneOf"] as const) {
        node[keyword]?.forEach((branch, index) => check(branch, `${path}.${keyword}[${index}]`));
      }
      if (node.if) check(node.if, `${path}.if`);
      if (node.then) check(node.then, `${path}.then`);
    };
    check(schema, "$");
    expect(hexProperties).toBeGreaterThanOrEqual(12);
    expect(integerProperties).toBeGreaterThanOrEqual(14);
  });

  it("validates every committed canonical record against its schema and directory", () => {
    const slugs = readdirSync(RECORDS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(RECORDS_ROOT, entry.name, "CANONICAL.json")))
      .map((entry) => entry.name);
    expect(slugs).toContain("base-sepolia");
    for (const slug of slugs) {
      const record = committedRecord(slug);
      expect(validateCommittedRecord(slug, record), slug).toEqual([]);
      expect(record.specVersion, slug).toBe(2);
      if (record.scheduleTestnetOnly === true) expect([84532, 31337], slug).toContain(record.chainId);
    }
  });

  it("pins the published Base Sepolia record bytes and factory", () => {
    const bytes = readFileSync(join(RECORDS_ROOT, "base-sepolia", "CANONICAL.json"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "f0fd711084755608ab6b96e499ff41049e401c342d4777e4d4dda343f3e3bd5c",
    );
    expect(committedRecord("base-sepolia").factory).toBe("0xA31938E1a57E569E1d34F55E7F7A92BE1467c6d7");
  });

  it.each([
    ["a Base chainId in base-sepolia", { chainId: 8453 }, "directory mismatch"],
    ["a factory with a trailing newline", { factory: `${committedRecord("base-sepolia").factory}\n` }, "maxLength"],
  ] as const)("rejects a committed-record copy with %s", (_name, change, reason) => {
    const record = { ...committedRecord("base-sepolia"), ...change };
    expect(validateCommittedRecord("base-sepolia", record).some((error) => error.endsWith(`: ${reason}`))).toBe(true);
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
