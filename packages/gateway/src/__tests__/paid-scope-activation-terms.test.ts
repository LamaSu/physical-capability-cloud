/**
 * Buyer funding Stage 2: where reconcilePaidScope's two required inputs come from (the steward's
 * rulings 4 and 5; reviewer-hotel's wiring, fund-s2-r2-review.md section 6).
 *   - vnextRecordChainId reads the ONE pinned V-next deployment record and fails closed (null) on
 *     anything missing, unreadable or inconsistent: symlinks, a dry run's tuple, another mode or
 *     label, a chain id that is not a positive safe integer or not the chain of its directory.
 *   - The configured resolver has no default; with no committed record it is null.
 *   - The S1.1 TTL seam is null today.
 *   - A test-installed source is honoured in a test process only.
 * Negatives are tagged (neg-...) for the mutation runner.
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** A record as DeployVNextSettlement.s.sol's _writeArtifact writes it for a broadcast PROVISIONAL run (the fields read here). */
const recordJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    canonical: false,
    doNotPin: true,
    mode: "PROVISIONAL",
    label: "run1",
    broadcast: true,
    factory: "0x" + "f1".repeat(20),
    implementation: "0x" + "f2".repeat(20),
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    chainId: 84532,
    specVersion: 1,
    blockNumber: 123,
    ...over,
  });

/** A fresh package root holding deployments/vnext/<network>/<file> with `body`. */
function packageRoot(network = "base-sepolia", file = "PROVISIONAL-run1.json", body = recordJson()): string {
  const root = mkdtempSync(join(tmpdir(), "fund-s2-vnext-record-"));
  dirs.push(root);
  mkdirSync(join(root, "deployments", "vnext", network), { recursive: true });
  writeFileSync(join(root, "deployments", "vnext", network, file), body);
  return root;
}

