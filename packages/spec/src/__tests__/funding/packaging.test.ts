/**
 * reviewer-charlie L6 (implementer-delta): how `@pcc/spec` ships viem, which only its `./funding` subpath uses.
 *
 * The root export never loads viem, so a root-only consumer must not be made to install it, and a consumer that
 * funds must hand the SDK clients from ITS viem copy (one copy: its `WalletClient`/`PublicClient` types unify, and
 * `instanceof BaseError` in describeRevert works). So viem is an optional peer, plus a devDependency for this
 * package's own build and tests, and never a hard dependency.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { jobIdHashOf } from "../../funding/index.js";

const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  exports: Record<string, unknown>;
};

describe("@pcc/spec ships viem as an optional peer", () => {
  it("exports jobIdHashOf through the public funding subpath", () => {
    expect(jobIdHashOf("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  });
  it("viem is an optional peer (^2) and a devDependency, never a hard dependency", () => {
    expect(pkg.name).toBe("@pcc/spec");
    expect(pkg.dependencies?.viem).toBeUndefined();
    expect(pkg.peerDependencies?.viem).toBe("^2");
    expect(pkg.peerDependenciesMeta?.viem).toEqual({ optional: true });
    expect(pkg.devDependencies?.viem).toBe("^2");
  });

  it("the funding SDK stays a subpath export, so the root never needs viem", () => {
    expect(Object.keys(pkg.exports)).toContain("./funding");
    const root = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    expect(root).not.toMatch(/from\s+["']viem["']|["']\.\/funding/);
  });
});
