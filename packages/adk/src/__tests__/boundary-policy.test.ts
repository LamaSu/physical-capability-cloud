import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Plain ESM with no side effects on import (unlike the check script itself).
import {
  ALLOWED_OPTIONAL_PEERS,
  contentProblems,
  installedPackages,
  installedPeerProblems,
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

describe("verdict 101c: the installed-graph walk fails closed, not open", () => {
  const writePkg = (dir: string, name: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  };
  // Build a throwaway pnpm consumer, scan it, and clean up even if the build or the walk throws.
  const scan = (build: (root: string) => void) => {
    const root = mkdtempSync(join(tmpdir(), "pcc-bnd-"));
    try {
      build(root);
      const installed = installedPackages(root);
      return { installed, problems: installedProblems(installed, { packed }) };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("reports an opaque walk entry as a problem", () => {
    expect(
      installedProblems([{ opaque: "x has no package.json", dir: "a/node_modules/x", bundledIn: "a" }], { packed }),
    ).toEqual(["installed graph has an opaque entry at a/node_modules/x, bundled inside a: x has no package.json"]);
  });

  it("reports a directory under a package's own node_modules that has no package.json", () => {
    // At 9c0730f9 installedPackages() returned only `wrapper` and installedProblems() said nothing.
    const { problems } = scan((root) => {
      const nm = join(root, "node_modules/.pnpm/wrapper@1.0.0/node_modules");
      writePkg(join(nm, "wrapper"), "wrapper");
      mkdirSync(join(nm, "wrapper/node_modules/viem"), { recursive: true });
      writeFileSync(join(nm, "wrapper/node_modules/viem/index.js"), "module.exports = {};");
    });
    expect(problems.some((p) => p.includes("opaque") && p.includes("viem") && p.includes("bundled inside wrapper"))).toBe(true);
  });

  it("follows a symlinked scope and still catches the package behind it", () => {
    // At 9c0730f9 the `@pcc` symlink was treated as one unreadable package, so `@pcc/secret` vanished.
    const { problems } = scan((root) => {
      const nm = join(root, "node_modules/.pnpm/wrapper@1.0.0/node_modules");
      writePkg(join(nm, "wrapper"), "wrapper");
      mkdirSync(join(nm, "wrapper/node_modules"), { recursive: true });
      const ext = join(root, "external/scope");
      writePkg(join(ext, "secret"), "@pcc/secret");
      symlinkSync(ext, join(nm, "wrapper/node_modules/@pcc"), "dir");
    });
    expect(problems.some((p) => p.includes("@pcc/secret") && p.includes("bundled inside wrapper"))).toBe(true);
  });

  it("walks a bundled graph deeper than the old 16-level limit", () => {
    // At 9c0730f9 the walk stopped past depth 16, so the deepest package was invisible.
    const DEPTH = 18;
    const { installed } = scan((root) => {
      let dir = join(root, "node_modules/.pnpm/deep@1.0.0/node_modules/deep");
      writePkg(dir, "deep");
      for (let i = 1; i <= DEPTH; i++) {
        dir = join(dir, "node_modules", `nest${i}`);
        writePkg(dir, `nest${i}`);
      }
    });
    expect(installed.map((e: { name?: string }) => e.name)).toContain(`nest${DEPTH}`);
  });

  it("reports a package concealed under a dot-prefixed name", () => {
    // At e0f0a8ee moduleEntries() skipped every dot name, so `.concealed/package.json` vanished (101d).
    const { problems } = scan((root) => {
      const nm = join(root, "node_modules/.pnpm/wrapper@1.0.0/node_modules");
      writePkg(join(nm, "wrapper"), "wrapper");
      writePkg(join(nm, "wrapper/node_modules/.concealed"), "viem");
    });
    expect(problems.some((p) => p.includes("viem") && p.includes("bundled inside wrapper"))).toBe(true);
  });

  it("reports a package concealed under a dot-name inside a scope", () => {
    // At ea73e2df the scope loop also skipped .bin/.pnpm/.modules.yaml, so @scope/.pnpm hid a package (101e).
    const { problems } = scan((root) => {
      const nm = join(root, "node_modules/.pnpm/wrapper@1.0.0/node_modules");
      writePkg(join(nm, "wrapper"), "wrapper");
      mkdirSync(join(nm, "wrapper/node_modules/@scope"), { recursive: true });
      writePkg(join(nm, "wrapper/node_modules/@scope/.pnpm"), "viem");
    });
    expect(problems.some((p) => p.includes("viem") && p.includes("bundled inside wrapper"))).toBe(true);
  });

  it("rejects bundled packages hidden beneath metadata-shaped directories", () => {
    for (const name of [".pnpm", ".bin", ".modules.yaml"]) {
      const { problems } = scan((root) => {
        const wrapper = join(root, "node_modules/.pnpm/wrapper@1.0.0/node_modules/wrapper");
        writePkg(wrapper, "wrapper");
        writePkg(join(wrapper, "node_modules", name, "viem"), "viem");
      });
      expect(
        problems.some((problem) => problem.includes("opaque") && problem.includes(`node_modules/${name}`) && problem.includes("bundled inside wrapper")),
        name,
      ).toBe(true);
    }
  });

  it("rejects a symlinked shim directory or a shim directory containing a symlink", () => {
    const linkedDirectory = scan((root) => {
      const wrapper = join(root, "node_modules/.pnpm/wrapper@1.0.0/node_modules/wrapper");
      writePkg(wrapper, "wrapper");
      const external = join(root, "external/shims");
      mkdirSync(external, { recursive: true });
      writeFileSync(join(external, "command"), "#!/bin/sh\n");
      mkdirSync(join(wrapper, "node_modules"), { recursive: true });
      symlinkSync(external, join(wrapper, "node_modules/.bin"), "dir");
    });
    expect(linkedDirectory.problems.some((problem) => problem.includes("opaque") && problem.includes(".bin"))).toBe(true);

    const linkedShim = scan((root) => {
      const wrapper = join(root, "node_modules/.pnpm/wrapper@1.0.0/node_modules/wrapper");
      writePkg(wrapper, "wrapper");
      const external = join(root, "external/viem");
      writePkg(external, "viem");
      const bin = join(wrapper, "node_modules/.bin");
      mkdirSync(bin, { recursive: true });
      symlinkSync(external, join(bin, "viem"), "dir");
    });
    expect(linkedShim.problems.some((problem) => problem.includes("opaque") && problem.includes(".bin"))).toBe(true);
  });

  it("accepts a real bundled shim directory containing only regular files", () => {
    const { installed, problems } = scan((root) => {
      const wrapper = join(root, "node_modules/.pnpm/wrapper@1.0.0/node_modules/wrapper");
      writePkg(wrapper, "wrapper");
      const bin = join(wrapper, "node_modules/.bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "tool"), "#!/bin/sh\n");
      writeFileSync(join(bin, "other"), "#!/bin/sh\n");
    });
    expect(installed.map((entry: { name?: string }) => entry.name)).toEqual(["wrapper"]);
    expect(problems).toEqual([]);
  });

  it("rejects concealed, unreadable or foreign entries in pnpm store modules", () => {
    for (const kind of ["symlinked scope", "foreign symlink", "dot-name", "missing manifest"]) {
      const { problems } = scan((root) => {
        const modules = join(root, "node_modules/.pnpm/x@1.0.0/node_modules");
        writePkg(join(modules, "x"), "x");
        if (kind === "symlinked scope") {
          const external = join(root, "external/scope");
          writePkg(join(external, "secret"), "@pcc/secret");
          symlinkSync(external, join(modules, "@pcc"), "dir");
        } else if (kind === "foreign symlink") {
          const external = join(root, "external/viem");
          writePkg(external, "viem");
          symlinkSync(external, join(modules, "viem"), "dir");
        } else if (kind === "dot-name") {
          writePkg(join(modules, ".hidden"), "viem");
        } else {
          const unreadable = join(modules, "y");
          mkdirSync(unreadable, { recursive: true });
          writeFileSync(join(unreadable, "index.js"), "module.exports = 1;\n");
        }
      });
      expect(problems.some((problem) => problem.includes("opaque store entry")), kind).toBe(true);
    }
  });

  it("accepts real scoped packages and dependency links to recorded store packages", () => {
    const { installed, problems } = scan((root) => {
      const store = join(root, "node_modules/.pnpm");
      const early = join(store, "a@1.0.0/node_modules");
      const late = join(store, "z@1.0.0/node_modules");
      const scoped = join(store, "@scope+tool@1.0.0/node_modules/@scope/tool");
      writePkg(join(early, "a"), "a");
      writePkg(join(late, "z"), "z");
      writePkg(scoped, "@scope/tool");
      symlinkSync(join(late, "z"), join(early, "z"), "dir");
      mkdirSync(join(early, "@scope"), { recursive: true });
      symlinkSync(scoped, join(early, "@scope/tool"), "dir");
    });
    expect(installed.map((entry: { name?: string }) => entry.name).sort()).toEqual(["@scope/tool", "a", "z"]);
    expect(problems).toEqual([]);
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


describe("optional peers: only a listed, optional peer is allowed, and it stays uninstalled", () => {
  it("allows a listed peer that peerDependenciesMeta marks optional", () => {
    expect(
      manifestProblems(
        "@pcc/spec",
        {
          dependencies: { "@noble/hashes": "^1.7.0", zod: "^3.23.0" },
          peerDependencies: { viem: "^2" },
          peerDependenciesMeta: { viem: { optional: true } },
        },
        { packed, privateNames },
      ),
    ).toEqual([]);
  });

  it("still refuses a listed peer that is not marked optional or not a peer", () => {
    const cases = [
      { peerDependencies: { viem: "^2" } },
      { peerDependencies: { viem: "^2" }, peerDependenciesMeta: { viem: {} } },
      { peerDependencies: { viem: "^2" }, peerDependenciesMeta: { viem: { optional: false } } },
      { peerDependencies: { viem: "^2" }, peerDependenciesMeta: { viem: { optional: "true" } } },
      { dependencies: { viem: "^2" }, peerDependenciesMeta: { viem: { optional: true } } },
      { optionalDependencies: { viem: "^2" }, peerDependenciesMeta: { viem: { optional: true } } },
    ];
    for (const pj of cases) {
      expect(manifestProblems("@pcc/spec", pj, { packed, privateNames })).toEqual([
        "@pcc/spec: depends on chain client viem",
      ]);
    }
  });

  it("still refuses an optional peer that is not on the list for its package", () => {
    expect(
      manifestProblems(
        "@pcc/spec",
        { peerDependencies: { ethers: "^6" }, peerDependenciesMeta: { ethers: { optional: true } } },
        { packed, privateNames },
      ),
    ).toEqual([
      "@pcc/spec: depends on chain client ethers",
      "@pcc/spec: optional peer ethers is not on the allowed list",
    ]);

    expect(
      manifestProblems(
        "@pcc/kernel-sdk",
        { peerDependencies: { viem: "^2" }, peerDependenciesMeta: { viem: { optional: true } } },
        { packed, privateNames },
      ),
    ).toEqual([
      "@pcc/kernel-sdk: depends on chain client viem",
      "@pcc/kernel-sdk: optional peer viem is not on the allowed list",
    ]);

    expect(
      manifestProblems(
        "@pcc/spec",
        { peerDependencies: { "left-pad": "^1.3.0" }, peerDependenciesMeta: { "left-pad": { optional: true } } },
        { packed, privateNames },
      ),
    ).toEqual([
      "@pcc/spec: optional peer left-pad is not on the allowed list",
    ]);

    expect(
      manifestProblems(
        "@pcc/spec",
        { peerDependencies: { viem: "npm:ethers@^6" }, peerDependenciesMeta: { viem: { optional: true } } },
        { packed, privateNames },
      ),
    ).toEqual([
      "@pcc/spec: depends on chain client viem",
      "@pcc/spec: depends on chain client ethers (as viem)",
    ]);
  });

  it("fails when a listed optional peer is installed", () => {
    const clean = [
      { name: "@pcc/adk", version: "0.1.0", dir: "a" },
      { name: "tweetnacl", version: "1.0.3", dir: "b" },
    ];
    expect(installedPeerProblems(clean)).toEqual([]);
    expect(installedPeerProblems([...clean, { name: "viem", version: "2.21.0", dir: "c" }])).toEqual([
      "installed graph contains viem@2.21.0 (c), an optional peer that must stay uninstalled",
    ]);
  });

  it("names each allowed optional peer with its package and a one-line reason", () => {
    expect(ALLOWED_OPTIONAL_PEERS.map((entry) => [entry.package, entry.peer])).toEqual([
      ["@pcc/spec", "viem"],
    ]);
    expect(Object.isFrozen(ALLOWED_OPTIONAL_PEERS)).toBe(true);
    for (const entry of ALLOWED_OPTIONAL_PEERS) {
      expect(typeof entry.reason).toBe("string");
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      expect(entry.reason).not.toMatch(/[\r\n]/);
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });
});
