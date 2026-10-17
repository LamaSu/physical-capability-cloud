/**
 * Buyer funding Stage 2: where reconcilePaidScope's two required inputs come from (the steward's
 * rulings 4 and 5; reviewer-hotel's wiring, fund-s2-r2-review.md section 6).
 *   - vnextRecordChainId reads the ONE pinned V-next deployment record and fails closed (null) on
 *     anything missing, unreadable or inconsistent: symlinks, provisional or dry-run tuples, unapproved pinning flags or
 *     a non-empty label, a chain id that is not a positive safe integer or not the chain of its directory.
 *   - The configured resolver has no default; with no committed record it is null.
 *   - The S1.1 TTL seam is null today.
 *   - A test-installed source is honoured in a test process only.
 * Negatives are tagged (neg-...) for the mutation runner.
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setPaidScopeActivationTermsForTest,
  configuredVNextChainId,
  contractsPackageRoot,
  paidScopeActivationTerms,
  preparedActivationTtlMs,
  vnextNetworkSlug,
  vnextRecordChainId,
} from "../services/paid-scope-activation-terms.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A record as DeployVNextSettlement.s.sol's _writeArtifact writes it for a broadcast CANONICAL run (the fields read here). */
const recordJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    canonical: true,
    doNotPin: false,
    mode: "CANONICAL",
    label: "",
    broadcast: true,
    factory: "0x" + "f1".repeat(20),
    implementation: "0x" + "f2".repeat(20),
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    chainId: 84532,
    specVersion: 2,
    scheduleId: "vnext-mainnet-v1",
    scheduleTestnetOnly: false,
    blockNumber: 123,
    ...over,
  });

/** A fresh package root holding deployments/vnext/<network>/<file> with `body`. */
function packageRoot(network = "base-sepolia", file = "CANONICAL.json", body = recordJson()): string {
  const root = mkdtempSync(join(tmpdir(), "fund-s2-vnext-record-"));
  dirs.push(root);
  mkdirSync(join(root, "deployments", "vnext", network), { recursive: true });
  writeFileSync(join(root, "deployments", "vnext", network, file), body);
  return root;
}