describe("vnextRecordChainId: the pinned V-next deployment record (ruling 4)", () => {
  it("reads the chain id of a broadcast PROVISIONAL record with this label, in its chain's directory", () => {
    expect(vnextRecordChainId(packageRoot(), "base-sepolia", "run1")).toBe(84532);
    const anvil = packageRoot("anvil", "PROVISIONAL-local_2.json", recordJson({ chainId: 31337, label: "local_2" }));
    expect(vnextRecordChainId(anvil, "anvil", "local_2")).toBe(31337);
    const other = packageRoot("chain-545", "PROVISIONAL-run1.json", recordJson({ chainId: 545 }));
    expect(vnextRecordChainId(other, "chain-545", "run1")).toBe(545);
    const sepolia = packageRoot("chain-11155111", "PROVISIONAL-run1.json", recordJson({ chainId: 11155111 }));
    expect(vnextRecordChainId(sepolia, "chain-11155111", "run1")).toBe(11155111);
  });

  it("networkSlug is VNextDeploySpec.networkSlug's", () => {
    expect([8453, 84532, 31337, 545, 11155111].map(vnextNetworkSlug)).toEqual(["base", "base-sepolia", "anvil", "chain-545", "chain-11155111"]);
  });

  it("(neg-record-missing) no record, no directory, or an unreadable one: null", () => {
    const root = packageRoot();
    expect(vnextRecordChainId(root, "base-sepolia", "run2")).toBeNull(); // another label: no such file
    expect(vnextRecordChainId(root, "base", "run1")).toBeNull(); // no such directory
    expect(vnextRecordChainId(join(root, "nowhere"), "base-sepolia", "run1")).toBeNull();
    for (const body of ["", "{", "null", "[]", "42", '"x"']) {
      expect(vnextRecordChainId(packageRoot("base-sepolia", "PROVISIONAL-run1.json", body), "base-sepolia", "run1"), body).toBeNull();
    }
  });

  it("(neg-record-dryrun) a dry run's tuple is never the record: its DRYRUN- file is not read, and one at the record's name is refused", () => {
    const dry = recordJson({ broadcast: false });
    expect(vnextRecordChainId(packageRoot("base-sepolia", "DRYRUN-PROVISIONAL-run1.json", dry), "base-sepolia", "run1")).toBeNull();
    expect(vnextRecordChainId(packageRoot("base-sepolia", "PROVISIONAL-run1.json", dry), "base-sepolia", "run1")).toBeNull();
    for (const broadcast of [undefined, "true", 1]) {
      expect(vnextRecordChainId(packageRoot("base-sepolia", "PROVISIONAL-run1.json", recordJson({ broadcast })), "base-sepolia", "run1")).toBeNull();
    }
  });

  it("(neg-record-mode) another mode or label in the record: null", () => {
    for (const over of [{ mode: "CANONICAL" }, { mode: "provisional" }, { label: "run2" }, { label: undefined }]) {
      expect(vnextRecordChainId(packageRoot("base-sepolia", "PROVISIONAL-run1.json", recordJson(over)), "base-sepolia", "run1"), JSON.stringify(over)).toBeNull();
    }
  });

  it("(neg-record-chain) a chain id that is not a positive safe integer, or not its directory's chain: null", () => {
    for (const chainId of [0, -1, 1.5, "84532", null, undefined, 2 ** 53, 1e21]) {
      const root = packageRoot("base-sepolia", "PROVISIONAL-run1.json", recordJson({ chainId }));
      expect(vnextRecordChainId(root, "base-sepolia", "run1"), String(chainId)).toBeNull();
    }
    // A chain id past a safe integer, in the very directory its slug names: still null.
    const big = 2 ** 53;
    expect(vnextRecordChainId(packageRoot(`chain-${big}`, "PROVISIONAL-run1.json", recordJson({ chainId: big })), `chain-${big}`, "run1")).toBeNull();
    // Base Sepolia's record under base/ (or the other way round) is in the wrong place.
    expect(vnextRecordChainId(packageRoot("base", "PROVISIONAL-run1.json", recordJson()), "base", "run1")).toBeNull();
    expect(vnextRecordChainId(packageRoot("base-sepolia", "PROVISIONAL-run1.json", recordJson({ chainId: 8453 })), "base-sepolia", "run1")).toBeNull();
  });

  it("(neg-record-config) a network or label that is not a slug never forms a path: null", () => {
    const root = packageRoot();
    for (const [network, label] of [
      ["../vnext/base-sepolia", "run1"],
      ["base-sepolia/", "run1"],
      ["Base-Sepolia", "run1"],
      ["", "run1"],
      ["base-sepolia", ""],
      ["base-sepolia", "run1/../run1"],
      ["base-sepolia", "a".repeat(65)],
      ["base-sepolia", "run 1"],
    ]) {
      expect(vnextRecordChainId(root, network, label), `${network} ${label}`).toBeNull();
    }
    // Only the slug check refuses this one (r3 review NIT-2): the label "x/../run1" would form the path
    // <network>/run1.json, and a record there carrying that very label passes every later check.
    const traversed = packageRoot("base-sepolia", "run1.json", recordJson({ label: "x/../run1" }));
    expect(vnextRecordChainId(traversed, "base-sepolia", "x/../run1")).toBeNull();
  });

  it("(neg-record-symlink) a symlink at the record or any directory on its path: null", () => {
    // The record itself a link to a valid record elsewhere.
    const elsewhere = packageRoot();
    const linkedFile = packageRoot("base-sepolia", "unrelated.json", "{}");
    symlinkSync(join(elsewhere, "deployments", "vnext", "base-sepolia", "PROVISIONAL-run1.json"), join(linkedFile, "deployments", "vnext", "base-sepolia", "PROVISIONAL-run1.json"));
    expect(vnextRecordChainId(linkedFile, "base-sepolia", "run1")).toBeNull();
    // The network directory, vnext, and deployments, each a link to a valid tree.
    for (const at of [["deployments", "vnext", "base-sepolia"], ["deployments", "vnext"], ["deployments"]]) {
      const root = mkdtempSync(join(tmpdir(), "fund-s2-vnext-link-"));
      dirs.push(root);
      mkdirSync(join(root, ...at.slice(0, -1)), { recursive: true });
      symlinkSync(join(elsewhere, ...at), join(root, ...at));
      expect(vnextRecordChainId(root, "base-sepolia", "run1"), at.join("/")).toBeNull();
    }
    // The control: the tree the links point at reads.
    expect(vnextRecordChainId(elsewhere, "base-sepolia", "run1")).toBe(84532);
  });
});

