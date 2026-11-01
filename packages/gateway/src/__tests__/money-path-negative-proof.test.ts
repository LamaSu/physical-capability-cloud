import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  WRITE_METHODS, WRITE_SCOPE, compareWrites, formatFindings, listRepoFiles,
  readAllowlist, scanBytecode, scanForbiddenRuntime, scanPythonWrites,
  scanRuntimeSolcDependencies, scanWrites,
  type Finding, type WriteAllowlist, type WriteRecord,
} from "./helpers/negative-proof-scan.js";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const ALLOWLIST = fileURLToPath(new URL("./fixtures/money-path-write-allowlist.json", import.meta.url));
const TIMEOUT = 60_000;
const temporary: string[] = [];
function tree(contents: Record<string, string | Buffer>): { root: string; files: string[] } {
  const root = mkdtempSync(join(tmpdir(), "pcc-negative-proof-"));
  temporary.push(root);
  for (const [file, text] of Object.entries(contents)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return { root, files: Object.keys(contents) };
}
afterAll(() => { for (const root of temporary) rmSync(root, { recursive: true, force: true }); });
const codes = (findings: Finding[]) => findings.map(finding => finding.rule);
function clean(findings: Finding[], rule: string): void {
  const selected = findings.filter(finding => finding.rule === rule);
  expect(selected, formatFindings(selected)).toEqual([]);
}
function reviewed(records: WriteRecord[]): WriteAllowlist {
  return {
    schema: "pcc.money-path-write-allowlist/v1", methods: [...WRITE_METHODS], scope: [...WRITE_SCOPE],
    entries: records.map(record => ({ ...record, signer: "synthetic control key", why: "Synthetic fixed operation.", ...(record.method === "writeContract" ? {} : { payload: "Synthetic bytes built locally." }) })),
  };
}
// The real-repo assertion and self-mutants use the same path-parameter loader.
// Only copies in tmpdir() are mutated; no environment variable changes fixture selection.
export function moneyPathFindings(root: string, files: string[], fixturePath: string): Finding[] {
  const writes = scanWrites(root, files);
  return [...writes.findings, ...compareWrites(writes.records, readAllowlist(fixturePath))];
}

let files: string[];
let writes: ReturnType<typeof scanWrites>;
let comparison: Finding[];
let forbidden: Finding[];
function real(): void {
  if (files) return;
  files = listRepoFiles(REPO);
  writes = scanWrites(REPO, files);
  comparison = moneyPathFindings(REPO, files, ALLOWLIST);
  forbidden = scanForbiddenRuntime(REPO, files);
}

describe("E2 fixed runtime write surface", () => {
  for (const rule of ["E2-R1", "E2-R2", "E2-R3", "E2-R4"] as const) {
    it(`${rule}: the real tree matches the reviewed multiset and rejects caller payloads`, () => { real(); clean(comparison, rule); }, TIMEOUT);
  }
  it("E2-R1 controls: detects every callee form and excludes method definitions, comments, strings and operator scripts", () => {
    const t = tree({
      "packages/sample/src/writes.ts": `
        class EscrowClient { release() { wallet.writeContract?.({ abi: ABI, functionName: "release" }); } }
        const service = { send: () => w["sendTransaction"]({ data: "0x" }) };
        function send() { sendRawTransaction(raw); }
        const optional = () => w?.sendUserOperation({ calls: [] });
        function bare() { writeContract(client, { abi: ABI, functionName: "fund" }); }
        ${WRITE_METHODS.filter(method => !["writeContract", "sendTransaction", "sendRawTransaction", "sendUserOperation"].includes(method)).map(method => `function ${method}Control() { w.${method}({ data: "0x" }); }`).join("\n")}
      `,
      "packages/sample/src/near.ts": `class C { writeContract() {} } const s = "sendTransaction()"; /* w.writeContract({}) */`,
      "packages/sample/src/escapes.ts": `function encoded() { w["write\\u0043ontract"]({abi:ABI,functionName:"fund"}); }`,
      "scripts/write.ts": "w.sendTransaction({ data: req.body.data });",
      "packages/sample/scripts/write.ts": "w.sendTransaction({ data: req.body.data });",
      "packages/contracts/script/write.ts": "w.sendTransaction({ data: req.body.data });",
    });
    const result = scanWrites(t.root, t.files);
    expect(new Set(result.records.map(record => record.method))).toEqual(new Set(WRITE_METHODS));
    expect(result.records).toHaveLength(WRITE_METHODS.length + 2);
    expect(result.records.find(record => record.enclosing === "EscrowClient.release")?.functionName).toBe("release");
    expect(result.records.find(record => record.enclosing === "service.send")?.method).toBe("sendTransaction");
    expect(result.records.find(record => record.enclosing === "bare")?.functionName).toBe("fund");
    expect(result.records.find(record => record.enclosing === "encoded")?.method).toBe("writeContract");
    expect(result.records.every(record => record.file.endsWith("writes.ts") || record.file.endsWith("escapes.ts"))).toBe(true);
    expect(codes(compareWrites(result.records, reviewed([])))).toContain("E2-R1");
    clean(compareWrites(result.records, reviewed(result.records)), "E2-R1");
    const near = tree({ "packages/sample/src/near.ts": "class C { writeContract() {} } const x = 'sendTransaction()'; // w.sendRawTransaction(bytes)" });
    expect(scanWrites(near.root, near.files).records).toEqual([]);
  }, TIMEOUT);

  it("E2-R1 controls: counts identical anonymous sites as a multiset", () => {
    const t = tree({ "packages/sample/src/a.ts": `function run() { [1].map(() => w.writeContract({abi: ABI,functionName:"fund"})); [2].map(() => w.writeContract({abi: ABI,functionName:"fund"})); }` });
    const result = scanWrites(t.root, t.files);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ count: 2, enclosing: "<anonymous> in run" });
    const list = reviewed(result.records);
    list.entries[0].count = 1;
    expect(codes(compareWrites(result.records, list))).toContain("E2-R1");
    clean(compareWrites(result.records, reviewed(result.records)), "E2-R1");
  }, TIMEOUT);

  it("E2-R1 controls: class-field arrows, accessors and nested object methods retain qualified names", () => {
    const t = tree({ "packages/sample/src/a.ts": `
      const EscrowClient = class { release = () => w.writeContract({abi:ABI,functionName:"release"}); get settled() { return w.writeContract({abi:ABI,functionName:"settled"}); } };
      const service = { nested: { send() { w.sendTransaction({data:"0x"}); } } };
    ` });
    const result = scanWrites(t.root, t.files);
    expect(result.records.map(record => record.enclosing).sort()).toEqual(["EscrowClient.release", "EscrowClient.settled", "service.nested.send"]);
    expect(codes(compareWrites(result.records, reviewed([])))).toContain("E2-R1");
    clean(compareWrites(result.records, reviewed(result.records)), "E2-R1");
  }, TIMEOUT);

  it("E2-R2 controls: stale entry fails and the matching site passes", () => {
    const t = tree({ "packages/sample/src/a.ts": `function send() { w.sendTransaction({data:"0x"}); }` });
    const result = scanWrites(t.root, t.files);
    const list = reviewed(result.records);
    list.entries.push({ ...list.entries[0], enclosing: "invented" });
    expect(codes(compareWrites(result.records, list))).toContain("E2-R2");
    clean(compareWrites(result.records, reviewed(result.records)), "E2-R2");
  }, TIMEOUT);

  it("E2-R3 controls: resolves closure literals, parameters, destructuring, assignments and unresolved payload identifiers", () => {
    const t = tree({ "packages/sample/src/a.ts": `
      const moduleName = "approve";
      function fixed() { const name = choose ? "createEscrowV2" : "createEscrow"; lock(() => w.writeContract({abi: ABI,functionName:name})); }
      function destructured({ functionName: parameterName }) { w.writeContract({abi:ABI,functionName:parameterName}); }
      function assigned() { let name; name = "fund"; w.writeContract({abi:ABI,functionName:name}); }
      function moduleClosure() { w.writeContract({abi:ABI,functionName:moduleName}); }
      function destructuredLiteral() { const { functionName: name } = {functionName:"release"}; w.writeContract({abi:ABI,functionName:name}); }
      function raw() { w.sendTransaction({ data: unknownPayload }); }
    ` });
    const result = scanWrites(t.root, t.files);
    expect(result.records.find(record => record.enclosing === "<anonymous> in fixed")).toMatchObject({ functionName: "createEscrowV2|createEscrow", nonLiteralFunctionName: false });
    expect(result.records.find(record => record.enclosing === "destructured")).toMatchObject({ nonLiteralFunctionName: true, bindings: { parameterName: "param" } });
    expect(result.records.find(record => record.enclosing === "assigned")).toMatchObject({ functionName: "fund", nonLiteralFunctionName: false });
    expect(result.records.find(record => record.enclosing === "moduleClosure")).toMatchObject({ functionName: "approve", nonLiteralFunctionName: false });
    expect(result.records.find(record => record.enclosing === "destructuredLiteral")).toMatchObject({ functionName: "release", nonLiteralFunctionName: false });
    expect(result.records.find(record => record.enclosing === "raw")?.bindings).toEqual({ unknownPayload: "<unresolved>" });
    const list = reviewed(result.records);
    const first = list.entries.find(entry => entry.method === "writeContract")!;
    first.nonLiteralFunctionName = !first.nonLiteralFunctionName;
    expect(codes(compareWrites(result.records, list))).toContain("E2-R3");
    clean(compareWrites(result.records, reviewed(result.records)), "E2-R3");
    const near = tree({ "packages/sample/src/a.ts": `function send(req) { let data; { let data; data = req.body.x; } w.sendTransaction({data}); }` });
    const nearResult = scanWrites(near.root, near.files);
    clean(nearResult.findings, "E2-R4");
    expect(nearResult.records[0].bindings).toEqual({ data: "<unresolved>" });
  }, TIMEOUT);

  it("E2-R3 controls: metadata must be reviewed and methods/scope must be exact", () => {
    const t = tree({ "packages/sample/src/a.ts": `function send() { w.sendTransaction({data:"0x"}); }` });
    const records = scanWrites(t.root, t.files).records;
    for (const field of ["signer", "why", "payload"] as const) for (const value of ["", "  ", "REVIEW"]) {
      const list = reviewed(records);
      list.entries[0][field] = value;
      expect(codes(compareWrites(records, list)), `${field}=${JSON.stringify(value)}`).toContain("E2-R3");
    }
    for (const field of ["methods", "scope"] as const) {
      const list = reviewed(records);
      list[field] = [...list[field], "invented"];
      expect(codes(compareWrites(records, list)), field).toContain("E2-R3");
    }
    clean(compareWrites(records, reviewed(records)), "E2-R3");
  }, TIMEOUT);

  const callerPayloads = [
    ["direct PM3", `function send(req) { w.sendTransaction({data:req.body.x}); }`],
    ["destructured PM3", `function send(req) { const { x } = req.body; w.sendTransaction({data:x}); }`],
    ["shorthand", `function send(req) { const { data } = req.body; w.sendTransaction({data}); }`],
    ["destructured parameter", `function send({body: {x}}: any) { w.sendTransaction({data:x}); }`],
    ["closure captured", `function send(req) { const data = req.body.x; lock(() => w.sendTransaction({data})); }`],
    ["assignment", `function send(req) { let data; data = req.body.x; w.sendTransaction({data}); }`],
    ["nested if assignment", `function send(req) { let data; if (true) { data = req.body.x; } w.sendTransaction({data}); }`],
    ["spread", `function send(req) { w.sendTransaction({...req.body}); }`],
    ["bound spread", `function send(req) { const requestPayload = req.body; w.sendTransaction({...requestPayload}); }`],
    ["headers", `function send(request) { w.sendTransaction({data:request.headers["x-payload"]}); }`],
    ["query", `function send(ctx) { w.sendRawTransaction(ctx.query.raw); }`],
    ["params", `function send(reply) { w.sendUserOp(reply.params.callData); }`],
    ["bare viem", `function send(req) { sendTransaction(client, {data:req.body.x}); }`],
    ["writeContract argument", `function send(req) { w.writeContract({abi: ABI,functionName:"relay",args:[req.body.callData]}); }`],
    ["bare writeContract argument", `function send(req) { writeContract(client, {abi: ABI,functionName:"relay",args:[req.headers.bytecode]}); }`],
  ];
  for (const [name, source] of callerPayloads) it(`E2-R4 control: ${name} cannot be allowlisted; a locally built payload passes`, () => {
    const t = tree({ "packages/sample/src/a.ts": source });
    const result = scanWrites(t.root, t.files);
    expect(codes(result.findings), formatFindings(result.findings)).toContain("E2-R4");
    // Exact allowlisting never suppresses an intrinsic finding.
    expect(codes([...result.findings, ...compareWrites(result.records, reviewed(result.records))])).toContain("E2-R4");
    const near = tree({ "packages/sample/src/a.ts": `function send(req) { const data = encodeFunctionData({abi:ABI,functionName:"mint",args:[amount]}); w.sendTransaction({data}); w.writeContract({abi:ABI,functionName:"mint",args:[req.body.amount]}); }` });
    clean(scanWrites(near.root, near.files).findings, "E2-R4");
  }, TIMEOUT);

  it("E2-R4 controls: request-derived selectors and recipients alone are outside raw payload positions", () => {
    const t = tree({ "packages/sample/src/a.ts": `function send(req) {
      const tx = {to:req.body.recipient,data:"0x"}; w.sendTransaction(tx);
      const name = req.body.name; w.writeContract({abi:ABI,functionName:name,args:[req.body.amount]});
    }` });
    clean(scanWrites(t.root, t.files).findings, "E2-R4");
    const planted = tree({ "packages/sample/src/a.ts": `function send(req) { const tx={to:req.body.recipient,data:req.body.bytes}; w.sendTransaction(tx); }` });
    expect(codes(scanWrites(planted.root, planted.files).findings)).toContain("E2-R4");
  }, TIMEOUT);

  it("E2-R5: no alternate EVM sender, generic contract proxy or raw JSON-RPC send string exists in runtime", () => { real(); clean(forbidden, "E2-R5"); }, TIMEOUT);
  const alternateSenders = [
    `import { Wallet } from "eth\\u0065rs";`, `export { Wallet } from "ethers";`, `export * from "web3";`,
    `const e = require("@ethersproject/wallet");`, `const e = import("ethers");`,
    `import E = require("ethers");`, `getContract({});`, `viem.getContract({});`,
    ...["eth_sendTransaction", "eth_sendRawTransaction", "eth_signTransaction", "eth_sendUserOperation", "wallet_sendCalls"].map(method => `const method = "${method}";`),
  ];
  for (const [index, source] of alternateSenders.entries()) it(`E2-R5 control ${index + 1}: AST alternate sender is rejected; a comment and unrelated module pass`, () => {
    const t = tree({ "packages/sample/src/a.ts": source });
    expect(codes(scanForbiddenRuntime(t.root, t.files))).toContain("E2-R5");
    const near = tree({ "packages/sample/src/a.ts": `// ${source}\nimport { helper } from "ethers-helper"; const text = "getContract({})";` });
    clean(scanForbiddenRuntime(near.root, near.files), "E2-R5");
  }, TIMEOUT);

  it("E2-R6: no non-test Python transaction sender exists under packages", () => { real(); clean(scanPythonWrites(REPO, files), "E2-R6"); }, TIMEOUT);
  it("E2-R6 controls: Python calls fail; comments, strings and test paths pass", () => {
    const t = tree({ "packages/sample/node.py": "client.send_raw_transaction(raw)\nclient.send_transaction(tx)\nkey.sign_transaction(tx)\ncontract.build_transaction(tx)\ncontract.functions.fund().transact()\n" });
    const result = scanPythonWrites(t.root, t.files);
    expect(result).toHaveLength(5);
    expect(new Set(codes(result))).toEqual(new Set(["E2-R6"]));
    const near = tree({
      "packages/sample/node.py": '# client.send_raw_transaction(raw)\ntext = "key.sign_transaction(tx)"\n',
      "packages/sample/tests/node.py": "client.send_raw_transaction(raw)",
      "packages/sample/src/example.test.py": "client.send_transaction(tx)",
    });
    clean(scanPythonWrites(near.root, near.files), "E2-R6");
  }, TIMEOUT);
});