describe("vnextRecordChainId: the pinned V-next deployment record (ruling 4)", () => {
  it("reads CANONICAL.json from a broadcast canonical run in its chain's directory", () => {
    expect(vnextRecordChainId(packageRoot(), "base-sepolia")).toBe(84532);
    const anvil = packageRoot("anvil", "CANONICAL.json", recordJson({ chainId: 31337 }));
    expect(vnextRecordChainId(anvil, "anvil")).toBe(31337);
    const other = packageRoot("chain-545", "CANONICAL.json", recordJson({ chainId: 545 }));
    expect(vnextRecordChainId(other, "chain-545")).toBe(545);
    const sepolia = packageRoot("chain-11155111", "CANONICAL.json", recordJson({ chainId: 11155111 }));
    expect(vnextRecordChainId(sepolia, "chain-11155111")).toBe(11155111);
  });

  it("networkSlug is VNextDeploySpec.networkSlug's", () => {
    expect([8453, 84532, 31337, 545, 11155111].map(vnextNetworkSlug)).toEqual(["base", "base-sepolia", "anvil", "chain-545", "chain-11155111"]);
  });

  it("(neg-record-missing) no canonical record, no directory, or malformed JSON: null", () => {
    const root = packageRoot("base-sepolia", "unrelated.json");
    expect(vnextRecordChainId(root, "base-sepolia")).toBeNull();
    expect(vnextRecordChainId(root, "base")).toBeNull(); // no such directory
    expect(vnextRecordChainId(join(root, "nowhere"), "base-sepolia")).toBeNull();
    for (const body of ["", "{", "null", "[]", "42", '"x"']) {
      expect(vnextRecordChainId(packageRoot("base-sepolia", "CANONICAL.json", body), "base-sepolia"), body).toBeNull();
    }
  });

  it("(neg-record-fallback) provisional and dry-run filenames are never selected when CANONICAL.json is missing", () => {
    for (const file of ["PROVISIONAL-run1.json", "DRYRUN-PROVISIONAL-run1.json", "DRYRUN-CANONICAL.json"]) {
      // A valid canonical body isolates filename selection from the field checks below.
      expect(vnextRecordChainId(packageRoot("base-sepolia", file), "base-sepolia"), file).toBeNull();
    }
  });

  it("(neg-record-provisional) mode PROVISIONAL at the canonical path is refused", () => {
    expect(vnextRecordChainId(packageRoot("base-sepolia", "CANONICAL.json", recordJson({ mode: "PROVISIONAL" })), "base-sepolia")).toBeNull();
  });

  it("(neg-record-do-not-pin) doNotPin true at the canonical path is refused", () => {
    expect(vnextRecordChainId(packageRoot("base-sepolia", "CANONICAL.json", recordJson({ doNotPin: true })), "base-sepolia")).toBeNull();
  });

  it("(neg-record-dryrun) broadcast false at the canonical path is refused", () => {
    expect(vnextRecordChainId(packageRoot("base-sepolia", "CANONICAL.json", recordJson({ broadcast: false })), "base-sepolia")).toBeNull();
  });

  it("(neg-record-noncanonical) canonical false at the canonical path is refused", () => {
    expect(vnextRecordChainId(packageRoot("base-sepolia", "CANONICAL.json", recordJson({ canonical: false })), "base-sepolia")).toBeNull();
  });

  it("(neg-record-label) a non-empty label at the canonical path is refused", () => {
    expect(vnextRecordChainId(packageRoot("base-sepolia", "CANONICAL.json", recordJson({ label: "run1" })), "base-sepolia")).toBeNull();
  });

  it("(neg-record-shape) canonical approval fields must have the writer's exact values and types", () => {
    for (const over of [
      { mode: "canonical" }, { mode: undefined },
      { label: undefined }, { label: null },
      { canonical: undefined }, { canonical: "true" }, { canonical: 1 },
      { doNotPin: undefined }, { doNotPin: "false" }, { doNotPin: 0 },
      { broadcast: undefined }, { broadcast: "true" }, { broadcast: 1 },
    ]) {
      expect(vnextRecordChainId(packageRoot("base-sepolia", "CANONICAL.json", recordJson(over)), "base-sepolia"), JSON.stringify(over)).toBeNull();
    }
  });

  it("(neg-record-chain) a chain id that is not a positive safe integer, or not its directory's chain: null", () => {
    for (const chainId of [0, -1, 1.5, "84532", null, undefined, 2 ** 53, 1e21]) {
      const root = packageRoot("base-sepolia", "CANONICAL.json", recordJson({ chainId }));
      expect(vnextRecordChainId(root, "base-sepolia"), String(chainId)).toBeNull();
    }
    // A chain id past a safe integer, in the very directory its slug names: still null.
    const big = 2 ** 53;
    expect(vnextRecordChainId(packageRoot(`chain-${big}`, "CANONICAL.json", recordJson({ chainId: big })), `chain-${big}`)).toBeNull();
    // Base Sepolia's record under base/ (or the other way round) is in the wrong place.
    expect(vnextRecordChainId(packageRoot("base", "CANONICAL.json", recordJson()), "base")).toBeNull();
    expect(vnextRecordChainId(packageRoot("base-sepolia", "CANONICAL.json", recordJson({ chainId: 8453 })), "base-sepolia")).toBeNull();
  });

  it("(neg-record-config) a network that is not a slug never forms a path: null", () => {
    const root = packageRoot();
    for (const network of ["../vnext/base-sepolia", "base-sepolia/", "Base-Sepolia", "", "chain-0", "chain-01"]) {
      expect(vnextRecordChainId(root, network), network).toBeNull();
    }
    // This traverses to the valid directory if the slug guard is removed.
    expect(vnextRecordChainId(root, "base-sepolia/../base-sepolia")).toBeNull();
  });

  it("(neg-record-symlink) a symlink at the record or any directory on its path: null", () => {
    // The record itself a link to a valid record elsewhere.
    const elsewhere = packageRoot();
    const linkedFile = packageRoot("base-sepolia", "unrelated.json", "{}");
    symlinkSync(join(elsewhere, "deployments", "vnext", "base-sepolia", "CANONICAL.json"), join(linkedFile, "deployments", "vnext", "base-sepolia", "CANONICAL.json"));
    expect(vnextRecordChainId(linkedFile, "base-sepolia")).toBeNull();
    // The network directory, vnext, and deployments, each a link to a valid tree.
    for (const at of [["deployments", "vnext", "base-sepolia"], ["deployments", "vnext"], ["deployments"]]) {
      const root = mkdtempSync(join(tmpdir(), "fund-s2-vnext-link-"));
      dirs.push(root);
      mkdirSync(join(root, ...at.slice(0, -1)), { recursive: true });
      symlinkSync(join(elsewhere, ...at), join(root, ...at));
      expect(vnextRecordChainId(root, "base-sepolia"), at.join("/")).toBeNull();
    }
    // The control: the tree the links point at reads.
    expect(vnextRecordChainId(elsewhere, "base-sepolia")).toBe(84532);
  });
});

