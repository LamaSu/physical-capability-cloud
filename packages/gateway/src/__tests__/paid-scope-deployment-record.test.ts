/**
 * Pins NS-1 (N145; #10008 INFO-3 and INFO-4; README:37): one validated deployment record.
 * Negatives are tagged (neg-...) for the mutation runner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  __setPaidScopeActivationTermsForTest,
  configuredVNextChainId,
  configuredVNextDeploymentRecord,
  paidScopeActivationTerms,
  vnextDeploymentRecord,
  vnextRecordChainId,
} from "../services/paid-scope-activation-terms.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync), readFileSync: vi.fn(actual.readFileSync) };
});

interface CanonicalSchema {
  oneOf: Array<{ properties: Record<string, { const: unknown }> }>;
  allOf: Array<{ then: { properties: { chainId: { enum: number[] } } } }>;
}

const contractsRoot = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const schema = JSON.parse(readFileSync(join(contractsRoot, "deployments/vnext/CANONICAL.schema.json"), "utf8")) as CanonicalSchema;
const committedBytes = readFileSync(join(contractsRoot, "deployments/vnext/base-sepolia/CANONICAL.json"));
const committed = JSON.parse(committedBytes.toString("utf8")) as Record<string, unknown>;
const ids = schema.oneOf.map(({ properties }) => properties.scheduleId!.const as string);
const windows = [
  "challengeWindowSec", "appealWindowSec", "backupWindowSec", "emergencyReviewWindowSec", "minReclaimDelaySec", "maxReclaimDelaySec",
] as const;
const scope = { id: "scope", jobId: null, kernelId: "kernel" };
const dirs: string[] = [];
let warnings: unknown[][];
let warnSpy: { mockRestore(): void };

function schemaTuple(id: string): Record<string, unknown> {
  const branch = schema.oneOf.find(({ properties }) => properties.scheduleId!.const === id)!;
  return Object.fromEntries(Object.entries(branch.properties).map(([key, rule]) => [key, rule.const]));
}

function onChain84532(id: string): Record<string, unknown> {
  return { ...committed, ...schemaTuple(id), chainId: 84532 };
}

function writeRecord(network: string, content: Buffer | Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "ns1-vnext-record-"));
  dirs.push(root);
  const directory = join(root, "deployments/vnext", network);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "CANONICAL.json"), Buffer.isBuffer(content) ? content : JSON.stringify(content));
  return root;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Vitest 1's stubEnv assigns undefined through process.env on some Node versions.
function setEnv(name: string, value: string | undefined): void {
  vi.stubEnv(name, value ?? "");
  if (value === undefined) delete process.env[name];
}

function clearReads(): void {
  vi.mocked(openSync).mockClear();
  vi.mocked(readFileSync).mockClear();
}

function expectReads(count: number): void {
  const suffix = join("vnext", "base-sepolia", "CANONICAL.json");
  expect(vi.mocked(openSync).mock.calls.filter(([path]) => String(path).endsWith(suffix))).toHaveLength(count);
  expect(vi.mocked(readFileSync).mock.calls).toHaveLength(count);
}

beforeEach(() => {
  warnings = [];
  warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args); });
  setEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", "1");
  setEnv("PCC_VNEXT_RECORD_NETWORK", "base-sepolia");
  setEnv("PCC_VNEXT_RECORD_LABEL", undefined);
  __setPaidScopeActivationTermsForTest(null);
  clearReads();
});

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  warnSpy.mockRestore();
  clearReads();
});

describe("NS-1 validated V-next deployment record", () => {
  it("A1 the committed record resolves: every field is the file's, and recordSha256 is the sha256 of its bytes", () => {
    const expected = {
      chainId: committed.chainId,
      factory: (committed.factory as string).toLowerCase(),
      implementation: (committed.implementation as string).toLowerCase(),
      usdc: (committed.usdc as string).toLowerCase(),
      ...Object.fromEntries(["scheduleId", "scheduleTestnetOnly", ...windows].map((key) => [key, committed[key]])),
      recordSha256: sha256(committedBytes),
    };
    const record = configuredVNextDeploymentRecord(contractsRoot);
    expect(record).toStrictEqual(expected);
    expect(record!.recordSha256).toMatch(/^[0-9a-f]{64}$/);
    for (const key of ["factory", "implementation", "usdc"] as const) expect(record![key]).toMatch(/^0x[0-9a-f]{40}$/);
    expect(configuredVNextDeploymentRecord()).toStrictEqual(expected);
    expect(warnings).toEqual([]);
  });

  it("A2 every reader agrees on the committed record", () => {
    const record = configuredVNextDeploymentRecord(contractsRoot)!;
    expect(vnextDeploymentRecord(contractsRoot, "base-sepolia")).toStrictEqual(record);
    expect(vnextRecordChainId(contractsRoot, "base-sepolia")).toBe(record.chainId);
    expect(configuredVNextChainId(contractsRoot)).toBe(record.chainId);
    expect(paidScopeActivationTerms(scope)).toEqual({
      expectedChainId: record.chainId, postActivationTtlMs: null, testnetOnly: record.scheduleTestnetOnly,
    });
    expect(warnings).toEqual([]);
  });

  it.each(ids)("T0 the %s tuple on chain 84532 resolves with no warning", (id) => {
    expect(configuredVNextChainId(writeRecord("base-sepolia", onChain84532(id)))).toBe(84532);
    expect(warnings).toEqual([]);
  });

  it.each(ids.flatMap((id) => windows.flatMap((key) => [1, -1].map((delta) => ({ id, key, delta })))))
  ("T1 (neg-tuple-window) $id $key $delta is refused R-d", ({ id, key, delta }) => {
    const record = onChain84532(id);
    record[key] = (record[key] as number) + delta;
    expect(configuredVNextChainId(writeRecord("base-sepolia", record))).toBeNull();
    expect(warnings).toEqual([["vnext_record_refused R-d"]]);
  });

  it.each(ids)("T2 (neg-tuple-flag) %s with scheduleTestnetOnly flipped is refused R-d", (id) => {
    const record = onChain84532(id);
    record.scheduleTestnetOnly = !record.scheduleTestnetOnly;
    expect(configuredVNextChainId(writeRecord("base-sepolia", record))).toBeNull();
    expect(warnings).toEqual([["vnext_record_refused R-d"]]);
  });

  it.each(ids.flatMap((id) => [ids.find((other) => other !== id)!, `${id}-unknown`].map((other) => ({ id, other }))))
  ("T3 (neg-tuple-id) $id with scheduleId set to $other is refused R-d", ({ id, other }) => {
    expect(configuredVNextChainId(writeRecord("base-sepolia", { ...onChain84532(id), scheduleId: other }))).toBeNull();
    expect(warnings).toEqual([["vnext_record_refused R-d"]]);
  });

  it.each(ids)("T4 (neg-tuple-swap) the other tuple's scheduleId and scheduleTestnetOnly over %s's windows is refused R-d", (id) => {
    const other = schemaTuple(ids.find((candidate) => candidate !== id)!);
    const record = { ...onChain84532(id), scheduleId: other.scheduleId, scheduleTestnetOnly: other.scheduleTestnetOnly };
    expect(configuredVNextChainId(writeRecord("base-sepolia", record))).toBeNull();
    expect(warnings).toEqual([["vnext_record_refused R-d"]]);
  });

  it("T5 (neg-tuple-mainnet-claim) a record claiming the mainnet schedule over the testnet windows is refused, even without the testnet opt-in", () => {
    setEnv("PCC_VNEXT_ALLOW_TESTNET_RECORD", undefined);
    setEnv("PCC_VNEXT_RECORD_NETWORK", "base");
    const record = { ...committed, chainId: 8453, scheduleId: "vnext-mainnet-v1", scheduleTestnetOnly: false };
    expect(configuredVNextChainId(writeRecord("base", record))).toBeNull();
    expect(warnings).toEqual([["vnext_record_refused R-d"]]);
  });

  it.each(ids.flatMap((id) => windows.map((key) => ({ id, key }))))
  ("T6 (neg-tuple-type) $id $key as its decimal string is refused R-d", ({ id, key }) => {
    const record = onChain84532(id);
    record[key] = String(record[key]);
    expect(configuredVNextChainId(writeRecord("base-sepolia", record))).toBeNull();
    expect(warnings).toEqual([["vnext_record_refused R-d"]]);
  });

  it("T7 (neg-tuple-record) both whole-record readers refuse a near-miss R-d", () => {
    const record = onChain84532("vnext-testnet-short-v1");
    record.challengeWindowSec = (record.challengeWindowSec as number) + 1;
    const root = writeRecord("base-sepolia", record);
    expect(configuredVNextDeploymentRecord(root)).toBeNull();
    expect(warnings).toEqual([["vnext_record_refused R-d"]]);
    warnings = [];
    expect(vnextDeploymentRecord(root, "base-sepolia")).toBeNull();
    expect(warnings).toEqual([["vnext_record_refused R-d"]]);
  });

  const provisional = { mode: "PROVISIONAL", label: "run1", canonical: false, doNotPin: true };
  it.each([
    { name: "PROVISIONAL", change: provisional },
    { name: "DRYRUN canonical", change: { broadcast: false } },
    { name: "DRYRUN provisional", change: { ...provisional, broadcast: false } },
    { name: "doNotPin alone", change: { doNotPin: true } },
  ])("W1 (neg-record-writer-shapes) $name on the committed record is refused R-d", ({ change }) => {
    expect(configuredVNextChainId(writeRecord("base-sepolia", { ...committed, ...change }))).toBeNull();
    expect(warnings).toEqual([["vnext_record_refused R-d"]]);
  });

  it("H1 (neg-sha-bytes) one extra trailing newline still resolves, with a different sha256", () => {
    const bytesB = Buffer.concat([committedBytes, Buffer.from("\n")]);
    const a = configuredVNextDeploymentRecord(writeRecord("base-sepolia", committedBytes))!;
    const b = configuredVNextDeploymentRecord(writeRecord("base-sepolia", bytesB))!;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a.recordSha256).toBe(sha256(committedBytes));
    expect(b.recordSha256).toBe(sha256(bytesB));
    expect(b.recordSha256).not.toBe(a.recordSha256);
    expect({ ...b, recordSha256: a.recordSha256 }).toStrictEqual(a);
    expect(warnings).toEqual([]);
  });

  it.each([
    "configuredVNextDeploymentRecord", "configuredVNextChainId", "vnextDeploymentRecord", "vnextRecordChainId",
    "paidScopeActivationTerms", "configuredVNextChainId near-miss",
  ])("R1 (neg-read-once) %s opens and reads the record once", (call) => {
    const content = call.endsWith("near-miss")
      ? { ...onChain84532("vnext-testnet-short-v1"), challengeWindowSec: 601 } : committedBytes;
    const root = writeRecord("base-sepolia", content);
    const invoke = () => {
      switch (call) {
        case "configuredVNextDeploymentRecord": return configuredVNextDeploymentRecord(root);
        case "vnextDeploymentRecord": return vnextDeploymentRecord(root, "base-sepolia");
        case "vnextRecordChainId": return vnextRecordChainId(root, "base-sepolia");
        case "paidScopeActivationTerms": return paidScopeActivationTerms(scope);
        default: return configuredVNextChainId(root);
      }
    };
    clearReads();
    invoke();
    expectReads(1);
    if (call === "configuredVNextDeploymentRecord" || call === "paidScopeActivationTerms") {
      invoke();
      expectReads(2);
    }
  });

  it("R2 (neg-no-cache) a rewritten record is read afresh", () => {
    const root = writeRecord("base-sepolia", onChain84532("vnext-testnet-short-v1"));
    const first = configuredVNextDeploymentRecord(root)!;
    const next = onChain84532("vnext-mainnet-v1");
    const bytes = Buffer.from(JSON.stringify(next));
    writeFileSync(join(root, "deployments/vnext/base-sepolia/CANONICAL.json"), bytes);
    const second = configuredVNextDeploymentRecord(root)!;
    expect(second).toStrictEqual({ ...first, ...schemaTuple("vnext-mainnet-v1"), recordSha256: sha256(bytes) });
    expect(second.recordSha256).not.toBe(first.recordSha256);
    expect(warnings).toEqual([]);
  });
});