describe("E3 no unverifiable bytecode or runtime Solidity toolchain", () => {
  it("E3-R1: no init-code preamble outside tests/out; the known funding fixture is excluded by its test path", () => {
    real();
    clean(scanBytecode(REPO, files), "E3-R1");
    const fundingTest = "packages/spec/src/__tests__/funding/fund.test.ts";
    const includingTests = scanBytecode(REPO, files, true);
    expect(includingTests.some(finding => finding.file === fundingTest), formatFindings(includingTests)).toBe(true);
    expect(scanBytecode(REPO, [fundingTest])).toEqual([]);
    expect(new Set(includingTests.map(finding => finding.file)), formatFindings(includingTests)).toEqual(new Set([fundingTest]));
  }, TIMEOUT);

  it("E3-R1 controls: bytecode fails; test paths, Foundry outputs, binary files and short data pass", () => {
    const bytecode = ["0x6080", "604052", "ab".repeat(12)].join("");
    const t = tree({ "scripts/deploy.ts": `const code = "${bytecode}";` });
    expect(codes(scanBytecode(t.root, t.files))).toContain("E3-R1");
    const near = tree({
      "packages/sample/src/__tests__/fixture.ts": bytecode,
      "packages/sample/test/fixture.ts": bytecode,
      "packages/sample/tests/fixture.ts": bytecode,
      "packages/sample/src/fixture.test.ts": bytecode,
      "packages/sample/src/fixture.spec.ts": bytecode,
      "packages/contracts/test/Fixture.t.sol": bytecode,
      "packages/contracts/out/Fixture.json": bytecode,
      "images/data.bin": Buffer.concat([Buffer.from([0]), Buffer.from(bytecode)]),
      "docs/short.md": ["0x6080", "604052", "abcd"].join(""),
    });
    clean(scanBytecode(near.root, near.files), "E3-R1");
    expect(scanBytecode(near.root, near.files, true).some(finding => finding.file.includes("__tests__"))).toBe(true);
  }, TIMEOUT);

  it("E3-R2: runtime never imports a Solidity compiler or invokes Solidity CLI commands", () => { real(); clean(forbidden, "E3-R2"); }, TIMEOUT);
  const toolchains: Array<[string, string]> = [
    ["compiler import", `import compiler from "sol\\u0063";`],
    ["compiler require", `const compiler = require("solc-js");`],
    ["compiler dynamic import", `const compiler = import("solc");`],
    ...["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork", "execa"].map((method, index): [string, string] => [
      `bare ${method}`, `${method}("${["solc", "forge", "cast", "anvil", "chisel"][index % 5]} --version");`,
    ]),
    ["template head", 'spawn(`forge ${target}`);'],
    ["plain forge build", 'execSync("forge build");'],
    ["interpolated forge build", 'execSync(`forge build --root ${process.cwd()}`);'],
    ["named child_process import alias", 'import { execSync as plantedExec } from "node:child_process"; plantedExec("forge build");'],
    ["destructured require alias", 'const { execSync: plantedRun } = require("node:child_process"); plantedRun("forge build");'],
    ["npx wrapper", 'execSync("npx solc --bin planted.sol");'],
    ["sh argv wrapper", 'execFileSync("sh", ["-c", "forge build"]);'],
    ["env argv wrapper", 'execFileSync("/usr/bin/env", ["forge", "build"]);'],
    ["unprefixed named import alias", 'import { execFileSync as run } from "child_process"; run("forge", ["build"]);'],
    ["namespace child_process import", 'import * as cp from "node:child_process"; cp.execSync("forge build");'],
    ["default child_process import", 'import cp from "child_process"; cp.execSync("forge build");'],
    ["child_process namespace rebinding", 'import * as cp from "child_process"; const run = cp.execSync; run("forge build");'],
    ["namespace require", 'const cp = require("node:child_process"); cp.execSync("forge build");'],
    ["require property rebinding", 'const cp = require("child_process"); const run = cp.execSync; run("forge build");'],
    ["direct require property rebinding", 'const run = require("node:child_process").execSync; run("forge build");'],
    ["unrenamed require destructuring", 'const { execSync } = require("child_process"); execSync("forge build");'],
    ["named execa import alias", 'import { execa as run } from "execa"; run("forge", ["build"]);'],
    ["default execa import", 'import run from "execa"; run("forge", ["build"]);'],
    ["namespace execa import", 'import * as commands from "execa"; commands.execa("forge", ["build"]);'],
    ["namespace execa rebinding", 'import * as commands from "execa"; const run = commands.execa; run("forge", ["build"]);'],
    ["destructured execa require alias", 'const { execa: run } = require("execa"); run("forge", ["build"]);'],
    ["callable execa require", 'const run = require("execa"); run("forge", ["build"]);'],
    ["namespace execa require", 'const commands = require("execa"); commands.execa("forge", ["build"]);'],
    ["execa require property rebinding", 'const commands = require("execa"); const run = commands.execa; run("forge", ["build"]);'],
    ["pnpm exec wrapper", 'execSync("pnpm exec forge build");'],
    ["pnpm dlx wrapper", 'execSync("pnpm dlx solcjs --bin planted.sol");'],
    ["yarn wrapper", 'execSync("yarn solc --bin planted.sol");'],
    ["bunx wrapper", 'execSync("bunx solcjs --bin planted.sol");'],
    ["bash argv wrapper", 'execFileSync("bash", ["-c", "forge build"]);'],
    ["shell separator words", 'execSync("echo ready; /usr/local/bin/forge build && echo done || cast --version | cat");'],
    ["argv word splitting", 'execFileSync("node", ["--eval", "echo ready&&/usr/local/bin/anvil --version"]);'],
    ["template tail words", 'execSync(`echo ${target} /usr/local/bin/chisel --version`);'],
    ["argv template literal parts", 'execFileSync("bash", ["-c", `echo ${target}; /usr/local/bin/solcjs --version`]);'],
    ["bound command", 'const plantedCmd = "forge build"; execSync(plantedCmd);'],
    ["concatenated command", 'execSync("forge build --root " + process.cwd());'],
    ["promisified exec", 'import { promisify } from "node:util"; const plantedExecAsync = promisify(exec); plantedExecAsync("forge build");'],
    ["execa dollar tag", 'import { $ } from "execa"; $`forge build`;'],
    ["shell command substitution", 'execFileSync("sh", ["-c", "echo $(forge build)"]);'],
    ["bound argv", 'const plantedArgs = ["-c", "forge build"]; execFileSync("sh", plantedArgs);'],
    ["shell backtick substitution", 'execFileSync("sh", ["-c", "echo `forge build`"]);'],
    ["shell assignment substitution", 'execFileSync("sh", ["-c", "out=$(forge build)"]);'],
    ["namespace promisify execFile", 'import * as util from "node:util"; import * as cp from "node:child_process"; const run = util.promisify(cp.execFile); run("forge", ["build"]);'],
    ["bound command chain", 'const first = "forge build"; const second = first; const command = second; execSync(command);'],
    ["bound template command chain", 'const first = `forge build --root ${process.cwd()}`; const command = first; execSync(command);'],
    ["bound concatenated command chain", 'const first = "echo ready; " + process.cwd() + " && forge build"; const command = first; execSync(command);'],
    ["bound argv chain", 'const first = ["-c", "forge build"]; const second = first; const args = second; execFileSync("sh", args);'],
    ["bound argv element chain", 'const first = "forge build"; const command = first; const args = ["-c", command]; execFileSync("sh", args);'],
    ["concatenated argv element", 'execFileSync("bash", ["-c", "echo ready; " + process.cwd() + " && forge build"]);'],
    ["closure captured command", 'const command = "forge build"; function build() { execSync(command); }'],
    ["promisify named alias", 'import { promisify as asyncify } from "util"; import { exec as execute } from "child_process"; const run = asyncify(execute); run("forge build");'],
    ["promisify default import", 'import util from "node:util"; import cp from "node:child_process"; const run = util.promisify(cp.exec); run("forge build");'],
    ["promisify destructured require", 'const { promisify: asyncify } = require("node:util"); const { exec: execute } = require("node:child_process"); const run = asyncify(execute); run("forge build");'],
    ["promisify namespace require", 'const util = require("util"); const cp = require("child_process"); const run = util.promisify(cp.execFile); run("forge", ["build"]);'],
    ["promisified function alias chain", 'import { promisify } from "node:util"; import { exec } from "node:child_process"; const first = promisify(exec); const run = first; run("forge build");'],
    ["execa named tag", 'import { execa } from "execa"; execa`forge build`;'],
    ["execa command tag", 'import { execaCommand } from "execa"; execaCommand`forge build`;'],
    ["execa tag alias", 'import { $ as shell } from "execa"; shell`forge build`;'],
    ["execa sync dollar tag", 'import { $ } from "execa"; $.sync`forge build`;'],
    ["execa namespace dollar tag", 'import * as commands from "execa"; commands.$`forge build`;'],
    ["execa require tag alias", 'const { $: shell } = require("execa"); shell`forge build`;'],
    ["execa tag rebinding", 'import { $ } from "execa"; const shell = $.sync; shell`forge build`;'],
    ["execa tag template tail", 'import { $ } from "execa"; $`echo ${target}; forge build`;'],
    ["parenthesized shell group", 'execFileSync("sh", ["-c", "(cd contracts; forge build)"]);'],
  ];
  for (const [name, source] of toolchains) it(`E3-R2 control ${name}: runtime toolchain fails; comments, unrelated commands and operator scripts pass`, () => {
    const t = tree({ "packages/sample/src/a.ts": source });
    expect(codes(scanForbiddenRuntime(t.root, t.files))).toContain("E3-R2");
    const near = tree({
      "packages/sample/src/a.ts": `// ${source}\nconst description = "forge build"; spawn("node", ["index.js"]);`,
      "scripts/deploy.ts": source,
      "packages/sample/scripts/deploy.ts": source,
    });
    clean(scanForbiddenRuntime(near.root, near.files), "E3-R2");
  }, TIMEOUT);

  const commandNearMisses: Array<[string, string]> = [
    ["npx prettier", 'execSync("npx prettier --check .");'],
    ["git forgery search", 'execFileSync("git", ["log", "--grep", "forgery"]);'],
    ["shell echo", 'execFileSync("sh", ["-c", "echo done"]);'],
    ["unrelated import alias", 'import { execSync as run } from "./adapter"; run("forge build");'],
    ["parameter shadowing an import", 'import { execSync as run } from "node:child_process"; function send(run: (command: string) => void) { run("forge build"); }'],
    ["destructured parameter", 'import request from "execa"; function send({execSync: run}: any) { run("forge build"); }'],
    ["hoisted local function shadowing an import", 'import { execSync as run } from "node:child_process"; function send() { run("forge build"); function run(command: string) {} }'],
    ["forge-ready label", 'execSync("echo forge-ready");'],
    ["git forge grep option", 'execFileSync("git", ["log", "--grep=forge"]);'],
    ["SQL cast expression", 'db.exec("SELECT cast(x AS INTEGER) FROM t");'],
    ["unused forge label", 'const label = "forge build"; execSync("git status");'],
    ["bound git command", 'const cmd = "git status"; execSync(cmd);'],
    ["bound safe command chain", 'const first = "git status"; const command = first; execSync(command);'],
    ["bound safe argv chain", 'const first = ["log", "--grep=forge"]; const args = first; execFileSync("git", args);'],
    ["command parameter shadows outer binding", 'const command = "forge build"; function run(command: string) { execSync(command); }'],
    ["command cycle", 'let a; let b = a; a = b; execSync(a);'],
    ["argv cycle", 'let a; let b = a; a = b; execFileSync("sh", a);'],
    ["unrelated promisify import", 'import { promisify } from "./adapter"; import { exec } from "node:child_process"; const run = promisify(exec); run("forge build");'],
    ["local promisify function", 'function promisify(fn: any) { return fn; } const run = promisify(exec); run("forge build");'],
    ["promisify unrelated function", 'import { promisify } from "node:util"; import { query } from "./db"; const run = promisify(query); run("forge build");'],
    ["promisify parameter shadows import", 'import { promisify } from "node:util"; function call(promisify: any) { const run = promisify(exec); run("forge build"); }'],
    ["unrelated execa-like tag", 'import { $ } from "./adapter"; $`forge build`;'],
    ["parameter shadows execa tag", 'import { $ } from "execa"; function call($: any) { $`forge build`; }'],
    ["command imported from another module", 'import command from "./commands"; execSync(command);'],
    ["command returned from function", 'function command() { return "forge build"; } execSync(command());'],
    ["command held in object property", 'const commands = { build: "forge build" }; execSync(commands.build);'],
    ["command joined from array", 'const command = ["forge", "build"].join(" "); execSync(command);'],
  ];
  for (const [name, source] of commandNearMisses) it(`E3-R2 near miss ${name}: unrelated executable words pass`, () => {
    const t = tree({ "packages/sample/src/a.ts": source });
    clean(scanForbiddenRuntime(t.root, t.files), "E3-R2");
  }, TIMEOUT);

  it("E3-R3: runtime package dependency groups contain no solc", () => { real(); clean(scanRuntimeSolcDependencies(REPO, files), "E3-R3"); }, TIMEOUT);
  for (const group of ["dependencies", "optionalDependencies", "peerDependencies"]) it(`E3-R3 control: ${group} solc fails; devDependency and unrelated package metadata pass`, () => {
    const t = tree({ "packages/sample/package.json": JSON.stringify({ [group]: { solc: "1.0.0" } }) });
    expect(codes(scanRuntimeSolcDependencies(t.root, t.files))).toContain("E3-R3");
    const near = tree({
      "apps/sample/package.json": JSON.stringify({ devDependencies: { solc: "1.0.0" }, dependencies: { "solc-helper": "1.0.0" } }),
      "scripts/package.json": JSON.stringify({ dependencies: { solc: "1.0.0" } }),
    });
    clean(scanRuntimeSolcDependencies(near.root, near.files), "E3-R3");
  }, TIMEOUT);
});