describe("the record is read only from a regular file (r3 review NIT-1)", () => {
  it.skipIf(process.platform === "win32")("(neg-record-fifo) a FIFO at the record's path is refused without being opened: null at once, never a block", () => {
    const root = packageRoot("base-sepolia", "unrelated.json", "{}");
    const fifo = join(root, "deployments", "vnext", "base-sepolia", "CANONICAL.json");
    execFileSync("mkfifo", [fifo], { stdio: "ignore" });
    // The guard: opening a FIFO to read blocks until a writer opens it, and a synchronous open cannot be
    // timed out from this thread. So a separate process opens the write end after 3 s (non-blocking; it
    // gives up if no reader waits): a resolver that blocked is released then, the test cannot hang, and
    // the elapsed time shows the block.
    const helper = spawn(
      process.execPath,
      ["-e", `setTimeout(() => { const fs = require("node:fs"); try { fs.closeSync(fs.openSync(${JSON.stringify(fifo)}, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); } catch {} }, 3000)`],
      { stdio: "ignore" },
    );
    try {
      const started = Date.now();
      expect(vnextRecordChainId(root, "base-sepolia")).toBeNull();
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      helper.kill();
    }
  });
});

describe("the configured sources today", () => {
  const ENV = ["PCC_VNEXT_RECORD_NETWORK", "PCC_VNEXT_RECORD_LABEL"] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV) saved[k] = process.env[k];
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("(neg-config-default) the chain has no default: with no config it is null even where CANONICAL.json exists", () => {
    for (const k of ENV) delete process.env[k];
    const root = packageRoot();
    expect(configuredVNextChainId(root)).toBeNull();
    expect(configuredVNextChainId()).toBeNull(); // the real package, whatever records it holds
    // The explicit network selects CANONICAL.json in that directory.
    process.env.PCC_VNEXT_RECORD_NETWORK = "base-sepolia";
    expect(configuredVNextChainId(root)).toBe(84532);
    expect(configuredVNextChainId(null)).toBeNull(); // package unavailable
    process.env.PCC_VNEXT_RECORD_NETWORK = "base";
    expect(configuredVNextChainId(root)).toBeNull(); // no canonical record in this directory
    // By default it looks in the real @pcc/contracts package. Compared by realpath: after an lstat of a
    // FIFO, as neg-record-fifo does, Node's require.resolve can return the package's node_modules link
    // instead; the package reached is the same.
    const real = contractsPackageRoot();
    expect(realpathSync.native(real!)).toMatch(/[/\\]packages[/\\]contracts$/);
    expect(existsSync(join(real!, "deployments", "vnext", "README.md"))).toBe(true);
  });

  it("(neg-config-legacy-label) old label-style config is refused even with a valid canonical record", () => {
    const root = packageRoot();
    process.env.PCC_VNEXT_RECORD_NETWORK = "base-sepolia";
    for (const label of ["run1", "", "run1/../run1"]) {
      process.env.PCC_VNEXT_RECORD_LABEL = label;
      expect(configuredVNextChainId(root), label).toBeNull();
    }
    delete process.env.PCC_VNEXT_RECORD_NETWORK;
    expect(configuredVNextChainId(root)).toBeNull(); // a label alone cannot configure the chain
    delete process.env.PCC_VNEXT_RECORD_LABEL;
    process.env.PCC_VNEXT_RECORD_NETWORK = "base-sepolia";
    expect(configuredVNextChainId(root)).toBe(84532);
  });

  it("(neg-ttl-default) the TTL comes from S1.1's prepared terms, which do not exist yet: null", () => {
    expect(preparedActivationTtlMs({ id: "scope_x", jobId: "job_x", kernelId: "kernel-nyc" })).toBeNull();
  });

  it("(neg-terms-default) with no source installed, a test process gets neither value", () => {
    for (const k of ENV) delete process.env[k];
    expect(paidScopeActivationTerms({ id: "scope_x", jobId: "job_x", kernelId: "kernel-nyc" })).toEqual({
      expectedChainId: null,
      postActivationTtlMs: null,
      testnetOnly: false,
    });
  });
});

