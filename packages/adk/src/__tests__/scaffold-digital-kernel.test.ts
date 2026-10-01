import { describe, it, expect } from "vitest";
import ts from "typescript";
import {
  ScaffoldRefused,
  scaffoldDigitalKernel,
  type DigitalKernelScaffoldOptions,
} from "../scaffold/digital-kernel.js";

const ADDR = "0x" + "ab".repeat(20);

function baseOptions(): DigitalKernelScaffoldOptions {
  return {
    projectName: "acme-temp-converter",
    kernelId: "k8-temp-converter-acme",
    name: "Acme Temperature Converter",
    description: "Converts Celsius to Fahrenheit with a signed evidence trail.",
    capabilityType: "temperature-converter",
    builder: {
      agentId: "eip155:84532:" + ADDR,
      contactURI: "mailto:builder@acme.example",
      walletAddress: ADDR,
    },
    pricing: { baseUSD: 0.001 },
    maxAssuranceTier: 1,
    workflowSteps: [
      { stepId: "parse-input", stepType: "validate", description: "Validate the Celsius input", dependsOn: [] },
      { stepId: "convert", stepType: "transform", description: "Apply F = C*9/5 + 32", dependsOn: ["parse-input"] },
    ],
    search: {
      source: "capabilities.search",
      query: "temperature converter",
      at: "2026-01-01T00:00:00.000Z",
      resultCount: 2,
      resultIds: ["cap-1", "cap-2"],
    },
    versions: { spec: "^0.1.0", kernelSdk: "^0.1.0" },
  };
}

