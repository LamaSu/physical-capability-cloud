import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  __setPaidScopeActivationTermsForTest,
  configuredVNextChainId,
  paidScopeActivationTerms,
  vnextNetworkSlug,
} from "../services/paid-scope-activation-terms.js";

interface FieldRule {
  type: "boolean" | "integer" | "string";
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}
interface CanonicalSchema {
  required: string[];
  properties: Record<string, FieldRule>;
  oneOf: Array<{ properties: Record<string, { const: unknown }> }>;
}

const contractsRoot = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const schema = JSON.parse(readFileSync(join(contractsRoot, "deployments/vnext/CANONICAL.schema.json"), "utf8")) as CanonicalSchema;
const committed = JSON.parse(readFileSync(join(contractsRoot, "deployments/vnext/base-sepolia/CANONICAL.json"), "utf8")) as Record<string, unknown>;

// The gateway reads these fields. Derive each constraint's near-miss from the committed schema,
// so changing a schema rule without updating the hand-written reader fails this agreement test.
const READ_FIELDS = [
  "canonical", "doNotPin", "mode", "label", "broadcast",
  "factory", "implementation", "usdc", "chainId", "specVersion", "blockNumber",
  "scheduleId", "scheduleTestnetOnly",
] as const;

function mainnetRecord(): Record<string, unknown> {
  const record = { ...committed, chainId: 8453 };
  const branch = schema.oneOf.find((candidate) => candidate.properties.scheduleTestnetOnly?.const === false)!;
  for (const [field, rule] of Object.entries(branch.properties)) record[field] = rule.const;
  return record;
}

const dirs: string[] = [];
let warnings: unknown[][];

/** Exercise the configured file reader, never the test-installed terms source. */
function resolve(record: Record<string, unknown>, network = vnextNetworkSlug(Number(record.chainId))): number | null {
  const root = mkdtempSync(join(tmpdir(), "q9-vnext-guard-private-path-"));
  dirs.push(root);
  const directory = join(root, "deployments/vnext", network);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "CANONICAL.json"), JSON.stringify(record));
  process.env.PCC_VNEXT_RECORD_NETWORK = network;
  return configuredVNextChainId(root);
}

// Vitest 1's stubEnv assigns undefined through process.env on some Node versions.
function setEnv(name: string, value: string | undefined): void {
  vi.stubEnv(name, value ?? "");
  if (value === undefined) delete process.env[name];
}

beforeEach(() => {
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args); });
  setEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", "1");
  setEnv("PCC_VNEXT_RECORD_NETWORK", "base");
  setEnv("PCC_VNEXT_RECORD_LABEL", undefined);
  __setPaidScopeActivationTermsForTest(null);
});

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("configured V-next record guards", () => {
  it.each([
    ["R-a", { specVersion: 1 }],
    ["R-b", { scheduleTestnetOnly: "false" }],
    ["R-b", { scheduleTestnetOnly: true }],
    ["R-d", { factory: "0xprivate-record-content" }],
  ] as const)("refuses %s once with only its fixed code", (rule, change) => {
    expect(resolve({ ...mainnetRecord(), ...change, secret: "private-record-content" }, "base")).toBeNull();
    expect(warnings).toEqual([[`vnext_record_refused ${rule}`]]);
  });

  it("R-c refuses once with only its fixed code", () => {
    setEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", "private-env-value");
    expect(resolve(committed)).toBeNull();
    expect(warnings).toEqual([["vnext_record_refused R-c"]]);
  });

  it.each([undefined, "", "true", " 1", "1 ", "01", "yes"])("R-c refuses the non-exact opt-in %j", (flag) => {
    setEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", flag);
    expect(resolve(committed)).toBeNull();
    expect(warnings).toEqual([["vnext_record_refused R-c"]]);
  });

  it.each([undefined, "production", "development", "test"])("R-c applies independently of NODE_ENV=%j", (nodeEnv) => {
    setEnv("NODE_ENV", nodeEnv);
    setEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", undefined);
    expect(resolve(committed)).toBeNull();
    expect(warnings).toEqual([["vnext_record_refused R-c"]]);
    warnings.length = 0;
    setEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", "1");
    expect(resolve(committed)).toBe(84532);
    expect(warnings).toEqual([]);
  });

  it("resolves a schema-conforming mainnet record without the testnet opt-in", () => {
    setEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", undefined);
    expect(resolve(mainnetRecord())).toBe(8453);
    expect(warnings).toEqual([]);
  });

  it("the committed base-sepolia record passes R-a, R-b and R-d only when R-c opts in", () => {
    process.env.PCC_VNEXT_RECORD_NETWORK = "base-sepolia";
    expect(configuredVNextChainId(contractsRoot)).toBe(84532);
    expect(paidScopeActivationTerms({ id: "scope", jobId: null, kernelId: "kernel" })).toEqual({
      expectedChainId: 84532,
      postActivationTtlMs: null,
      testnetOnly: true,
    });
    expect(warnings).toEqual([]);
    setEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", undefined);
    expect(configuredVNextChainId(contractsRoot)).toBeNull();
    expect(warnings).toEqual([["vnext_record_refused R-c"]]);
  });

  it("also permits an opted-in testnet-only anvil record", () => {
    expect(resolve({ ...committed, chainId: 31337 })).toBe(31337);
    expect(warnings).toEqual([]);
  });
});