describe("scanner enumeration and real-repo fixture self-mutants", () => {
  it("git enumeration includes untracked files, drops vanished paths, and fails loudly outside git", () => {
    const t = tree({ "packages/sample/src/untracked.ts": "export const value = 1;" });
    expect(() => listRepoFiles(t.root)).toThrow();
    execFileSync("git", ["init", "-q"], { cwd: t.root });
    expect(listRepoFiles(t.root)).toContain(t.files[0]);
    rmSync(join(t.root, t.files[0]));
    expect(() => listRepoFiles(t.root)).toThrow("git returned no existing files");
  }, TIMEOUT);

  const mutants: Array<[string, string, (list: WriteAllowlist) => void]> = [
    ["delete fund.ts sendTransaction", "E2-R1", list => {
      const index = list.entries.findIndex(entry => entry.file === "packages/spec/src/funding/fund.ts" && entry.method === "sendTransaction");
      expect(index).toBeGreaterThanOrEqual(0);
      list.entries.splice(index, 1);
    }],
    ["add fake entry", "E2-R2", list => { list.entries.push({ ...list.entries[0], file: "packages/invented/src/fake.ts" }); }],
    ["flip nonLiteralFunctionName", "E2-R3", list => {
      const entry = list.entries.find(item => item.file === "packages/agent-runtime/src/wallet.ts" && item.enclosing === "AgentWallet.callContract")!;
      expect(entry.nonLiteralFunctionName).toBe(true);
      entry.nonLiteralFunctionName = false;
    }],
    ["blank payload", "E2-R3", list => { const entry = list.entries.find(item => item.method !== "writeContract")!; entry.payload = ""; }],
  ];
  for (const [name, rule, mutate] of mutants) it(`self-mutant ${name}: real-repo fixture check fails ${rule}`, () => {
    real();
    const list = readAllowlist(ALLOWLIST);
    mutate(list);
    const t = tree({ "allowlist.json": JSON.stringify(list) });
    const result = moneyPathFindings(REPO, files, join(t.root, "allowlist.json"));
    expect(new Set(codes(result)), formatFindings(result)).toEqual(new Set([rule]));
    expect(result.length).toBeGreaterThan(0);
    clean(moneyPathFindings(REPO, files, ALLOWLIST), rule);
  }, TIMEOUT);
});