/** Runs fn, expects a ScaffoldRefused, and returns its message. Rethrows anything else. */
function refusalOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ScaffoldRefused) return e.message;
    throw e;
  }
  throw new Error("expected scaffoldDigitalKernel to throw ScaffoldRefused, but it did not throw");
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("scaffoldDigitalKernel: happy path", () => {
  it("returns exactly the declared file set", () => {
    const { files } = scaffoldDigitalKernel(baseOptions());
    expect(Object.keys(files).sort()).toEqual(
      [
        ".gitignore",
        "README.md",
        "package.json",
        "pcc-project.json",
        "src/execute.ts",
        "src/index.ts",
        "src/keys.ts",
        "src/manifest.ts",
        "src/register.ts",
        "tsconfig.json",
      ].sort(),
    );
  });

  it("declares exactly the three runtime dependencies, and nothing else at the top level", () => {
    const { files } = scaffoldDigitalKernel(baseOptions());
    const pkg = JSON.parse(files["package.json"]);
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@pcc/kernel-sdk", "@pcc/spec", "tweetnacl"]);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(["@types/node", "typescript"]);
    expect(pkg.name).toBe("acme-temp-converter");
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe("module");
    expect(pkg.scripts).toEqual({
      build: "tsc",
      "dry-run": "node dist/index.js --dry-run",
      register: "node dist/register.js",
    });
    // "Keys are sorted."
    expect(Object.keys(pkg)).toEqual([...Object.keys(pkg)].sort());
  });

  it("never contains a workspace: reference in any generated file", () => {
    const { files } = scaffoldDigitalKernel(baseOptions());
    for (const [path, content] of Object.entries(files)) {
      expect(content, `${path} should not reference workspace:`).not.toContain("workspace:");
    }
  });

  it("is byte-identical across two calls with the same input, regardless of key order in the input", () => {
    const opts = baseOptions();
    const a = scaffoldDigitalKernel(opts);

    const reordered: DigitalKernelScaffoldOptions = {
      versions: opts.versions,
      search: opts.search,
      workflowSteps: opts.workflowSteps,
      maxAssuranceTier: opts.maxAssuranceTier,
      pricing: opts.pricing,
      builder: { walletAddress: opts.builder.walletAddress, contactURI: opts.builder.contactURI, agentId: opts.builder.agentId },
      capabilityType: opts.capabilityType,
      description: opts.description,
      name: opts.name,
      kernelId: opts.kernelId,
      projectName: opts.projectName,
    };
    const b = scaffoldDigitalKernel(reordered);

    expect(Object.keys(b.files).sort()).toEqual(Object.keys(a.files).sort());
    for (const path of Object.keys(a.files)) {
      expect(b.files[path]).toBe(a.files[path]);
    }
  });

  it("round-trips pcc-project.json with only the declared fields", () => {
    const { files } = scaffoldDigitalKernel(baseOptions());
    const doc = JSON.parse(files["pcc-project.json"]);
    expect(doc).toEqual({
      schema: "pcc-adk/digital-kernel-project@1",
      kernelId: "k8-temp-converter-acme",
      capabilityType: "temperature-converter",
      declaredTerms: { pricing: { baseUSD: 0.001 }, maxAssuranceTier: 1 },
      search: {
        source: "capabilities.search",
        query: "temperature converter",
        at: "2026-01-01T00:00:00.000Z",
        resultCount: 2,
        resultIds: ["cap-1", "cap-2"],
      },
      generatedBy: "@pcc/adk",
    });
  });

  it("gitignores node_modules, dist, and .pcc", () => {
    const { files } = scaffoldDigitalKernel(baseOptions());
    expect(files[".gitignore"]).toBe("node_modules/\ndist/\n.pcc/\n");
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("scaffoldDigitalKernel: refusals", () => {
  it("refuses a missing pricing", () => {
    const opts = baseOptions() as Record<string, unknown>;
    delete opts.pricing;
    expect(refusalOf(() => scaffoldDigitalKernel(opts as unknown as DigitalKernelScaffoldOptions))).toMatch(/^pricing: is required .*no default/);
  });

  it("refuses a missing maxAssuranceTier", () => {
    const opts = baseOptions() as Record<string, unknown>;
    delete opts.maxAssuranceTier;
    // The refusal must SAY there is no default, not only fail a range check.
    expect(refusalOf(() => scaffoldDigitalKernel(opts as unknown as DigitalKernelScaffoldOptions))).toMatch(
      /^maxAssuranceTier: is required .*no default/,
    );
  });

  it("refuses a missing search", () => {
    const opts = baseOptions() as Record<string, unknown>;
    delete opts.search;
    expect(refusalOf(() => scaffoldDigitalKernel(opts as unknown as DigitalKernelScaffoldOptions))).toMatch(/^search: is required .*no default/);
  });

  it("refuses missing versions", () => {
    const opts = baseOptions() as Record<string, unknown>;
    delete opts.versions;
    expect(refusalOf(() => scaffoldDigitalKernel(opts as unknown as DigitalKernelScaffoldOptions))).toMatch(/^versions:/);
  });

  it.each(["workspace:*", "file:../x", "link:../x", "portal:../x"])(
    "refuses %s in versions.kernelSdk",
    (bad) => {
      const opts = baseOptions();
      opts.versions.kernelSdk = bad;
      expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^versions\.kernelSdk:/);
    },
  );

  it.each(["workspace:*", "file:../x", "link:../x", "portal:../x"])("refuses %s in versions.spec", (bad) => {
    const opts = baseOptions();
    opts.versions.spec = bad;
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^versions\.spec:/);
  });

  it("refuses a duplicate stepId", () => {
    const opts = baseOptions();
    opts.workflowSteps = [
      { stepId: "a", stepType: "transform", description: "first", dependsOn: [] },
      { stepId: "a", stepType: "transform", description: "second", dependsOn: [] },
    ];
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/stepId/);
  });

  it("refuses dependsOn naming a later step", () => {
    const opts = baseOptions();
    opts.workflowSteps = [
      { stepId: "a", stepType: "transform", description: "first", dependsOn: ["b"] },
      { stepId: "b", stepType: "transform", description: "second", dependsOn: [] },
    ];
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/dependsOn/);
  });

  it("refuses dependsOn naming an unknown step", () => {
    const opts = baseOptions();
    opts.workflowSteps = [{ stepId: "a", stepType: "transform", description: "first", dependsOn: ["ghost"] }];
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/dependsOn/);
  });

  it("refuses a step depending on itself", () => {
    const opts = baseOptions();
    opts.workflowSteps = [{ stepId: "a", stepType: "transform", description: "first", dependsOn: ["a"] }];
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/dependsOn/);
  });

  it("refuses resultIds longer than resultCount", () => {
    const opts = baseOptions();
    opts.search.resultCount = 1;
    opts.search.resultIds = ["a", "b"];
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/resultIds/);
  });

  it("refuses a bad timestamp", () => {
    const opts = baseOptions();
    opts.search.at = "not-a-timestamp";
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^search\.at:/);
  });

  it("refuses a date-only (non ISO-8601-UTC) timestamp", () => {
    const opts = baseOptions();
    opts.search.at = "2026-01-01";
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^search\.at:/);
  });

  it.each([1.5, 4, -1, 3.0001])("refuses a non-integer or out-of-range tier (%s)", (tier) => {
    const opts = baseOptions();
    (opts as unknown as { maxAssuranceTier: number }).maxAssuranceTier = tier;
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^maxAssuranceTier:/);
  });

  it("refuses a malformed projectName", () => {
    const opts = baseOptions();
    opts.projectName = "Not Npm Safe!";
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^projectName:/);
  });

  it("refuses a malformed kernelId", () => {
    const opts = baseOptions();
    opts.kernelId = "AB";
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^kernelId:/);
  });

  it("refuses a malformed capabilityType", () => {
    const opts = baseOptions();
    opts.capabilityType = "Bad_Type!";
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^capabilityType:/);
  });

  it("refuses an empty name", () => {
    const opts = baseOptions();
    opts.name = "";
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^name:/);
  });

  it("refuses a name over 120 characters", () => {
    const opts = baseOptions();
    opts.name = "x".repeat(121);
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^name:/);
  });

  it("refuses an empty description", () => {
    const opts = baseOptions();
    opts.description = "";
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^description:/);
  });

  it("refuses builder.agentId that is not a well-formed AgentRegistryId", () => {
    const opts = baseOptions();
    opts.builder.agentId = "not-an-agent-id";
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^builder\.agentId:/);
  });

  it("refuses a missing builder.walletAddress", () => {
    const opts = baseOptions();
    const builder = opts.builder as Record<string, unknown>;
    delete builder.walletAddress;
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^builder\.walletAddress:/);
  });

  it("refuses a malformed builder.walletAddress", () => {
    const opts = baseOptions();
    opts.builder.walletAddress = "0xnothex";
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^builder\.walletAddress:/);
  });

  it("refuses an empty builder.contactURI", () => {
    const opts = baseOptions();
    opts.builder.contactURI = "";
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^builder\.contactURI:/);
  });

  it("refuses pricing.baseUSD that is zero, negative, or non-finite", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      const opts = baseOptions();
      opts.pricing.baseUSD = bad;
      expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^pricing\.baseUSD:/);
    }
  });

  it("refuses an empty workflowSteps array", () => {
    const opts = baseOptions();
    opts.workflowSteps = [];
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^workflowSteps:/);
  });

  it("refuses an invalid search.source", () => {
    const opts = baseOptions();
    (opts.search as unknown as { source: string }).source = "capabilities.bogus";
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^search\.source:/);
  });

  it("refuses an empty search.query", () => {
    const opts = baseOptions();
    opts.search.query = "";
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^search\.query:/);
  });

  it("refuses a negative search.resultCount", () => {
    const opts = baseOptions();
    opts.search.resultCount = -1;
    expect(refusalOf(() => scaffoldDigitalKernel(opts))).toMatch(/^search\.resultCount:/);
  });
});

