import { describe, expect, it } from "vitest";
import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters, keccak256, parseAbi, zeroHash, zeroAddress } from "viem";
import { KIT_ABI } from "../recheck/abi.js";
import { KNOWN_DEPLOYMENTS } from "../recheck/deployments.js";
import { KIT_VERSION, recheckKitDescriptor } from "../recheck/descriptor.js";
import { httpRpc } from "../recheck/rpc.js";
import { runCli } from "../recheck/cli.js";
const H = `0x${"ab".repeat(32)}`, U = `0x${"cd".repeat(32)}`, E = `0x${"ab".repeat(20)}`;
const SPEC = fileURLToPath(new URL("../..", import.meta.url));
const STATEMENT = "Chain agreement does not establish brokerage or current state.";
const scratch = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "n266-recheck-"));
const spawnChild = async (command: string, args: string[], options: SpawnOptionsWithoutStdio = {}) => {
  // File descriptors also work in sandboxes that cannot capture child stdio through sockets.
  const dir = scratch(), stdout = join(dir, "stdout"), stderr = join(dir, "stderr");
  const out = openSync(stdout, "w"), err = openSync(stderr, "w");
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(command, args, { timeout: 10_000, ...options, stdio: ["ignore", out, err] });
      child.on("error", reject); child.on("close", resolve);
    });
    return { status, stdout: readFileSync(stdout, "utf8"), stderr: readFileSync(stderr, "utf8") };
  } finally { closeSync(out); closeSync(err); rmSync(dir, { recursive: true, force: true }); }
};
function harness() {
  const d = { ...KNOWN_DEPLOYMENTS[0]!, implementationCodehash: keccak256("0x1234"), recordBlockNumber: 50000000 };
  const reply: any = { chainId: d.chainId, escrow: E, unitId: U, deployment: { chainId: d.chainId, factory: d.factory, implementation: d.implementation, recordSha256: d.recordSha256 }, asOfBlock: "50000000", asOfBlockHash: H, finality: "finalized", logCompleteness: "complete", unitState: 1, phase: "active", finalState: null, isTerminal: false, isAllocated: false, windowEndsAt: null };
  const receipt: any = { ...reply, network: { chainId: d.chainId }, assetReality: null, economics: { amount: "1000000", feeAmount: "20000", recipient: E, token: d.usdc, assuranceTier: 1 }, refundReason: null, finalizedBlock: null };
  for (const k of ["unitState", "isTerminal", "windowEndsAt"]) delete receipt[k];
  const provenance = { chainId: reply.chainId, escrow: E, unitId: U, deployment: reply.deployment, asOfBlock: reply.asOfBlock, asOfBlockHash: H, finality: "finalized", logCompleteness: "complete", provenanceAvailability: "UNANCHORED" };
  const saved = () => [reply, receipt, provenance];
  const requests: { url: string; init: RequestInit }[] = []; let out = "", err = "", behind = false, served: any = recheckKitDescriptor();
  const fetcher: typeof fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init }); let result: any;
    if (String(url).includes("gateway.test")) result = String(url).includes("well-known") ? served : String(url).includes("/receipt?") ? receipt : String(url).includes("/provenance?") ? provenance : reply;
    else {
      const { method, params, id } = JSON.parse(init.body as string);
      if (method === "eth_chainId") result = `0x${d.chainId.toString(16)}`;
      if (method.startsWith("eth_getBlock")) result = { hash: H, number: `0x${(behind && params[0] === "finalized" ? 1 : 50000000).toString(16)}` };
      if (method === "eth_getCode") result = params[0].toLowerCase() === d.implementation ? "0x1234" : `0x363d3d373d3d3d363d73${d.implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`;
      if (method === "eth_getLogs") result = [];
      if (method === "eth_call") {
        const abi = parseAbi(params[0].to.toLowerCase() === d.factory ? KIT_ABI.factory : KIT_ABI.escrow);
        const { functionName } = decodeFunctionData({ abi, data: params[0].data });
        const values: any = { implementation: d.implementation, factory: d.factory, initialized: true, unitExists: true, settlement: [1, 0n, zeroHash, false, zeroAddress, 0n, 0n], unitTerms: [0n, zeroHash, 1, 100n, zeroHash, 0, false], emergencyAnchorOf: 0n, unitCounters: [1020000n, 1n, 0n], feeAmountsOf: [1020000n, 20000n, 1000000n], payoutAt: [E, 1000000n], USDC: d.usdc, requiredTierOf: 1 };
        result = encodeFunctionResult({ abi, functionName, result: values[functionName] } as any);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
    }
    return new Response(JSON.stringify(result));
  };
  const deps = { fetch: fetcher, readFile: async (path: string) => { if (path === "missing") throw new Error("ENOENT"); return JSON.stringify(path === "deployment" ? d : saved()); }, stdin: async () => JSON.stringify(saved()), env: { PCC_API_KEY: "super-secret-key" }, stdout: (s: string) => { out += s; }, stderr: (s: string) => { err += s; } };
  const args = ["--rpc", "https://rpc.test", "--reply", "reply", "--deployment-file", "deployment", "--json"];
  return { reply, receipt, d, args, deps, requests, run: (a = args) => runCli(a, deps), output: () => ({ out, err }), setBehind: () => { behind = true; }, setServed: (x: any) => { served = x; } };
}
describe("recheck CLI and HTTP RPC", () => {
  it("R18 warns about a served descriptor and keeps identical local amount verdicts", async () => {
    const f = harness(); f.receipt.economics.amount = "1020000";
    expect(await f.run()).toBe(1);
    const served = structuredClone(recheckKitDescriptor());
    (served as any).kitSha256 = "different";
    const amount = served.readSurfaces["vnext-read-v1"].find(x => x.pointer === "/economics/amount")!;
    (amount as any).reads = [{ kind: "call", contract: "escrow", fn: "feeAmountsOf", args: ["unitId"], output: "g_" }];
    f.setServed(served);
    expect(await f.run([...f.args, "--gateway", "https://gateway.test"])).toBe(1);
    expect(f.output().err).toContain("kitSha256");
    const reports = f.output().out.trim().split("\n").map(x => JSON.parse(x));
    expect(reports[1].verdicts).toEqual(reports[0].verdicts);
    expect(reports[1].verdicts.find((x: any) => x.pointer === "/economics/amount").verdict).toBe("MISMATCH");
  });
  it("R20 exit codes include usage, unreadable input, mismatch and unverified", async () => { let f = harness(); expect(await f.run()).toBe(0); f = harness(); f.receipt.economics.amount = "1020000"; expect(await f.run()).toBe(1); f = harness(); f.setBehind(); expect(await f.run()).toBe(2); f = harness(); expect(await f.run(["--reply", "reply"])).toBe(3); expect(await f.run(["--rpc", "https://rpc.test", "--reply", "missing"])).toBe(3); expect(await f.run(["--rpc", "https://rpc.test", "--reply", "-"])).toBe(1); });
  it("R21 the API key reaches only gateway Authorization headers", async () => { const f = harness(); await f.run([...f.args, "--gateway", "https://gateway.test"]); expect(f.requests.some(x => x.url.startsWith("https://gateway.test") && new Headers(x.init.headers).get("Authorization") === "Bearer super-secret-key")).toBe(true); for (const x of f.requests.filter(x => x.url.startsWith("https://rpc.test"))) expect(JSON.stringify(x)).not.toContain("super-secret-key"); expect(JSON.stringify(f.output())).not.toContain("super-secret-key"); expect(f.requests.every(x => x.init.redirect === "error")).toBe(true); });
  it("R22 every RPC request carries the kit User-Agent", async () => { const f = harness(); await f.run(); const requests = f.requests.filter(x => new URL(x.url).origin === "https://rpc.test"); expect(requests.length).toBeGreaterThan(3); for (const x of requests) expect(new Headers(x.init.headers).get("User-Agent")).toBe(`pcc-settlement-recheck/${KIT_VERSION}`); });
  it("HTTP retries transport failure once, but never a JSON-RPC error", async () => { let calls = 0; const fetcher = async () => { if (++calls === 1) throw new TypeError("transport"); return new Response(JSON.stringify({ result: "0x1" })); }; expect(await httpRpc("https://rpc.test", { fetch: fetcher as any }).request("eth_chainId", [])).toBe("0x1"); expect(calls).toBe(2); calls = 0; const errorFetch = async () => { calls++; return new Response(JSON.stringify({ error: { code: -32000, message: "no" } })); }; await expect(httpRpc("https://rpc.test", { fetch: errorFetch as any }).request("x", [])).rejects.toMatchObject({ code: -32000 }); expect(calls).toBe(1); });
  it("HTTP enforces its timeout", async () => { let calls = 0; const fetcher: any = (_: any, init: any) => new Promise((_, reject) => { calls++; init.signal.addEventListener("abort", () => reject(new Error("timeout"))); }); await expect(httpRpc("https://rpc.test", { fetch: fetcher, timeoutMs: 5 }).request("x", [])).rejects.toThrow(); expect(calls).toBe(2); });
  it("malformed shapes and cross-route disagreement are input errors before RPC", async () => {
    let f = harness(); f.reply.unitState = "9"; expect(await f.run()).toBe(3); expect(f.requests).toEqual([]);
    f = harness(); f.receipt.escrow = `0x${"12".repeat(20)}`; expect(await f.run()).toBe(3); expect(f.requests).toEqual([]);
  });
  it("input errors issue no RPC requests", async () => { const f = harness(); for (const args of [[...f.args, "--log-window", "0"], [...f.args, "--max-log-requests", "x"], [...f.args, "--wat"]]) expect(await f.run(args)).toBe(3); expect(f.requests).toEqual([]); });
  it.each(["direct", "symlink", "symlinked directory", "pnpm bin shim"])("R35 MR7 built CLI through %s runs main and exits 3", async kind => {
    const dir = scratch();
    try {
      const cli = join(SPEC, "dist/recheck/cli.js");
      let command = process.execPath, args = [cli];
      if (kind === "symlink") { const link = join(dir, "cli.js"); symlinkSync(cli, link); args = [link]; }
      if (kind === "symlinked directory") { symlinkSync(SPEC, join(dir, "spec"), "dir"); args = [join(dir, "spec/dist/recheck/cli.js")]; }
      if (kind === "pnpm bin shim") {
        const modules = join(dir, "node_modules"), bin = join(modules, ".bin");
        mkdirSync(bin, { recursive: true }); mkdirSync(join(modules, "@pcc"));
        symlinkSync(SPEC, join(modules, "@pcc/spec"), "dir");
        command = join(bin, "pcc-settlement-recheck");
        writeFileSync(command, '#!/bin/sh\nbasedir=$(dirname "$0")\nexec "$PCC_TEST_NODE" "$basedir/../@pcc/spec/dist/recheck/cli.js" "$@"\n', { mode: 0o755 });
        args = [];
      }
      const child = await spawnChild(command, args, { env: { ...process.env, PCC_TEST_NODE: process.execPath } });
      expect(child.status).toBe(3);
      expect(child.stderr).toContain("Invalid usage or input. Usage: pcc-settlement-recheck");
      expect(child.stdout).toBe("");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("R36 the built data kit imports with viem unresolvable", async () => {
    const dir = scratch();
    try {
      const installed = join(dir, "node_modules/@pcc/spec");
      mkdirSync(join(installed, "dist"), { recursive: true });
      cpSync(join(SPEC, "package.json"), join(installed, "package.json"));
      cpSync(join(SPEC, "dist/recheck"), join(installed, "dist/recheck"), { recursive: true });
      mkdirSync(join(dir, "node_modules/@noble"), { recursive: true });
      symlinkSync(realpathSync(join(SPEC, "node_modules/@noble/hashes")), join(dir, "node_modules/@noble/hashes"), "dir");
      symlinkSync(realpathSync(join(SPEC, "node_modules/zod")), join(dir, "node_modules/zod"), "dir");
      writeFileSync(join(dir, "import.mjs"), `
        import assert from "node:assert/strict";
        await assert.rejects(import("viem"), { code: "ERR_MODULE_NOT_FOUND" });
        const kit = await import("@pcc/spec/recheck");
        assert.equal(typeof kit.recheckKitDescriptor, "function");
        assert.equal(kit.recheckSettlementReplies, undefined);
        console.log(JSON.stringify(kit.recheckKitDescriptor()));
      `);
      const child = await spawnChild(process.execPath, [join(dir, "import.mjs")]);
      expect(child.stderr).toBe("");
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual(recheckKitDescriptor());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("R37 the built replay subpath exports replay and HTTP RPC without running the CLI", async () => {
    const child = await spawnChild(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      const replay = await import("@pcc/spec/recheck/replay");
      assert.equal(typeof replay.recheckSettlementReplies, "function");
      assert.equal(typeof replay.httpRpc, "function");
      await import("./dist/recheck/cli.js");
    `], { cwd: SPEC });
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    expect(child.stdout).toBe("");
  });
  it.each(["json", "text"])("R38 %s output names only the RPC origin and includes the fixed statement", async mode => {
    const f = harness();
    const args = f.args.filter(x => x !== "--json");
    args[args.indexOf("--rpc") + 1] = "https://rpc.test:8443/v2/provider-path-secret?apiKey=provider-query-secret#provider-fragment-secret";
    if (mode === "json") args.push("--json");
    expect(await f.run(args)).toBe(0);
    const { out, err } = f.output();
    expect(err).toBe("");
    expect(out).toContain("https://rpc.test:8443");
    expect(out).toContain(STATEMENT);
    for (const secret of ["provider-path-secret", "provider-query-secret", "provider-fragment-secret", "/v2/", "apiKey="]) expect(out).not.toContain(secret);
    if (mode === "json") expect(JSON.parse(out)).toMatchObject({ rpc: { origin: "https://rpc.test:8443" }, statement: STATEMENT });
    else expect(out).toContain("RPC https://rpc.test:8443\n");
  });
  it.each(["json", "text"])("R39 %s output suppresses remote log-header errors and control characters", async mode => {
    const f = harness();
    const fetcher = f.deps.fetch;
    let scanned = false;
    const abi = parseAbi(KIT_ABI.escrow);
    const item = abi.find(x => x.type === "event" && x.name === "Finalized") as any;
    const values: any = { unitId: U, released: false, reason: 4 };
    const inputs = item.inputs.filter((x: any) => !x.indexed);
    f.deps.fetch = async (url, init = {}) => {
      const body = JSON.parse(init.body as string);
      if (body.method === "eth_getLogs") {
        scanned = true;
        return new Response(JSON.stringify({ id: body.id, result: [{ address: E, topics: encodeEventTopics({ abi, eventName: "Finalized", args: values }), data: encodeAbiParameters(inputs, inputs.map((x: any) => values[x.name])), blockNumber: "0x2faf080", blockHash: H, logIndex: "0x0", removed: false }] }));
      }
      if (scanned && body.method === "eth_getBlockByNumber" && body.params[0] !== "finalized") return new Response(JSON.stringify({ id: body.id, error: { code: -32000, message: "NODE-TEXT \u001b[2J\u001b[1;1HALL_MATCH\u0085" } }));
      return fetcher(url, init);
    };
    const args = f.args.filter(x => x !== "--json");
    if (mode === "json") args.push("--json");
    expect(await f.run(args)).toBe(2);
    const { out } = f.output();
    expect(out).not.toContain("NODE-TEXT");
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    if (mode === "json") expect(JSON.parse(out).verdicts.find((v: any) => v.pointer === "/refundReason").reason).toBe("log scan unavailable");
    else expect(out).toContain("receipt /refundReason: UNVERIFIED (log scan unavailable)");
  });
  it("R40 JSON strips C0/C1 controls from echoed reply fields", async () => {
    const f = harness();
    f.receipt.assetReality = { value: "test\u0000\t\n\r\u001b\u007f\u0085\u009b", source: "registry", attests: "identity-not-liveness" };
    expect(await f.run()).toBe(0);
    const report = JSON.parse(f.output().out);
    expect(report.verdicts.find((v: any) => v.pointer === "/assetReality/value").got).toBe("test");
    expect(report.verdicts.find((v: any) => v.pointer === "/assetReality").got.value).toBe("test");
  });
});
