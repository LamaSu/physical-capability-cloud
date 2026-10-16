import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MachineAdapter } from "../adapters/types.js";
import { CLAUSES, type ConformanceProfile } from "../conformance/index.js";
import { describeAdapterConformance } from "../conformance/vitest.js";
import { FakeDevice } from "../testing/fake-device.js";

const devices = new WeakMap<MachineAdapter, FakeDevice>();
const makeAdapter = (): MachineAdapter => {
  const device = new FakeDevice("vitest-conformance-device", "vitest-conformance-kernel");
  devices.set(device, device);
  return device;
};

const profile: ConformanceProfile = {
  name: "honest FakeDevice through Vitest",
  kind: "physical",
  mode: "mock",
  bindingKey: "deviceJobId",
  declaredCommands: ["start", "stop", "status"],
  busy: "second-start",
  timing: {
    cancelConfirmMs: 20,
    pollMs: 2,
    jobTimeoutMs: 100,
    quiesceTimeoutMs: 50,
    settleMs: 5,
  },
  prepareStart: (adapter) => {
    devices.get(adapter)!.scriptStart({ outcome: "accept", deviceJobId: 41 });
  },
  startCommand: () => ({ type: "start" }),
  finish: (adapter) => { devices.get(adapter)!.complete(); },
};

describeAdapterConformance("describeAdapterConformance honest FakeDevice", makeAdapter, profile);

interface RegisteredTest {
  ancestorTitles: string[];
  title: string;
  status: "passed" | "failed";
  failureMessages: string[];
}

describe("describeAdapterConformance registration and expectations", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pcc-conformance-vitest-"));
  let registered: RegisteredTest[];
  let exitCode: number | null;

  afterAll(() => { rmSync(directory, { recursive: true, force: true }); });

  beforeAll(async () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const config = path.join(directory, "vitest.config.mjs");
    const report = path.join(directory, "report.json");
    // The fixture intentionally fails one real Vitest test. A separate process
    // observes registration and assertion behavior without mocking Vitest's API.
    // Config, cache and JSON output all stay in TMPDIR; the fixture is read-only.
    writeFileSync(config, `export default ${JSON.stringify({
      cacheDir: path.join(directory, "cache"),
      test: {
        include: ["src/__tests__/fixtures/conformance-vitest.fixture.ts"],
        cache: false,
        pool: "forks",
        poolOptions: { forks: { singleFork: true } },
      },
    })};\n`);
    const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      execFile(path.join(root, "node_modules/.bin/vitest"), [
        "run", "--root", root, "--config", config, "--reporter=json", "--outputFile", report,
      ], { cwd: directory, timeout: 12_000 }, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout, stderr });
      });
    });
    expect(output.code, output.stdout + output.stderr).not.toBeNull();
    exitCode = output.code;
    const results = JSON.parse(readFileSync(report, "utf8")) as {
      testResults: Array<{ assertionResults: RegisteredTest[] }>;
    };
    registered = results.testResults.flatMap((result) => result.assertionResults);
  }, 15_000);

  const suite = (name: string) => registered.filter((test) => test.ancestorTitles.includes(name));

  it("default expectations fail only C5 and preserve its reason", () => {
    expect(exitCode).toBe(1);
    const tests = suite("fault with default expectations");
    expect(tests.filter((test) => test.status === "failed").map((test) => test.title)).toEqual([
      "C5: Busy refusal",
    ]);
    expect(tests.filter((test) => test.status === "passed")).toHaveLength(9);
    expect(tests.find((test) => test.title === "C5: Busy refusal")?.failureMessages.join("\n"))
      .toContain("C5: Second start did not refuse with busy true.");
  });

  it("a pinned C5 failure expectation makes all ten registered tests pass", () => {
    const tests = suite("fault with pinned expectation");
    expect(tests).toHaveLength(10);
    expect(tests.map((test) => test.status)).toEqual(Array.from({ length: 10 }, () => "passed"));
  });

  it("registers exactly ten clause titles in contract order for each invocation", () => {
    const titles = CLAUSES.map((clause) => `${clause.id}: ${clause.title}`);
    expect(registered).toHaveLength(20);
    expect(suite("fault with default expectations").map((test) => test.title)).toEqual(titles);
    expect(suite("fault with pinned expectation").map((test) => test.title)).toEqual(titles);
  });
});
