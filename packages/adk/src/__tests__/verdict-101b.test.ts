/**
 * Verdict 101b on #411 (SHIP, four MEDIUM follow-ups): each reproduced at 710427c2 first.
 *
 * M1: an unpaired surrogate passed the snapshot, then became U+FFFD in a query and a raw URIError in a path.
 * M2: the snapshot had a depth limit but no breadth, array, string or byte limit.
 * M3: a path parameter was only percent-encoded, so an intermediary that decodes %2F could change the route.
 * M4: the installed-graph walk missed bundled packages nested inside another, and a payload file shipped
 *     because a source existed, not because the package chose to publish it.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveToolRequest } from "../agent-package.js";
import { installedPackages, installedProblems, payloadProblems } from "../../scripts/boundary-policy.mjs";

const base = { baseUrl: "https://capability.network" };
const LONE = String.fromCharCode(0xd800);

/** The AdkToolError code `fn` throws, or "other: ..." for anything else, or undefined. */
function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof Error && e.name === "AdkToolError" ? (e as Error & { code: string }).code : `other: ${String(e)}`;
  }
  return undefined;
}

describe("101b M1: every string is valid Unicode before anything is built", () => {
  it("refuses an unpaired surrogate in a query value, a path parameter, a key or a body", () => {
    expect(errorCode(() => resolveToolRequest("get_kernel_jobs", { kernelId: "k", status: LONE }, base))).toBe("bad_input");
    expect(errorCode(() => resolveToolRequest("get_kernel", { kernelId: LONE }, base))).toBe("bad_input");
    expect(errorCode(() => resolveToolRequest("setup_validate", { config: { [LONE]: 1 } }, base))).toBe("bad_input");
    expect(errorCode(() => resolveToolRequest("setup_validate", { config: { note: `a${LONE}b` } }, base))).toBe("bad_input");
  });

  it("still sends a paired surrogate (a real character outside the BMP)", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const req = resolveToolRequest("setup_validate", { config: { note: emoji } }, base);
    expect(JSON.parse(req.body!).config.note).toBe(emoji);
  });
});

