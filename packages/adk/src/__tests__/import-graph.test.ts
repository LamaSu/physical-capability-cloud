import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { walkImportGraph } from "../../scripts/import-graph.mjs";

const ADK_PACKAGE = "node_modules/@pcc/adk/package.json";
const ADK_INDEX = "node_modules/@pcc/adk/dist/index.js";
const ADK_TYPES = "node_modules/@pcc/adk/dist/index.d.ts";
const ADK_CJS = "node_modules/@pcc/adk/dist/index.cjs";
const SPEC_PACKAGE = "node_modules/@pcc/spec/package.json";
const SPEC_INDEX = "node_modules/@pcc/spec/dist/index.js";
const SPEC_TYPES = "node_modules/@pcc/spec/dist/index.d.ts";
const SPEC_FUNDING = "node_modules/@pcc/spec/dist/funding/index.js";
const SPEC_FUNDING_TYPES = "node_modules/@pcc/spec/dist/funding/index.d.ts";
const KERNEL_INDEX = "node_modules/@pcc/kernel-sdk/dist/index.js";
const AGENT_PACKAGE = "node_modules/@pcc/adk/dist/agent-package.js";
const NACL_INDEX = "node_modules/tweetnacl/nacl-fast.js";

const BASE_TREE: Record<string, string> = {
  "node_modules/@pcc/adk/package.json":
    '{"name":"@pcc/adk","type":"module","exports":{".":{"types":"./dist/index.d.ts","import":"./dist/index.js","default":"./dist/index.js"}}}\n',
  "node_modules/@pcc/adk/dist/index.js":
    'export { buildManifest } from "@pcc/kernel-sdk";\n' +
    'export { checkAgentPackage } from "./agent-package.js";\n',
  "node_modules/@pcc/adk/dist/agent-package.js":
    'import { sha256 } from "@pcc/spec";\n' +
    'export const checkAgentPackage = (text) => sha256(text);\n',
  "node_modules/@pcc/adk/dist/index.d.ts":
    'export { buildManifest } from "@pcc/kernel-sdk";\n' +
    'export declare const checkAgentPackage: (text: string) => Promise<string>;\n',
  "node_modules/@pcc/kernel-sdk/package.json":
    '{"name":"@pcc/kernel-sdk","type":"module","exports":{".":{"types":"./dist/index.d.ts","import":"./dist/index.js","default":"./dist/index.js"}}}\n',
  "node_modules/@pcc/kernel-sdk/dist/index.js":
    'import nacl from "tweetnacl";\n' +
    'import { sha256 } from "@pcc/spec";\n' +
    'export const buildManifest = (input) => [nacl, sha256(input)];\n',
  "node_modules/@pcc/kernel-sdk/dist/index.d.ts":
    'import type { Manifest } from "@pcc/spec";\n' +
    'export declare function buildManifest(input: Manifest): unknown;\n',
  "node_modules/@pcc/spec/package.json":
    '{"name":"@pcc/spec","type":"module","exports":{".":{"types":"./dist/index.d.ts","import":"./dist/index.js","default":"./dist/index.js"},"./funding":{"types":"./dist/funding/index.d.ts","import":"./dist/funding/index.js","default":"./dist/funding/index.js"}},"peerDependencies":{"viem":"^2"},"peerDependenciesMeta":{"viem":{"optional":true}}}\n',
  "node_modules/@pcc/spec/dist/index.js":
    '// Only ./funding uses viem; an import { keccak256 } from "viem" line here would leak it.\n' +
    'export const note = \'import "viem" only from ./funding\';\n' +
    'export const sha256 = async (text) => text;\n',
  "node_modules/@pcc/spec/dist/index.d.ts":
    '/** Only ./funding uses viem: import type { Hex } from "viem" stays there. */\n' +
    'export type Manifest = { id: string };\n' +
    'export declare const sha256: (text: string) => Promise<string>;\n',
  "node_modules/@pcc/spec/dist/funding/index.js":
    'import { keccak256 } from "viem";\n' +
    'export const fund = (x) => keccak256(x);\n',
  "node_modules/@pcc/spec/dist/funding/index.d.ts":
    'import type { Hex } from "viem";\n' +
    'export declare const fund: (x: Hex) => Hex;\n',
  "node_modules/tweetnacl/package.json":
    '{"name":"tweetnacl","main":"nacl-fast.js"}\n',
  "node_modules/tweetnacl/nacl-fast.js":
    'var crypto = require("crypto");\n' +
    'module.exports = { randomBytes: crypto.randomBytes };\n',
  "node_modules/viem/package.json":
    '{"name":"viem","type":"module","exports":{".":{"types":"./index.d.ts","import":"./index.js","default":"./index.js"},"./accounts":{"import":"./accounts.js","default":"./accounts.js"}}}\n',
  "node_modules/viem/index.js":
    'export const keccak256 = (x) => x;\n',
  "node_modules/viem/index.d.ts":
    'export type Hex = `0x${string}`;\n' +
    'export declare const keccak256: (x: Hex) => Hex;\n',
  "node_modules/viem/accounts.js":
    'export const privateKeyToAccount = (key) => key;\n',
};

