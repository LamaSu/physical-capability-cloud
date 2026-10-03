import { describe, it, expect } from "vitest";
// Plain ESM with no side effects on import (unlike the check script itself).
import {
  contentProblems,
  installedProblems,
  isChainClient,
  manifestProblems,
  payloadProblems,
  specTarget,
} from "../../scripts/boundary-policy.mjs";

const packed = new Set(["@pcc/spec", "@pcc/kernel-sdk", "@pcc/adk"]);
const privateNames = new Set(["@pcc/adk", "@pcc/gateway", "@pcc/private-package"]);
const gate = (pj: Record<string, unknown>) => manifestProblems("@pcc/x", pj, { packed, privateNames });

describe("verdict 101 F6: dependency specs are checked by the package they install", () => {
  it("passes the kit's real shape", () => {
    expect(gate({ dependencies: { "@pcc/spec": "0.1.0", tweetnacl: "^1.0.3", zod: "^3.23.0" } })).toEqual([]);
  });

  it("catches a chain client or a foreign @pcc package behind an npm: alias", () => {
    expect(gate({ dependencies: { compat: "npm:viem@^2" } })).toEqual(["@pcc/x: depends on chain client viem (as compat)"]);
    expect(gate({ optionalDependencies: { w: "npm:@wagmi/core@2" } })).toEqual([
      "@pcc/x: depends on chain client @wagmi/core (as w)",
    ]);
    expect(gate({ dependencies: { compat: "npm:@pcc/private-package@1" } })).toEqual([
      "@pcc/x: depends on @pcc/private-package (as compat), which is not part of the public kit",
      "@pcc/x: depends on private @pcc/private-package (as compat)",
    ]);
    expect(gate({ peerDependencies: { "@pcc/spec": "npm:ethers@6" } })).toEqual([
      "@pcc/x: depends on chain client ethers (as @pcc/spec)",
    ]);
  });

  it("refuses specs that are not registry ranges", () => {
    for (const spec of [
      "file:../x",
      "link:../x",
      "portal:../x",
      "git+https://example.test/x.git",
      "github:someone/x",
      "someone/x",
      "https://example.test/x.tgz",
      "workspace:*",
      "catalog:",
      "npm:../x",
    ]) {
      expect(specTarget("dep", spec).problem, spec).toBeTruthy();
      expect(gate({ dependencies: { dep: spec } }).length, spec).toBeGreaterThan(0);
    }
    expect(specTarget("dep", "^1.2.3")).toEqual({ target: "dep" });
    expect(specTarget("a", "npm:@scope/b@^1")).toEqual({ target: "@scope/b" });
    expect(specTarget("a", "npm:b")).toEqual({ target: "b" });
  });

  it("refuses bundled dependencies, which no dependency list shows", () => {
    expect(gate({ bundledDependencies: ["x"] })).toHaveLength(1);
    expect(gate({ bundleDependencies: true })).toHaveLength(1);
    expect(gate({ bundledDependencies: [] })).toEqual([]);
  });

  it("knows chain clients by name and by family", () => {
    for (const name of ["viem", "ox", "ethers", "@ethersproject/wallet", "web3-eth", "@walletconnect/core", "@solana/web3.js"]) {
      expect(isChainClient(name), name).toBe(true);
    }
    for (const name of ["tweetnacl", "zod", "@noble/hashes", "@pcc/spec", "web3x"]) {
      expect(isChainClient(name), name).toBe(false);
    }
  });
});

describe("verdict 101 F6: the complete installed graph is checked", () => {
  it("catches a transitive chain client or foreign @pcc package by its real name", () => {
    const clean = [
      { name: "@pcc/adk", version: "0.1.0", dir: "a" },
      { name: "tweetnacl", version: "1.0.3", dir: "b" },
    ];
    expect(installedProblems(clean, { packed })).toEqual([]);
    const dirty = [...clean, { name: "viem", version: "2.0.0", dir: "c" }, { name: "@pcc/gateway", version: "0.1.0", dir: "d" }];
    expect(installedProblems(dirty, { packed })).toEqual([
      "installed graph contains chain client viem@2.0.0 (c)",
      "installed graph contains @pcc/gateway@0.1.0 (d), which is not part of the public kit",
    ]);
  });
});

describe("verdict 101 F6: the payload is an allowlist of fresh build output", () => {
  const sources = new Set(["src/index.ts", "src/a/b.ts", "src/csds/x.csd.json"]);
  // 101b: every dist/ file also needs a pattern in the package's publication manifest.
  const allowed = ["dist/**/*.js", "dist/**/*.d.ts", "dist/**/*.js.map", "dist/**/*.d.ts.map", "dist/csds/*.csd.json"];
  const check = (files: string[]) => payloadProblems("@pcc/x", files, { hasSource: (p: string) => sources.has(p), allowed });

  it("passes package.json, README, LICENSE and dist output that has a source", () => {
    expect(
      check([
        "package.json",
        "README.md",
        "LICENSE",
        "dist/index.js",
        "dist/index.d.ts",
        "dist/index.js.map",
        "dist/a/b.d.ts.map",
        "dist/csds/x.csd.json",
      ]),
    ).toEqual([]);
  });

  it("fails the reviewer's key files and any stale or stray file", () => {
    const bad = [
      "dist/operator.key",
      "id_ecdsa",
      "credentials.json",
      "dist/k.p12",
      "KEY.PEM",
      ".env",
      "dist/.env",
      ".npmrc",
      "dist/old.js",
      "dist/old.d.ts",
      "dist/__tests__/x.test.js",
      "dist/x.test.js",
      "dist/../x.js",
      "src/index.ts",
      "dist",
    ];
    for (const file of bad) {
      expect(check([file]), file).toHaveLength(1);
    }
    expect(check(["dist/old.js"])[0]).toMatch(/no source src\/old\.ts/);
  });
});

describe("verdict 101 F6: payload text is scanned for secrets", () => {
  // Built at runtime, so no secret-looking literal sits in the source.
  const fakes: Record<string, string> = {
    pem: ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ").replace("BEGIN PRIVATE", "BEGIN EC PRIVATE"),
    pcc: ["pcc", "live", "A1b2".repeat(6)].join("_"),
    aws: "AK" + "IA" + "Q".repeat(16),
    github: "gh" + "p_" + "x".repeat(36),
    stripe: ["sk", "live", "z".repeat(24)].join("_"),
    slack: "xo" + "xb-" + "1".repeat(12),
    keyfile: JSON.stringify({ public: "ab", ["sec" + "ret"]: "f".repeat(64) }),
  };

  it("flags each family", () => {
    for (const [family, text] of Object.entries(fakes)) {
      expect(contentProblems("@pcc/x", "dist/a.js", `const x = ${JSON.stringify(text)};\n${text}`), family).toHaveLength(1);
    }
  });

  it("passes ordinary code and documentation", () => {
    const ordinary = [
      'export const AGENT_PACKAGE_PIN = { sha256: "sha256:' + "0".repeat(64) + '" };',
      "Set Authorization: Bearer pcc_live_abc123... on every request.",
      'const policy = { allowedActions: ["evidence_submit"], secretKey: secretKeyBytes };',
      "-----BEGIN PUBLIC KEY-----",
    ].join("\n");
    expect(contentProblems("@pcc/x", "README.md", ordinary)).toEqual([]);
  });
});