describe("101b M2: the snapshot is bounded in breadth and bytes, not only depth", () => {
  it("refuses an array one item over the limit", () => {
    expect(errorCode(() => resolveToolRequest("setup_validate", { config: new Array(10_001).fill(0) }, base))).toBe("bad_input");
    expect(errorCode(() => resolveToolRequest("setup_validate", { config: new Array(10_000).fill(0) }, base))).toBeUndefined();
  });

  it("refuses a long array before copying it", () => {
    const started = Date.now();
    expect(errorCode(() => resolveToolRequest("setup_validate", { config: new Array(1_000_000).fill(0) }, base))).toBe("bad_input");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("refuses too many values, a string too long, a body too large and a URL too long", () => {
    const many = Array.from({ length: 20 }, () => new Array(9_000).fill(0));
    expect(errorCode(() => resolveToolRequest("setup_validate", { config: many }, base))).toBe("bad_input");
    expect(errorCode(() => resolveToolRequest("setup_validate", { config: "x".repeat((1 << 20) + 1) }, base))).toBe("bad_input");
    const big = { a: "x".repeat(600_000), b: "y".repeat(600_000) };
    expect(errorCode(() => resolveToolRequest("setup_validate", { config: big }, base))).toBe("bad_input");
    expect(errorCode(() => resolveToolRequest("get_kernel_jobs", { kernelId: "k", status: "s".repeat(9_000) }, base))).toBe("bad_input");
  });

  it("still sends an ordinary request", () => {
    const req = resolveToolRequest("setup_validate", { config: { devices: new Array(100).fill({ id: "d" }) } }, base);
    expect(JSON.parse(req.body!).config.devices).toHaveLength(100);
  });
});

describe("101b M3: a path parameter is one route-safe segment, even after an intermediary decodes it", () => {
  const hostile = [
    "../auth/keys", "a/b", "a\\b", "a%2Fb", "%2e%2e", ".%2e", ".", "..", "", "a;b", "a?b", "a#b", "a b",
    String.fromCharCode(0), `a${String.fromCharCode(0x7f)}`, String.fromCharCode(0xff0f), `a${String.fromCharCode(0x2215)}b`,
  ];
  it.each(hostile.map((v) => [JSON.stringify(v), v]))("refuses %s", (_label, value) => {
    expect(errorCode(() => resolveToolRequest("get_kernel", { kernelId: value }, base))).toMatch(/^bad_(path_param|input)$/);
  });

  const accepted: Array<string | number> = [
    "kernel_dev_001", "my-slug", "3f8a1c2e-9b7d-4e6f-8a5b-1c2d3e4f5a6b", `0x${"ab".repeat(20)}`, `sha256:${"0f".repeat(32)}`,
    "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", "ops+alerts@example.org", "1.5", 42, "a~b", "a=b,c",
  ];
  it.each(accepted.map((v) => [JSON.stringify(v), v]))("accepts %s, and a decoding intermediary sees the same route", (_label, value) => {
    const url = resolveToolRequest("get_kernel", { kernelId: value }, base).url;
    const path = new URL(url).pathname;
    const segments = path.split("/");
    expect(segments.slice(0, 3)).toEqual(["", "api", "kernels"]);
    expect(segments).toHaveLength(4);
    // An intermediary that decodes the path, then normalizes dot segments, still routes to the same place.
    const decoded = decodeURIComponent(segments[3]);
    expect(decoded).toBe(String(value));
    expect(new URL(`https://x${segments.slice(0, 3).join("/")}/${decoded}`).pathname.split("/")).toHaveLength(4);
  });
});

describe("101b M4: the payload ships only what the package publishes, and no bundled package hides in the graph", () => {
  it("refuses a source-backed file the manifest does not publish", () => {
    const hasSource = () => true;
    expect(payloadProblems("@pcc/x", ["dist/internal.json"], { hasSource, allowed: ["dist/*.js"] })).toEqual([
      "@pcc/x: dist/internal.json is not in the package's publication manifest",
    ]);
    expect(payloadProblems("@pcc/x", ["dist/a.js"], { hasSource, allowed: ["dist/*.js"] })).toEqual([]);
    expect(payloadProblems("@pcc/x", ["dist/a.js"], { hasSource })).toEqual([
      "@pcc/x: dist/a.js is not in the package's publication manifest",
    ]);
  });

  it("has a manifest entry for each package of the kit, and publishes no JSON the kit did not name", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../scripts/publication-manifest.json", import.meta.url), "utf8"));
    expect(Object.keys(manifest).sort()).toEqual(["@pcc/adk", "@pcc/kernel-sdk", "@pcc/spec"]);
    for (const [name, patterns] of Object.entries(manifest as Record<string, string[]>)) {
      for (const p of patterns.filter((p) => p.endsWith(".json"))) {
        expect(name, p).toBe("@pcc/spec"); // only spec publishes data files
        expect(p).toMatch(/^dist\/(csds\/\*\.csd\.json|tool-manifests\/\*\.tools\.json)$/);
      }
    }
  });

  it("finds a package bundled inside another and refuses it", () => {
    const project = mkdtempSync(join(tmpdir(), "adk-walk-"));
    try {
      const write = (dir: string, pj: object) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify(pj));
      };
      const wrapper = join(project, "node_modules", ".pnpm", "wrapper@1.0.0", "node_modules", "wrapper");
      write(wrapper, { name: "wrapper", version: "1.0.0" });
      write(join(wrapper, "node_modules", "viem"), { name: "viem", version: "2.0.0" });
      write(join(wrapper, "node_modules", "@pcc", "secret"), { name: "@pcc/secret", version: "0.0.1" });
      const found = installedPackages(project);
      expect(found.map((p: { name: string }) => p.name).sort()).toEqual(["@pcc/secret", "viem", "wrapper"]);
      const problems = installedProblems(found, { packed: new Set(["@pcc/adk"]) });
      expect(problems.some((p: string) => p.includes("viem") && p.includes("bundled inside wrapper"))).toBe(true);
      expect(problems.some((p: string) => p.includes("chain client viem"))).toBe(true);
      expect(problems.some((p: string) => p.includes("@pcc/secret"))).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