interface NearMiss {
  field: string;
  constraint: string;
  value?: unknown;
  missing?: boolean;
}

const nearMisses: NearMiss[] = [];
for (const field of READ_FIELDS) {
  const rule = schema.properties[field]!;
  if (schema.required.includes(field)) nearMisses.push({ field, constraint: "required", missing: true });
  nearMisses.push({ field, constraint: "type", value: rule.type === "string" ? 42 : "wrong-type" });
  if (Object.hasOwn(rule, "const")) {
    nearMisses.push({ field, constraint: "const", value: typeof rule.const === "boolean" ? !rule.const : typeof rule.const === "number" ? rule.const + 1 : `${rule.const}x` });
  }
  if (rule.enum) nearMisses.push({ field, constraint: "enum", value: `${rule.enum[0]}-unknown` });
  if (rule.pattern) {
    const valid = String(committed[field]);
    const bad = `${valid.slice(0, -1)}g`;
    if (new RegExp(rule.pattern).test(bad)) throw new Error(`Near-miss does not violate ${field}'s schema pattern`);
    nearMisses.push({ field, constraint: "pattern", value: bad });
  }
  if (rule.minLength !== undefined) nearMisses.push({ field, constraint: "minLength", value: String(committed[field]).slice(0, rule.minLength - 1) });
  if (rule.maxLength !== undefined) nearMisses.push({ field, constraint: "maxLength", value: String(committed[field]) + "0".repeat(rule.maxLength + 1 - String(committed[field]).length) });
  if (rule.minimum !== undefined) nearMisses.push({ field, constraint: "minimum", value: rule.minimum - 1 });
  if (rule.maximum !== undefined) nearMisses.push({ field, constraint: "maximum", value: rule.maximum + 1 });
  if (rule.type === "integer") nearMisses.push({ field, constraint: "integer", value: 1.5 });
}

describe("hand-written reader / CANONICAL.schema.json structural agreement", () => {
  it("pins all gateway-read fields as schema-required", () => {
    expect(READ_FIELDS.every((field) => schema.required.includes(field))).toBe(true);
    expect(new Set(nearMisses.map((test) => test.constraint))).toEqual(new Set([
      "required", "type", "const", "enum", "pattern", "minLength", "maxLength", "minimum", "maximum", "integer",
    ]));
  });

  it.each(nearMisses)("refuses $field violating schema $constraint", ({ field, value, missing }) => {
    const record = mainnetRecord();
    if (missing) delete record[field];
    else record[field] = value;
    // Keep the path stable so a bad chainId is killed by the field guard itself.
    expect(resolve(record, "base")).toBeNull();
    const rule = field === "specVersion" ? "R-a" : field === "scheduleTestnetOnly" ? "R-b" : "R-d";
    expect(warnings).toEqual([[`vnext_record_refused ${rule}`]]);
  });

  it.each(schema.oneOf)("refuses a scheduleId / scheduleTestnetOnly pair outside the schema branch %#", ({ properties }) => {
    const record = { ...committed, chainId: 84532 };
    record.scheduleId = properties.scheduleId!.const;
    record.scheduleTestnetOnly = !properties.scheduleTestnetOnly!.const;
    expect(resolve(record)).toBeNull();
    expect(warnings).toEqual([["vnext_record_refused R-d"]]);
  });

  it("accepts the address schema's uppercase hex and numeric min/max boundaries", () => {
    const record = mainnetRecord();
    for (const field of READ_FIELDS) {
      const rule = schema.properties[field]!;
      if (rule.pattern) record[field] = `0x${String(record[field]).slice(2).toUpperCase()}`;
    }
    expect(resolve(record)).toBe(8453);
    for (const field of ["chainId", "blockNumber"]) {
      const rule = schema.properties[field]!;
      for (const value of [rule.minimum!, rule.maximum!]) {
        const boundaryRecord = { ...record, [field]: value };
        expect(resolve(boundaryRecord), `${field}=${value}`).toBe(boundaryRecord.chainId);
      }
    }
    expect(warnings).toEqual([]);
  });
});