// ---------------------------------------------------------------------------
// Injection safety
// ---------------------------------------------------------------------------

describe("scaffoldDigitalKernel: injection safety", () => {
  const ADVERSARIAL = 'Weird "Name" `with` ${injection} and\nnewline\\backslash';

  function parseErrors(source: string): readonly ts.Diagnostic[] {
    const { diagnostics } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    return diagnostics ?? [];
  }

  function findStringLiteral(source: string, propertyName: string): string | undefined {
    const sf = ts.createSourceFile("generated.ts", source, ts.ScriptTarget.ES2022, true);
    let found: string | undefined;
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === propertyName &&
        ts.isStringLiteral(node.initializer)
      ) {
        found = node.initializer.text;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  }

  it("keeps every generated .ts file parseable when name/description hold quotes, backticks, ${} and newlines", () => {
    const opts = baseOptions();
    opts.name = ADVERSARIAL;
    opts.description = ADVERSARIAL;
    const { files } = scaffoldDigitalKernel(opts);

    for (const path of ["src/manifest.ts", "src/index.ts", "src/execute.ts", "src/keys.ts", "src/register.ts"]) {
      expect(parseErrors(files[path]), `${path} should parse as valid TS`).toHaveLength(0);
    }
  });

  it("preserves the exact adversarial string at runtime (via the TS compiler API)", () => {
    const opts = baseOptions();
    opts.name = ADVERSARIAL;
    opts.description = ADVERSARIAL;
    const { files } = scaffoldDigitalKernel(opts);

    expect(findStringLiteral(files["src/manifest.ts"], "name")).toBe(ADVERSARIAL);
    expect(findStringLiteral(files["src/manifest.ts"], "description")).toBe(ADVERSARIAL);
  });
});

// ---------------------------------------------------------------------------
// Security grep
// ---------------------------------------------------------------------------

describe("scaffoldDigitalKernel: security grep over generated files", () => {
  it("never hard-codes key material, calls fromSeed, or logs secretKey", () => {
    const { files } = scaffoldDigitalKernel(baseOptions());
    for (const [path, content] of Object.entries(files)) {
      expect(content, `${path} must not call fromSeed`).not.toMatch(/fromSeed/);
      expect(content, `${path} must not embed a 64-byte hex secret`).not.toMatch(/[0-9a-fA-F]{128}/);
      for (const line of content.split("\n")) {
        if (/console\.\w+\(/.test(line)) {
          expect(line, `${path} must not log secretKey`).not.toMatch(/secretKey/);
        }
      }
    }
  });

  it("generates a fresh random keypair (nacl.sign.keyPair with no seed argument)", () => {
    const { files } = scaffoldDigitalKernel(baseOptions());
    expect(files["src/keys.ts"]).toContain("nacl.sign.keyPair()");
  });
});