const NO_PEER_TREE = Object.fromEntries(
  Object.entries(BASE_TREE).filter(([path]) => !path.startsWith("node_modules/viem/")),
);

const roots: string[] = [];

function tree(files: Record<string, string>): string {
  const R = realpathSync(mkdtempSync(join(tmpdir(), "adk-import-graph-")));
  roots.push(R);

  for (const [path, content] of Object.entries(files)) {
    const target = join(R, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  return R;
}

afterEach(() => {
  for (const R of roots.splice(0)) {
    rmSync(R, { recursive: true, force: true });
  }
});

function walk(files: Record<string, string>) {
  const R = tree(files);
  return walkImportGraph(realpathSync(join(R, "node_modules/@pcc/adk")), {
    forbidden: new Set(["viem"]),
    root: R,
  });
}

function append(files: Record<string, string>, path: string, line: string): Record<string, string> {
  return { ...files, [path]: files[path] + line + "\n" };
}

function changePackage(
  files: Record<string, string>,
  path: string,
  change: (manifest: any) => void,
): Record<string, string> {
  const manifest = JSON.parse(files[path]);
  change(manifest);
  return { ...files, [path]: JSON.stringify(manifest) + "\n" };
}

const SUFFIX = ", which must not be reachable from @pcc/adk's exports";

function forbiddenAt(path: string, specifier = "viem"): string {
  return `${path}: imports ${specifier}${SUFFIX}`;
}

describe("the import graph from a package's exports", () => {
  it("walks the kit's shape without reaching the peer, and a comment or string naming it does not count", () => {
    const graph = walk(BASE_TREE);

    expect(graph.problems).toEqual([]);
    expect(graph.runtime.packages).toEqual([
      "@pcc/adk",
      "@pcc/kernel-sdk",
      "@pcc/spec",
      "tweetnacl",
    ]);
    expect(graph.types.packages).toEqual([
      "@pcc/adk",
      "@pcc/kernel-sdk",
      "@pcc/spec",
    ]);

    expect(graph.runtime.files).toContain(SPEC_INDEX);
    expect(graph.runtime.files.some((path) => path.startsWith("node_modules/@pcc/spec/dist/funding/"))).toBe(false);
    expect(graph.runtime.files.some((path) => path.startsWith("node_modules/viem/"))).toBe(false);

    expect(graph.types.files).toContain(SPEC_TYPES);
    expect(graph.types.files.some((path) => path.startsWith("node_modules/@pcc/spec/dist/funding/"))).toBe(false);
  });

  it("fails when an entry point imports the peer, installed or not", () => {
    const variants: Array<[string, Record<string, string>]> = [
      ["installed", BASE_TREE],
      ["absent", NO_PEER_TREE],
    ];

    for (const [variant, base] of variants) {
      const cjs = changePackage(base, ADK_PACKAGE, (manifest) => {
        manifest.exports["."] = {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
          require: "./dist/index.cjs",
          default: "./dist/index.js",
        };
      });

      const cases: Array<[string, Record<string, string>, string]> = [
        [
          "static",
          append(base, ADK_INDEX, 'import { keccak256 } from "viem";'),
          forbiddenAt(ADK_INDEX),
        ],
        [
          "re-export",
          append(base, ADK_INDEX, 'export { keccak256 } from "viem";'),
          forbiddenAt(ADK_INDEX),
        ],
        [
          "side effect",
          append(base, ADK_INDEX, 'import "viem";'),
          forbiddenAt(ADK_INDEX),
        ],
        [
          "dynamic",
          append(base, ADK_INDEX, 'export async function later() { return import("viem"); }'),
          forbiddenAt(ADK_INDEX),
        ],
        [
          "template literal",
          append(base, ADK_INDEX, "export async function later() { return import(`viem`); }"),
          forbiddenAt(ADK_INDEX),
        ],
        [
          "subpath",
          append(base, ADK_INDEX, 'import { privateKeyToAccount } from "viem/accounts";'),
          forbiddenAt(ADK_INDEX, "viem/accounts"),
        ],
        [
          "CommonJS",
          { ...cjs, [ADK_CJS]: 'module.exports = () => require("viem");\n' },
          forbiddenAt(ADK_CJS),
        ],
      ];

      for (const [cell, files, problem] of cases) {
        expect(walk(files).problems, `${variant}: ${cell}`).toEqual([problem]);
      }
    }
  });

  it("fails when the peer is reached through a dependency", () => {
    const node = changePackage(BASE_TREE, SPEC_PACKAGE, (manifest) => {
      manifest.exports["."] = {
        types: "./dist/index.d.ts",
        node: {
          import: "./dist/node.js",
          default: "./dist/node.js",
        },
        default: "./dist/index.js",
      };
    });

    const cases: Array<[string, Record<string, string>]> = [
      [
        "direct dependency subpath",
        append(BASE_TREE, AGENT_PACKAGE, 'import { fund } from "@pcc/spec/funding";'),
      ],
      [
        "relative re-export",
        append(BASE_TREE, SPEC_INDEX, 'export * from "./funding/index.js";'),
      ],
      [
        "dependency re-export",
        append(BASE_TREE, KERNEL_INDEX, 'export { fund } from "@pcc/spec/funding";'),
      ],
      [
        "conditional node entry",
        { ...node, ["node_modules/@pcc/spec/dist/node.js"]: 'export * from "./funding/index.js";\n' },
      ],
    ];

    for (const [cell, files] of cases) {
      expect(walk(files).problems, cell).toEqual([
        forbiddenAt(SPEC_FUNDING),
      ]);
    }
  });

  it("walks every entry of the exports map, declarations included", () => {
    const extra = changePackage(BASE_TREE, ADK_PACKAGE, (manifest) => {
      manifest.exports["./extra"] = "./dist/extra.js";
    });

    const cases: Array<[string, Record<string, string>, string]> = [
      [
        "additional entry",
        { ...extra, ["node_modules/@pcc/adk/dist/extra.js"]: 'import "viem";\n' },
        forbiddenAt("node_modules/@pcc/adk/dist/extra.js"),
      ],
      [
        "declaration import",
        append(BASE_TREE, ADK_TYPES, 'import type { Hex } from "viem";'),
        forbiddenAt(ADK_TYPES),
      ],
      [
        "declaration import type",
        append(BASE_TREE, ADK_TYPES, 'export declare const h: import("viem").Hex;'),
        forbiddenAt(ADK_TYPES),
      ],
      [
        "declaration dependency subpath",
        append(BASE_TREE, ADK_TYPES, 'export type { Hex } from "@pcc/spec/funding";'),
        forbiddenAt(SPEC_FUNDING_TYPES),
      ],
      [
        "declaration import-equals",
        append(BASE_TREE, ADK_TYPES, 'import x = require("viem");'),
        forbiddenAt(ADK_TYPES),
      ],
      [
        "declaration reference types",
        { ...BASE_TREE, [ADK_TYPES]: '/// <reference types="viem" />\n' + BASE_TREE[ADK_TYPES] },
        forbiddenAt(ADK_TYPES),
      ],
      [
        "declaration reference path",
        { ...BASE_TREE, [ADK_TYPES]: '/// <reference path="../../spec/dist/funding/index.d.ts" />\n' + BASE_TREE[ADK_TYPES] },
        forbiddenAt(SPEC_FUNDING_TYPES),
      ],
    ];

    for (const [cell, files, problem] of cases) {
      expect(walk(files).problems, cell).toEqual([problem]);
    }
  });

  it("fails closed on an import it cannot follow", () => {
    const pattern = changePackage(BASE_TREE, ADK_PACKAGE, (manifest) => {
      manifest.exports["./*"] = "./dist/*.js";
    });

    const missing = changePackage(BASE_TREE, ADK_PACKAGE, (manifest) => {
      manifest.exports["."] = {
        types: "./dist/index.d.ts",
        import: "./dist/missing.js",
        default: "./dist/missing.js",
      };
    });

    const cases: Array<[string, Record<string, string>, string]> = [
      [
        "non-literal dynamic import",
        append(BASE_TREE, ADK_INDEX, "export const load = (name) => import(name);"),
        `${ADK_INDEX}: an import() or require() whose specifier is not a string literal`,
      ],
      [
        "non-literal require",
        append(BASE_TREE, NACL_INDEX, "var impl = require(process.env.NACL_IMPL);"),
        `${NACL_INDEX}: an import() or require() whose specifier is not a string literal`,
      ],
      [
        "non-literal import type",
        append(BASE_TREE, ADK_TYPES, "export declare const t: import(Foo).X;"),
        `${ADK_TYPES}: an import() or require() whose specifier is not a string literal`,
      ],
      [
        "unresolved package",
        append(BASE_TREE, AGENT_PACKAGE, 'import pad from "left-pad";'),
        `${AGENT_PACKAGE}: cannot resolve left-pad`,
      ],
      [
        "unresolved relative import",
        append(BASE_TREE, ADK_INDEX, 'export * from "./gone.js";'),
        `${ADK_INDEX}: cannot resolve ./gone.js`,
      ],
      [
        "pattern export",
        pattern,
        "@pcc/adk: exports key ./* is a pattern; the walk cannot list its files",
      ],
      [
        "missing export entry",
        missing,
        "@pcc/adk: exports entry ./dist/missing.js does not exist",
      ],
    ];

    for (const [cell, files, problem] of cases) {
      expect(walk(files).problems, cell).toEqual([problem]);
    }
  });
});
