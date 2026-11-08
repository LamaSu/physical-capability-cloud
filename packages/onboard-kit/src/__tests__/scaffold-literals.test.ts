import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { scaffold } from "../scaffolder.js";
import { validate } from "../validate.js";

type OnboardConfig = Parameters<typeof scaffold>[0]["config"];
const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const example = (): OnboardConfig => JSON.parse(readFileSync(join(packageDir, "src/examples/cnc-shop-config.json"), "utf8"));
const H = 'x"+(globalThis.__N303=1)+"\\';
const HC = "a */ (globalThis.__N303 = 1); /* b\nEXTRA=1";
const QUOTED = 'Haas VF-2 "Big Blue"';
const CONTROL = 'back\\slash\ttab\u0000nul\u2028ls\u2029ps\nnl\\';
const CRAFTED = 'x", extra: (globalThis.__N303 = 1), y: "';
const CRAFTED2 = 'x\\", extra: (globalThis.__N303 = 2), y: \\"';
const POLL = "1); (globalThis.__N303 = 1); (0";
const CLASS_NAMES = [
  "Array", "Buffer", "Date", "Error", "EvidenceEmitter", "EvidenceEvent", "EvidenceSource", "JSON", "JobRunner",
  "MachineCommand", "MachineCommandResult", "MachineStatus", "Math", "Number", "Omit", "Promise", "Record",
  "Response", "ReturnType", "String", "TextEncoder", "Uint8Array",
];
const VARIABLE_NAMES = [
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else",
  "enum", "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new",
  "null", "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
  "implements", "interface", "let", "package", "private", "protected", "public", "static", "arguments", "eval",
  "EvidenceEmitter", "JobRunner", "capabilities", "console", "evidenceEmitter", "jobRunner", "process",
];
const WINDOWS_DEVICE_NAMES = [
  "con", "prn", "aux", "nul", "com0", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt0", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];
const API_KEY_STEMS = [
  "AIRBYTE", "AISA", "ANTHROPIC", "CARTESIA", "CDP", "COHERE", "COINBASE", "DEEPGRAM", "DEEPSEEK", "EASYPOST", "ETHERSCAN", "GEMINI",
  "GOOGLE", "GROQ", "INSFORGE", "LIT", "LOB", "MISTRAL", "OPENAI", "OPENROUTER", "PCC", "PCC_DECOMPOSE", "PCC_REVOKE", "PCC_SMITHERY",
  "POSTHOG", "POSTHOG_PERSONAL", "RESEND", "XAI", "YELLOWCARD",
];
const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z])([A-Z][a-z])/g, "$1-$2").toLowerCase();
const camel = (s: string) => s.replace(/[-_](.)/g, (_, c) => c.toUpperCase());
const envName = (s: string) => s.replace(/[-]/g, "_").toUpperCase();
const comment = (v: unknown) => String(v).replace(/\*\//g, "* /").replace(/\r\n|[\r\n\u2028\u2029]/g, " ");
const shown = (v: unknown) => typeof v === "string" ? JSON.stringify(v) : String(v);
const r1 = (v: unknown) => `${shown(v)} is not a PascalCase identifier (A-Z, then at most 63 letters or digits); the scaffold declares a class and names a file with it`;
const r2 = (v: unknown) => `${shown(v)} is a name the generated code already uses; choose another class name`;
const r4 = (v: unknown) => `${shown(v)} is not an adapter id the scaffold can use (a letter, then letters or digits with single "-" or "_" between them, at most 64 characters); the scaffold makes a variable and environment variables from it`;
const r5variable = (v: string) => `${shown(v)} makes the variable ${camel(v)}, a name the generated kernel.ts already uses or JavaScript reserves`;
const r5env = (v: string, name: string) => `${shown(v)} makes the environment variable ${name}, which .env.example already defines`;
const r5api = (v: string) => `${shown(v)} makes the environment variable ${envName(v)}_API_KEY, which other software already reads as its API key; choose another adapter id`;
const r7 = "contains a line break; the scaffold writes it as one line of .env.example";
const r8 = (v: unknown) => `${shown(v)} is not a finite number; the scaffold writes it into the adapter's code`;
const r9 = 'is not an environment variable name (a letter or "_", then letters, digits or "_"); the scaffold writes it as a key of .env.example';
const scratchDirs: string[] = [];
const marker = () => (globalThis as typeof globalThis & { __N303?: number }).__N303;
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "n303-"));
  scratchDirs.push(dir);
  return dir;
}
afterEach(() => {
  delete (globalThis as typeof globalThis & { __N303?: number }).__N303;
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function content(config: OnboardConfig, path: string): string {
  const file = scaffold({ config }).files.find(f => f.path === path);
  expect(file, path).toBeDefined();
  return file!.content;
}
function parse(text: string, fileName = "n303.ts"): ts.SourceFile {
  const diagnostics = ts.transpileModule(text, {
    fileName, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).diagnostics ?? [];
  expect(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")), fileName).toEqual([]);
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
}
function inspect(text: string, value?: string): void {
  const sf = parse(text);
  let literals = 0;
  const identifiers: string[] = [];
  function visit(node: ts.Node): void {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === value) literals++;
    if (ts.isIdentifier(node) && node.text === "__N303") identifiers.push(node.text);
    ts.forEachChild(node, visit);
  }
  visit(sf);
  expect(identifiers).toEqual([]);
  if (value !== undefined) expect(literals).toBe(1);
}
function writeProject(config: OnboardConfig): string {
  const dir = scratch();
  symlinkSync(join(packageDir, "node_modules"), join(dir, "node_modules"), "junction");
  for (const f of scaffold({ config }).files) {
    const path = join(dir, f.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.content);
  }
  return dir;
}
async function importCapabilities(config: OnboardConfig): Promise<Array<Record<string, unknown>>> {
  const dir = writeProject(config);
  return (await import(join(dir, "src/capabilities.ts"))).capabilities;
}
function diagnostics(config: OnboardConfig): string[] {
  const dir = writeProject(config);
  const path = join(dir, "tsconfig.json");
  const loaded = ts.readConfigFile(path, ts.sys.readFile);
  expect(loaded.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dir);
  expect(parsed.errors).toEqual([]);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return ts.getPreEmitDiagnostics(program).map(d =>
    `${d.file ? relative(dir, d.file.fileName) : ""}|${d.code}|${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
  ).sort();
}
function refusal(config: OnboardConfig, name: string, message: string): void {
  expect(validate({ config }).errors).toContainEqual({ name, message, passed: false, severity: "error" });
  let error: unknown;
  try { scaffold({ config }); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(`${name}: ${message}`);
}
function fieldErrors(config: OnboardConfig, field: string) {
  return validate({ config }).errors.filter(e => e.name.endsWith(`.${field}`));
}
function envKeys(text: string): string[] {
  return text.split(/\r\n|[\r\n\u2028\u2029]/).filter(l => l && !l.startsWith("#")).map(l => l.split("=", 1)[0]);
}
function walkFiles(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? walkFiles(join(dir, e.name), root) : [relative(root, join(dir, e.name))]).sort();
}
function cli(config: OnboardConfig, nested = false) {
  const dir = scratch();
  const cfg = join(dir, "config.json"), out = join(dir, nested ? "a/b/c/out" : "out");
  writeFileSync(cfg, JSON.stringify(config));
  const logs = scratch();
  const stdoutPath = join(logs, "stdout"), stderrPath = join(logs, "stderr");
  const stdout = openSync(stdoutPath, "w"), stderr = openSync(stderrPath, "w");
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "scaffold", "--config", cfg, "--output", out], {
      cwd: packageDir, encoding: "utf8", timeout: 30000, stdio: ["ignore", stdout, stderr],
    });
    expect(result.error).toBeUndefined();
    return { ...result, dir, out, stdout: readFileSync(stdoutPath, "utf8"), stderr: readFileSync(stderrPath, "utf8") };
  } finally {
    closeSync(stdout); closeSync(stderr);
  }
}

// N303: pin names declared at module scope or referenced without a declaration in the file.
function moduleOrFreeNames(text: string): Set<string> {
  const sf = ts.createSourceFile("names.ts", text, ts.ScriptTarget.ES2022, true);
  const declared = new Set<string>(), top = new Set<string>(), refs = new Set<string>();
  function nameOnly(n: ts.Identifier): boolean {
    const p = n.parent;
    return (ts.isPropertyAccessExpression(p) && p.name === n)
      || ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p)
        || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)
        || ts.isEnumMember(p)) && p.name === n)
      || (ts.isQualifiedName(p) && p.right === n)
      || ((ts.isBindingElement(p) || ts.isImportSpecifier(p)) && p.propertyName === n);
  }
  function declaration(n: ts.Identifier): boolean {
    const p = n.parent;
    return (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p)
      || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isTypeParameterDeclaration(p)
      || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isImportSpecifier(p) || ts.isEnumDeclaration(p)
      || ts.isBindingElement(p)) && p.name === n;
  }
  function visit(n: ts.Node): void {
    if (ts.isIdentifier(n)) {
      if (declaration(n)) declared.add(n.text);
      else if (!nameOnly(n)) refs.add(n.text);
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause) {
      const c = st.importClause;
      if (c.name) top.add(c.name.text);
      if (c.namedBindings && ts.isNamedImports(c.namedBindings)) c.namedBindings.elements.forEach(e => top.add(e.name.text));
      if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) top.add(c.namedBindings.name.text);
    } else if (ts.isVariableStatement(st)) {
      st.declarationList.declarations.forEach(d => { if (ts.isIdentifier(d.name)) top.add(d.name.text); });
    } else if ((ts.isClassDeclaration(st) || ts.isFunctionDeclaration(st) || ts.isInterfaceDeclaration(st)
      || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) top.add(st.name.text);
  }
  return new Set([...top, ...[...refs].filter(n => !declared.has(n))]);
}
function fdmExample(): OnboardConfig {
  const c = example(); c.capabilities[0].type = "fdm"; c.profiles = []; return c;
}
function makeValidConfig(): OnboardConfig {
  return {
    kernel: {
      kernelId: "kernel_test_001",
      name: "Test Workshop",
      location: { lat: 37.77, lng: -122.41 },
      walletPrivateKeyEnvVar: "KERNEL_PRIVATE_KEY",
      gatewayUrl: "http://localhost:3200",
      httpPort: 3100,
    },
    adapters: [
      {
        adapterId: "dev-machine-01",
        className: "TestMachine",
        adapterType: "machine",
        protocol: "http",
        connectionString: "http://localhost:8080",
        deviceType: "controller",
        firmwareVersion: "Test-1.0.0",
        endpoints: [
          { method: "GET", path: "/status", purpose: "status", description: "Status" },
          { method: "POST", path: "/start", purpose: "start", description: "Start" },
        ],
      },
      {
        adapterId: "dev-sensor-01",
        className: "TestSensor",
        adapterType: "sensor",
        protocol: "http",
        connectionString: "http://localhost:9090",
        deviceType: "sensor",
        firmwareVersion: "Sensor-1.0.0",
      },
    ],
    capabilities: [
      {
        type: "fdm",
        name: "Test Printer",
        materials: ["pla", "petg"],
        assuranceTiers: [0, 1],
        pricing: {
          currency: "USDC",
          baseCost: "5.00",
          perMinute: "0.10",
          minimum: "10.00",
        },
        adapterId: "dev-machine-01",
      },
    ],
  };
}

function machineConfig(type: OnboardConfig["capabilities"][number]["type"] = "liquid-handler"): OnboardConfig {
  return {
    kernel: {
      kernelId: "kernel_neutral_test", name: "Neutral Lab", location: { lat: 0, lng: 0 },
      walletPrivateKeyEnvVar: "TEST_KERNEL_KEY", gatewayUrl: "http://gateway.test", httpPort: 3100,
    },
    adapters: [{
      adapterId: "dev-liquid-01", className: "LiquidAdapter", adapterType: "machine", protocol: "http",
      connectionString: "http://device.test", deviceType: "controller", firmwareVersion: "Test-1.0.0",
      endpoints: [
        { method: "GET", path: "/status", purpose: "status", description: "Status" },
        { method: "POST", path: "/stage", purpose: "load_program", description: "Stage input without actuation" },
        { method: "POST", path: "/run", purpose: "start", description: "Run staged input" },
        { method: "POST", path: "/halt", purpose: "stop", description: "Stop" },
      ],
    }],
    capabilities: [{
      type, name: "Liquid handling", materials: ["water"], assuranceTiers: [0, 1, 2],
      pricing: { currency: "USDC", baseCost: "1.00", perMinute: "0.10", minimum: "1.00" },
      adapterId: "dev-liquid-01",
    }],
  };
}

function sensorConfig(): OnboardConfig {
  return {
    kernel: { kernelId: "kernel-q", name: "Q", location: { lat: 0, lng: 0 }, walletPrivateKeyEnvVar: "K", gatewayUrl: "http://gw.test", httpPort: 3100 },
    adapters: [{ adapterId: "dev-sensor-q", className: "QSensor", adapterType: "sensor", protocol: "http", connectionString: "http://device.test", deviceType: "sensor", firmwareVersion: "Q-1.0.0" }],
    capabilities: [],
  };
}

const PINS = [
  {
    "files": [
      [
        "package.json",
        "22327118dcf0db7ad899c47dd5908a39cdd4f3e612bebd97fc8b479090780d2b"
      ],
      [
        "tsconfig.json",
        "4cd82f8ff23ebb36beccc46210cb6a8e2ae1081af2af2348e7fa2095f29dac50"
      ],
      [
        "src/adapters/haas-vf2-adapter.ts",
        "7aed06e6a16ab07cf1b98da5df2f354f15f468be6ed46f15883520da6c7e8fcb"
      ],
      [
        "src/adapters/shop-power-meter.ts",
        "c7735c93ac12741c4c9cd618aaecf1d0493e60dbe27660c3fdd0963ad22b08f0"
      ],
      [
        "src/adapters/qc-camera.ts",
        "96d4994bae8713a76f447dda3463f7a9ded44b40882f3cbc4092d11fcc7ed6fe"
      ],
      [
        "src/capabilities.ts",
        "d0fd68a08af61805cc75c37a81f3ceb0629b3c914147272c27738c301472a97f"
      ],
      [
        "src/kernel.ts",
        "7f48dffed66251d41813eaa7ee84a1f60873cd6e0777adb1c4fa4d063012b516"
      ],
      [
        "src/agent.ts",
        "82cac4a8f3d4be9db774523c9acfaffd8c9cd6d3a6625e9d4e18a0fa5a725662"
      ],
      [
        ".env.example",
        "1b83258b1752d443d1f04f4ec0d2aa8bd57eb4b6965c0f79c6635a14f61716a3"
      ],
      [
        "src/profiles.ts",
        "e3d662a87e52a2a97663cfb8ba3480ff287fb736fbc27e420ae87119ad0a8f3d"
      ],
      [
        "src/__tests__/adapters.test.ts",
        "b9559e1f12b7c79aaafb27a074672404e7426660c6ab9b9dd84250a46e42f9ba"
      ]
    ],
    "scaffold": "1873cb270f3c5b5ade8092c0b848c7067fd1b8a5b949545f6797262ce5dddd2c",
    "validate": "e55c734ef13a7eb4c39ccf8f32ae9be1a9e066d0af90175680945edf4c962382"
  },
  {
    "files": [
      [
        "package.json",
        "09003c254efb3fb475ff835e811ab91b376ef57cfc1f29a65141335cfea11d3a"
      ],
      [
        "tsconfig.json",
        "4cd82f8ff23ebb36beccc46210cb6a8e2ae1081af2af2348e7fa2095f29dac50"
      ],
      [
        "src/adapters/test-machine.ts",
        "ada2506957f9b3971d07d9e90826a05040c64083b686ee456da3a4b12e976f21"
      ],
      [
        "src/adapters/test-sensor.ts",
        "e009eae7087bf0cf9e3bdb1d81185948bd3b6b191ea168653dcb3570fd572e96"
      ],
      [
        "src/capabilities.ts",
        "276ba6b6f3ac3b2579856ba8ad53242978f8574f6d11f04b60e18441f0295c5c"
      ],
      [
        "src/kernel.ts",
        "fce1b956c098d576b8963a9cd629a8d47a483f863975dce0345c53f17689d234"
      ],
      [
        "src/agent.ts",
        "0e3a45ddace1406799c97458d3bba51287df50ed38ddf1fc5b0687920cde17b9"
      ],
      [
        ".env.example",
        "963e1e266210f425233692720039f38ecb7ce250edea76d409dfbc9962fc01a7"
      ],
      [
        "src/__tests__/adapters.test.ts",
        "94c55fb9f6fbf0b8f2c2d66f583c66bc26ec5bd74e3cce4c7687f8f36518aec1"
      ]
    ],
    "scaffold": "2d57bdf03f11b285be04fa1e3478c2d0c29e76bfc8ae0f3fe4901048ffdd1bf0",
    "validate": "13c64d886b91dbf3e50b2e56e91a26ee4f4b3b2e6309541c1ff8b246920dab29"
  },
  {
    "files": [
      [
        "package.json",
        "8f2f85b1769550aee7962c7861a39226ecc1b87fb412bacde688b64ee4cc6ce1"
      ],
      [
        "tsconfig.json",
        "4cd82f8ff23ebb36beccc46210cb6a8e2ae1081af2af2348e7fa2095f29dac50"
      ],
      [
        "src/adapters/liquid-adapter.ts",
        "bffc11342e1b0005c9a84c904a790b3e5c9405297a39285ae421e02a35ae4245"
      ],
      [
        "src/capabilities.ts",
        "4705b4f84f17daab8f0a68ed31207426e3bffbc07180aad8deef20b2dc8bad00"
      ],
      [
        "src/kernel.ts",
        "fd6ab38b119e7f4a26c4b9d0e519cb4563cfb4dcdc74d4c8e2c2b7bb1e4ae2db"
      ],
      [
        "src/agent.ts",
        "f664612e2ee0e37636fd83244aea9a2b1c211c7f9f23bba60db84da194608c66"
      ],
      [
        ".env.example",
        "9eb2c158a870762e212e9da9a3827c9929d908cd11cdc872c839ad70a7d1d46e"
      ],
      [
        "src/__tests__/adapters.test.ts",
        "678d506a5aad6fd913bf4ee0a68d296f239583699f54a46041e1f47bd5a7d7ed"
      ]
    ],
    "scaffold": "3d7a6f1b0f57253127bfb1d43021ea9f9d78def061c007a196dadc081c20f0c6",
    "validate": "10408f7843be1c86f93d84af30247e0aa5d3a540c20239f7f7f003947e208188"
  },
  {
    "files": [
      [
        "package.json",
        "8f2f85b1769550aee7962c7861a39226ecc1b87fb412bacde688b64ee4cc6ce1"
      ],
      [
        "tsconfig.json",
        "4cd82f8ff23ebb36beccc46210cb6a8e2ae1081af2af2348e7fa2095f29dac50"
      ],
      [
        "src/adapters/liquid-adapter.ts",
        "736d118d54fd35cc455520665574e51fab6926c6eb9aa752d46cce056821d6c6"
      ],
      [
        "src/capabilities.ts",
        "f17ba04b0e81275dcfe9664fbfd1a1ba551cadc56d286272e956bb9df5e5b07a"
      ],
      [
        "src/kernel.ts",
        "ba38f4974134e4b8d516388615b0eaa9ee1090ff9fd5155402dd4193dffcef00"
      ],
      [
        "src/agent.ts",
        "f664612e2ee0e37636fd83244aea9a2b1c211c7f9f23bba60db84da194608c66"
      ],
      [
        ".env.example",
        "9eb2c158a870762e212e9da9a3827c9929d908cd11cdc872c839ad70a7d1d46e"
      ],
      [
        "src/__tests__/adapters.test.ts",
        "07b3f348e9fce0352c4bca1774f22e7a3a8c8cf65b2baf59d487597556fe73c9"
      ]
    ],
    "scaffold": "654e4c8237ec7179d58cb49be3ae2ab56e7d62a4deed1f6f03cf8273381af8f4",
    "validate": "4e93e8d07be96dab574ec872e686395f8fd7b3d2d175bc34453fd6c87b5af455"
  },
  {
    "files": [
      [
        "package.json",
        "9746d6f7c041826a74428b86984b1446ebaa4b2924814b15ca66e046ed37d9aa"
      ],
      [
        "tsconfig.json",
        "4cd82f8ff23ebb36beccc46210cb6a8e2ae1081af2af2348e7fa2095f29dac50"
      ],
      [
        "src/adapters/q-sensor.ts",
        "dfbfc5146f34b282d2584a1af4718f58d766b0283d5224de582852cb9bc2861d"
      ],
      [
        "src/capabilities.ts",
        "cb7216d4b983fe2ca07e245fc5136fed05a894bb1436c94302839be0e577f74d"
      ],
      [
        "src/kernel.ts",
        "5101dcf8ebd7400cb03140817e4097b2c68c893945395388f935a594643f6262"
      ],
      [
        "src/agent.ts",
        "ad153a91663f9ca8353036ba99d32f96b9a5edd79328f76a11023500c553e7a5"
      ],
      [
        ".env.example",
        "e66da26b10e9923a18a437a135ec6ca15a9e8363e563e521264d81a0fc98a751"
      ],
      [
        "src/__tests__/adapters.test.ts",
        "42794155a59877959c140673303cf0beb159af4c4c7de4537f57369d841b8a7f"
      ]
    ],
    "scaffold": "7cf0777f0b27fb54fd4b03c145a607af8c8c5c5e8a191bd452b24ca44821e73f",
    "validate": "cbfa22c3fc1691df15afd475575248483c0197e0919744f8a83611bf252dfc4f"
  }
];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

describe("N303 scaffold literals and identifier rules", () => {
  it("SL1 quoted capability name stays one literal through import and typecheck", async () => {
    const config = example(); config.capabilities[0].name = QUOTED;
    expect(validate({ config }).valid).toBe(true);
    for (const f of scaffold({ config }).files.filter(f => f.path.endsWith(".ts"))) parse(f.content, f.path);
    inspect(content(config, "src/capabilities.ts"), QUOTED);
    expect((await importCapabilities(config))[0].name).toBe(QUOTED);
    expect(diagnostics(config)).toEqual(diagnostics(example()));
  }, 30000);
  it("SL1b control characters stay one literal", () => {
    const config = example(); config.capabilities[0].name = CONTROL;
    inspect(content(config, "src/capabilities.ts"), CONTROL);
  });
  it("SL2 capability name preserves text and object keys on import", async () => {
    const keys = Object.keys((await importCapabilities(example()))[0]).sort();
    expect(keys).toHaveLength(12);
    for (const name of [CRAFTED, CRAFTED2]) {
      const config = example(); config.capabilities[0].name = name;
      const caps = await importCapabilities(config);
      expect(marker()).toBeUndefined();
      expect(caps[0].name).toBe(name);
      expect(Object.keys(caps[0]).sort()).toEqual(keys);
    }
  });

  const machinePath = "src/adapters/haas-vf2-adapter.ts";
  const rows: Array<[string, string, string, (c: OnboardConfig) => void]> = [
    ["A1", "machine device type", machinePath, c => { c.adapters[0].deviceType = H as never; }],
    ["A2", "machine kernel id", machinePath, c => { c.kernel.kernelId = H; }],
    ["A3", "machine firmware", machinePath, c => { c.adapters[0].firmwareVersion = H; }],
    ["A4", "status path", machinePath, c => { c.adapters[0].endpoints!.find(e => e.purpose === "status")!.path = H; }],
    ["A5", "progress path", machinePath, c => { c.adapters[0].endpoints!.find(e => e.purpose === "progress")!.path = H; }],
    ["A6", "fdm load path", machinePath, c => { c.capabilities[0].type = "fdm"; c.profiles = []; c.adapters[0].endpoints!.find(e => e.purpose === "load_program")!.path = H; }],
    ["A7", "prepare path", machinePath, c => { c.adapters[0].endpoints!.find(e => e.purpose === "load_program")!.path = H; }],
    ["A8", "start path", machinePath, c => { c.adapters[0].endpoints!.find(e => e.purpose === "start")!.path = H; }],
    ["A9", "stop path", machinePath, c => { c.adapters[0].endpoints!.find(e => e.purpose === "stop")!.path = H; }],
    ["S1", "sensor kernel id", "src/adapters/shop-power-meter.ts", c => { c.kernel.kernelId = H; }],
    ["S2", "sensor firmware", "src/adapters/shop-power-meter.ts", c => { c.adapters[1].firmwareVersion = H; }],
    ["C1", "camera kernel id", "src/adapters/qc-camera.ts", c => { c.kernel.kernelId = H; }],
    ["C2", "camera firmware", "src/adapters/qc-camera.ts", c => { c.adapters[2].firmwareVersion = H; }],
    ["P1", "capabilities kernel id", "src/capabilities.ts", c => { c.kernel.kernelId = H; }],
    ["P2", "capability type", "src/capabilities.ts", c => { c.capabilities[0].type = H as never; }],
    ["P3", "capability name", "src/capabilities.ts", c => { c.capabilities[0].name = H; }],
    ["P4", "description", "src/capabilities.ts", c => { c.capabilities[0].description = H; }],
    ["K1", "kernel entry id", "src/kernel.ts", c => { c.kernel.kernelId = H; }],
    ["K2", "machine connection", "src/kernel.ts", c => { c.adapters[0].connectionString = H; }],
    ["K3", "sensor connection", "src/kernel.ts", c => { c.adapters[1].connectionString = H; }],
    ["K4", "camera connection", "src/kernel.ts", c => { c.adapters[2].connectionString = H; }],
    ["G1", "agent kernel id", "src/agent.ts", c => { c.kernel.kernelId = H; }],
    ["G2", "gateway", "src/agent.ts", c => { c.kernel.gatewayUrl = H; }],
    ["G3", "kernel name", "src/agent.ts", c => { c.kernel.name = H; }],
    ["F1", "profile id", "src/profiles.ts", c => { c.profiles![0].profileId = H; }],
    ["F2", "profile name", "src/profiles.ts", c => { c.profiles![0].profileName = H; }],
    ["F3", "profile kernel id", "src/profiles.ts", c => { c.kernel.kernelId = H; }],
    ["F4", "profile capability type", "src/profiles.ts", c => { c.profiles![0].capabilityType = H as never; }],
  ];
  for (const [id, label, path, set] of rows) {
    it(`SL2-${id} ${label} is one JSON string literal`, () => {
      const config = example(); set(config); inspect(content(config, path), H);
    });
  }
  for (const [id, path] of [["M1", "src/kernel.ts"], ["M2", "src/agent.ts"], ["M3", ".env.example"]]) {
    it(`SL3-${id} kernel name stays in its comment`, () => {
      for (const lineBreak of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
        const value = `a */ (globalThis.__N303 = 1); /* b${lineBreak}EXTRA=1`;
        const config = example(); config.kernel.name = value;
        const text = content(config, path);
        expect(text).toContain(comment(value));
        if (id === "M3") {
          expect(text.split("\n")[0]).toBe(`# ${comment(value)} — Environment Variables`);
          expect(envKeys(text)).toEqual(envKeys(content(example(), path)));
        } else inspect(text, id === "M2" ? value : undefined);
      }
    });
  }
  it("SL3-M4 protocol stays in its comment", () => {
    const config = example(); config.adapters[0].protocol = HC as never;
    const text = content(config, machinePath);
    expect(text).toContain(comment(HC)); inspect(text);
  });
  it("SL4a poll interval follows the finite number rule", () => {
    for (const value of [POLL, "2000", true, {}, [], NaN, Infinity, -Infinity]) {
      const config = example(); config.adapters[0].pollIntervalMs = value as never;
      refusal(config, "adapter[dev-haas-vf2].pollIntervalMs", r8(value));
    }
  });
  it("SL4b numeric and default poll intervals keep their text", () => {
    for (const value of [1500, undefined, null]) {
      const config = example(); config.adapters[0].pollIntervalMs = value as never;
      const text = content(config, machinePath);
      expect(text).toContain(`/** Poll interval in ms (default ${value ?? 2000}) */`);
      expect(text).toContain(`}, this.config.pollIntervalMs ?? ${value ?? 2000});`);
      expect(fieldErrors(config, "pollIntervalMs")).toEqual([]);
    }
  });
  const envFields: Array<[string, string, (c: OnboardConfig, v: unknown) => void]> = [
    ["a", "kernel.walletPrivateKeyEnvVar", (c, v) => { c.kernel.walletPrivateKeyEnvVar = v as never; }],
    ["b", "kernel.gatewayUrl", (c, v) => { c.kernel.gatewayUrl = v as never; }],
    ["c", "adapter[dev-haas-vf2].connectionString", (c, v) => { c.adapters[0].connectionString = v as never; }],
  ];
  for (const [id, name, set] of envFields) {
    it(`SL5${id} ${name} is one environment line`, () => {
      for (const lineBreak of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
        const text = `prefix${lineBreak}EXTRA=1`;
        for (const value of [text, [text], [[text]]]) {
          const config = example(); set(config, value);
          refusal(config, name, r7);
          if (id === "a") expect(validate({ config }).errors.filter(e => e.name === name)).toEqual([
            { name, message: r7, passed: false, severity: "error" },
          ]);
        }
        const config = example(); set(config, id === "a" ? "prefixEXTRA_1" : "prefixEXTRA=1");
        expect(validate({ config }).errors.filter(e => e.name === name)).toEqual([]);
        expect(() => scaffold({ config })).not.toThrow();
      }
    });
  }
  it("SL5d walletPrivateKeyEnvVar is an environment variable name", () => {
    for (const value of ["NODE_OPTIONS=--require ./x.js #", "prefixEXTRA=1", "", "9KEY", "KEY-NAME", "KEY NAME", "KEY.NAME", "KÉY", 7, true, {}, { toString: 1 }, ["KERNEL_PRIVATE_KEY"]]) {
      const config = example(); config.kernel.walletPrivateKeyEnvVar = value as never;
      refusal(config, "kernel.walletPrivateKeyEnvVar", r9);
    }
    for (const value of ["KERNEL_PRIVATE_KEY", "TEST_KERNEL_KEY", "K", "_KEY", "key1", undefined, null]) {
      const config = example();
      if (value === undefined) Reflect.deleteProperty(config.kernel, "walletPrivateKeyEnvVar");
      else config.kernel.walletPrivateKeyEnvVar = value as never;
      expect(fieldErrors(config, "walletPrivateKeyEnvVar")).toEqual([]);
      expect(() => scaffold({ config })).not.toThrow();
      if (typeof value === "string") expect(content(config, ".env.example").split("\n")).toContain(`${value}=0x_YOUR_PRIVATE_KEY_HERE`);
    }
  });
  it("SL6a accepted class names keep portable file names", () => {
    for (const name of ["HaasVF2Adapter", "ShopPowerMeter", "QCCamera", "LiquidAdapter", "TestMachine", "TestSensor", "QSensor", "PrinterAdapter", "A", "A" + "b".repeat(63)]) {
      const config = sensorConfig(); config.adapters[0].className = name;
      expect(fieldErrors(config, "className"), name).toEqual([]);
      const f = scaffold({ config }).files.find(f => f.path.startsWith("src/adapters/"))!;
      expect(f.path).toMatch(/^src\/adapters\/[a-z0-9]+(?:-[a-z0-9]+)*\.ts$/); parse(f.content);
    }
  });
  it("SL6b class names follow the PascalCase rule in both entry points", () => {
    for (const name of ["", "foo", "fooBar", "Foo-Bar", "Foo Bar", "Foo_Bar", "Foo$", "9Foo", "Foo.Bar", "../../Evil", "Gerät", "A" + "b".repeat(64), 'Foo"Bar', "Foo\nBar", "Foo\n", "Foo\r", "Foo\u2028", "Foo\u2029", 42]) {
      const config = sensorConfig(); config.adapters[0].className = name as never;
      refusal(config, "adapter[dev-sensor-q].className", r1(name));
    }
  });
  it("SL6c class names differ from names the generated files use", () => {
    for (const name of CLASS_NAMES) {
      const config = example(); config.adapters[2].className = name;
      refusal(config, "adapter[dev-qc-camera].className", r2(name));
    }
  });
  it("SL6d class name list covers the generated declarations and globals", () => {
    for (const config of [example(), fdmExample()]) {
      const own = new Set(config.adapters.flatMap(a => [a.className, `${a.className}Config`]));
      for (const f of scaffold({ config }).files.filter(f => f.path.startsWith("src/adapters/") || f.path === "src/kernel.ts" || f.path === "src/__tests__/adapters.test.ts")) {
        for (const name of moduleOrFreeNames(f.content)) {
          if (/^[A-Z][A-Za-z0-9]*$/.test(name) && !own.has(name)) expect(CLASS_NAMES, `${f.path}: ${name}`).toContain(name);
        }
      }
    }
  });
  it("SL6e later class names make distinct adapter files", () => {
    for (const [index, name, other] of [[1, "HaasVf2Adapter", "dev-haas-vf2"], [2, "ShopPowerMeter", "dev-power-meter"]] as const) {
      const config = example(); config.adapters[index].className = name;
      refusal(config, `adapter[${config.adapters[index].adapterId}].className`, `${shown(name)} makes the file src/adapters/${kebab(name)}.ts, which adapter[${other}] also makes`);
    }
  });
  it("SL6f class names make files allowed on Windows", () => {
    for (const name of [...WINDOWS_DEVICE_NAMES.map(n => n[0].toUpperCase() + n.slice(1)), "CON"]) {
      const config = sensorConfig(); config.adapters[0].className = name;
      refusal(config, "adapter[dev-sensor-q].className", `${shown(name)} makes the file src/adapters/${kebab(name)}.ts, a reserved device name on Windows`);
    }
  });
  it("SL7a accepted adapter ids keep variable and environment names", () => {
    for (const id of ["dev-haas-vf2", "dev-power-meter", "dev-qc-camera", "dev-liquid-01", "dev-printer-02", "dev-sensor-q", "dev-machine-01", "dev-sensor-01", "a", "dev_haas_vf2", "Dev1", "x".repeat(64)]) {
      const config = sensorConfig(); config.adapters[0].adapterId = id;
      expect(fieldErrors(config, "adapterId"), id).toEqual([]);
      const text = content(config, "src/kernel.ts");
      expect(text).toContain(`const ${camel(id)} =`); expect(text).toContain(`process.env.${envName(id)}_URL`); parse(text);
    }
  });
  it("SL7b adapter ids follow the identifier rule", () => {
    for (const id of ["", "01-power", "-dev", "dev-", "dev--x", "dev_-x", "dev.haas", "dev:1", "dev haas", "dev$1", "dév", "x".repeat(65), 'dev"1', "dev\n1", "dev\n", "dev\r", "dev\u2028", "dev\u2029", 7]) {
      const config = sensorConfig(); config.adapters[0].adapterId = id as never;
      refusal(config, `adapter[${id}].adapterId`, r4(id));
    }
  });
  it("SL7c adapter variables differ from reserved and class names", () => {
    for (const id of VARIABLE_NAMES) {
      const config = sensorConfig(); config.adapters[0].adapterId = id;
      refusal(config, `adapter[${id}].adapterId`, r5variable(id));
    }
    const config = example(); config.adapters[1].adapterId = "Shop-Power-Meter";
    refusal(config, "adapter[Shop-Power-Meter].adapterId", '"Shop-Power-Meter" makes the variable ShopPowerMeter, which is the class name of adapter[Shop-Power-Meter]');
  });
  it("SL7d later adapter ids make distinct variables and environment names", () => {
    const config = example(); config.adapters[2].adapterId = "dev_power_meter";
    refusal(config, "adapter[dev_power_meter].adapterId", '"dev_power_meter" makes the variable devPowerMeter, which adapter[dev-power-meter] also makes');
    config.adapters[1].adapterId = "dev-power"; config.adapters[2].adapterId = "Dev-Power";
    refusal(config, "adapter[Dev-Power].adapterId", '"Dev-Power" makes the environment variable DEV_POWER_URL, which adapter[dev-power] also makes');
  });
  it("SL7e adapter environment names differ from existing definitions", () => {
    const config = example(); config.adapters[1].adapterId = "gateway";
    refusal(config, "adapter[gateway].adapterId", r5env("gateway", "GATEWAY_URL"));
    config.adapters[1].adapterId = "dev-power-meter"; config.kernel.walletPrivateKeyEnvVar = "DEV_HAAS_VF2_URL";
    refusal(config, "adapter[dev-haas-vf2].adapterId", r5env("dev-haas-vf2", "DEV_HAAS_VF2_URL"));
    for (const value of ["DEV_HAAS_VF2_API_KEY", ["DEV_HAAS_VF2_API_KEY"], ["DEV_HAAS_VF2_URL"]]) {
      config.kernel.walletPrivateKeyEnvVar = value as never;
      refusal(config, "adapter[dev-haas-vf2].adapterId", r5env("dev-haas-vf2", String(value)));
    }
  });
  it("SL7f variable name list covers the generated kernel declarations and globals", () => {
    for (const config of [example(), fdmExample()]) {
      const own = new Set(config.adapters.flatMap(a => [a.className, camel(a.adapterId)]));
      for (const name of moduleOrFreeNames(content(config, "src/kernel.ts"))) {
        if (/^[A-Za-z][A-Za-z0-9]*$/.test(name) && !own.has(name)) expect(VARIABLE_NAMES, name).toContain(name);
      }
    }
  });
  it("SL7g adapter ids make no API key name other software reads", () => {
    for (const id of [...API_KEY_STEMS.map(stem => stem.toLowerCase().replace(/_/g, "-")), "OpenAI"]) {
      const config = sensorConfig(); config.adapters[0].adapterId = id;
      refusal(config, `adapter[${id}].adapterId`, r5api(id));
    }
    const config = example(); config.adapters[0].adapterId = "openai";
    refusal(config, "adapter[openai].adapterId", r5api("openai"));
    for (const id of ["openai-sim", "pcc-node", "ot2", "trilobio", "clip", "lit-sensor"]) {
      const config = sensorConfig(); config.adapters[0].adapterId = id;
      expect(fieldErrors(config, "adapterId"), id).toEqual([]);
    }
  });
  it("SL8a CLI reports the class name rule before writing files", () => {
    const config = example(); config.adapters[0].className = "Foo-Bar";
    const result = cli(config);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Configuration validation failed:");
    expect(result.stderr).toContain(`  ✗ adapter[dev-haas-vf2].className: ${r1("Foo-Bar")}`);
    expect(walkFiles(result.dir)).toEqual(["config.json"]);
  });
  it("SL8b CLI refuses a class name with path separators", () => {
    const config = example(); config.adapters[0].className = "../../../Evil";
    const result = cli(config, true);
    expect(result.status).toBe(1); expect(walkFiles(result.dir)).toEqual(["config.json"]);
  });
  it("SL8c CLI writes the example files with their pinned hashes", () => {
    const result = cli(example()); expect(result.status).toBe(0);
    expect(walkFiles(result.out)).toEqual(PINS[0].files.map(([path]) => path).sort());
    for (const [path, digest] of PINS[0].files) expect(hash(readFileSync(join(result.out, path), "utf8")), path).toBe(digest);
  });
  const fixtures: Array<[string, () => OnboardConfig]> = [
    ["example", example], ["makeValidConfig", makeValidConfig], ["machineConfig", () => machineConfig()],
    ["machineConfig fdm", () => machineConfig("fdm")], ["sensor config", sensorConfig],
  ];
  for (const [index, [label, fixture]] of fixtures.entries()) {
    it(`SL9 ${label} keeps file and summary bytes`, () => {
      const config = fixture(), result = scaffold({ config });
      expect(result.files.map(f => [f.path, hash(f.content)])).toEqual(PINS[index].files);
      expect(hash(result.summary)).toBe(PINS[index].scaffold);
      expect(hash(validate({ config }).summary)).toBe(PINS[index].validate);
    });
  }
});