describe("a test-installed source", () => {
  afterEach(() => {
    process.env.NODE_ENV = "test";
    __setPaidScopeActivationTermsForTest(null);
  });

  it("is what a test process gets, per scope", () => {
    __setPaidScopeActivationTermsForTest((scope) => ({ expectedChainId: 84532, postActivationTtlMs: scope.id === "scope_a" ? 1000 : 2000, testnetOnly: false }));
    expect(paidScopeActivationTerms({ id: "scope_a", jobId: null, kernelId: "k" })).toEqual({ expectedChainId: 84532, postActivationTtlMs: 1000, testnetOnly: false });
    expect(paidScopeActivationTerms({ id: "scope_b", jobId: null, kernelId: "k" })).toEqual({ expectedChainId: 84532, postActivationTtlMs: 2000, testnetOnly: false });
  });

  it("(neg-terms-prod) is never consulted outside a test process (production, development, NODE_ENV unset, or no VITEST), and cannot be installed there", () => {
    __setPaidScopeActivationTermsForTest(() => ({ expectedChainId: 84532, postActivationTtlMs: 1000, testnetOnly: false }));
    const saved = { NODE_ENV: process.env.NODE_ENV, VITEST: process.env.VITEST, NET: process.env.PCC_VNEXT_RECORD_NETWORK, LABEL: process.env.PCC_VNEXT_RECORD_LABEL };
    const set = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    delete process.env.PCC_VNEXT_RECORD_NETWORK;
    delete process.env.PCC_VNEXT_RECORD_LABEL;
    try {
      // isTestProcess() needs NODE_ENV "test" AND VITEST "true" (r3 review NIT-3: both conditions).
      for (const [nodeEnv, vitest] of [["production", "true"], ["development", "true"], [undefined, "true"], ["test", undefined], ["test", "false"]] as const) {
        set("NODE_ENV", nodeEnv);
        set("VITEST", vitest);
        const label = `NODE_ENV=${nodeEnv} VITEST=${vitest}`;
        expect(paidScopeActivationTerms({ id: "scope_a", jobId: null, kernelId: "k" }), label).toEqual({ expectedChainId: null, postActivationTtlMs: null, testnetOnly: false });
        expect(() => __setPaidScopeActivationTermsForTest(null), label).toThrow();
      }
    } finally {
      set("NODE_ENV", saved.NODE_ENV);
      set("VITEST", saved.VITEST);
      set("PCC_VNEXT_RECORD_NETWORK", saved.NET);
      set("PCC_VNEXT_RECORD_LABEL", saved.LABEL);
    }
    expect(paidScopeActivationTerms({ id: "scope_a", jobId: null, kernelId: "k" })).toEqual({ expectedChainId: 84532, postActivationTtlMs: 1000, testnetOnly: false });
  });
});