describe("the record is read only from a regular file (r3 review NIT-1)", () => {
  it.skipIf(process.platform === "win32")("(neg-record-fifo) a FIFO at the record's path is refused without being opened: null at once, never a block", () => {
    const root = packageRoot("base-sepolia", "unrelated.json", "{}");
    const fifo = join(root, "deployments", "vnext", "base-sepolia", "PROVISIONAL-run1.json");
    execFileSync("mkfifo", [fifo]);
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
      expect(vnextRecordChainId(root, "base-sepolia", "run1")).toBeNull();
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

  it("(neg-config-default) the chain has no default: unset config is null, and so is config naming a record nobody committed", () => {
    for (const k of ENV) delete process.env[k];
    expect(configuredVNextChainId()).toBeNull();
    process.env.PCC_VNEXT_RECORD_NETWORK = "base-sepolia";
    expect(configuredVNextChainId()).toBeNull(); // no label
    process.env.PCC_VNEXT_RECORD_LABEL = "run1";
    expect(configuredVNextChainId()).toBeNull(); // deployments/vnext holds only its README
    // The control: it looks in the real @pcc/contracts package, whose deployments/vnext holds only the README.
    // (Compared by realpath: after an lstat of a FIFO, as neg-record-fifo does, Node's require.resolve
    // can return the package's node_modules link instead; the package reached is the same.)
    const root = contractsPackageRoot();
    expect(realpathSync.native(root!)).toMatch(/[/\\]packages[/\\]contracts$/);
    expect(existsSync(join(root!, "deployments", "vnext", "README.md"))).toBe(true);
    expect(readdirSync(join(root!, "deployments", "vnext"))).toEqual(["README.md"]);
  });

  it("(neg-ttl-default) the TTL comes from S1.1's prepared terms, which do not exist yet: null", () => {
    expect(preparedActivationTtlMs({ id: "scope_x", jobId: "job_x", kernelId: "kernel-nyc" })).toBeNull();
  });

  it("(neg-terms-default) with no source installed, a test process gets neither value", () => {
    for (const k of ENV) delete process.env[k];
    expect(paidScopeActivationTerms({ id: "scope_x", jobId: "job_x", kernelId: "kernel-nyc" })).toEqual({
      expectedChainId: null,
      postActivationTtlMs: null,
    });
  });
});

describe("a test-installed source", () => {
  afterEach(() => {
    process.env.NODE_ENV = "test";
    __setPaidScopeActivationTermsForTest(null);
  });

  it("is what a test process gets, per scope", () => {
    __setPaidScopeActivationTermsForTest((scope) => ({ expectedChainId: 84532, postActivationTtlMs: scope.id === "scope_a" ? 1000 : 2000 }));
    expect(paidScopeActivationTerms({ id: "scope_a", jobId: null, kernelId: "k" })).toEqual({ expectedChainId: 84532, postActivationTtlMs: 1000 });
    expect(paidScopeActivationTerms({ id: "scope_b", jobId: null, kernelId: "k" })).toEqual({ expectedChainId: 84532, postActivationTtlMs: 2000 });
  });

  it("(neg-terms-prod) is never consulted outside a test process (production, development, NODE_ENV unset, or no VITEST), and cannot be installed there", () => {
    __setPaidScopeActivationTermsForTest(() => ({ expectedChainId: 84532, postActivationTtlMs: 1000 }));
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
        expect(paidScopeActivationTerms({ id: "scope_a", jobId: null, kernelId: "k" }), label).toEqual({ expectedChainId: null, postActivationTtlMs: null });
        expect(() => __setPaidScopeActivationTermsForTest(null), label).toThrow();
      }
    } finally {
      set("NODE_ENV", saved.NODE_ENV);
      set("VITEST", saved.VITEST);
      set("PCC_VNEXT_RECORD_NETWORK", saved.NET);
      set("PCC_VNEXT_RECORD_LABEL", saved.LABEL);
    }
    expect(paidScopeActivationTerms({ id: "scope_a", jobId: null, kernelId: "k" })).toEqual({ expectedChainId: 84532, postActivationTtlMs: 1000 });
  });
});
