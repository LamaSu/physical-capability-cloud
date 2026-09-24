import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBuildInfo } from "../build-info.js";

// N5: the Dockerfile's build-info step, run for real through `sh`, so the rules that decide
// what /api/health can ever report are tested, not only read:
//   - only a full 40-hex SHA is written;
//   - PCC_BUILD_SHA (CI) wins, else RAILWAY_GIT_COMMIT_SHA (a Railway build of that commit);
//   - two different SHAs fail the build instead of baking a stale one;
//   - nothing else is written, and the file round-trips through readBuildInfo.

const DOCKERFILE = fileURLToPath(new URL("../../../../Dockerfile", import.meta.url));
const SHA40 = "0123456789abcdef0123456789abcdef01234567";
const OTHER40 = "fedcba9876543210fedcba9876543210fedcba98";

/** The RUN instruction that follows `ARG RAILWAY_GIT_COMMIT_SHA`, as the shell receives it. */
function buildInfoStep(): string {
  const text = readFileSync(DOCKERFILE, "utf8");
  const arg = text.indexOf('ARG RAILWAY_GIT_COMMIT_SHA=""');
  expect(arg, "the Dockerfile declares the Railway build arg").toBeGreaterThan(-1);
  const run = text.indexOf("RUN ", arg);
  const lines: string[] = [];
  for (const line of text.slice(run + "RUN ".length).split("\n")) {
    lines.push(line);
    if (!line.trimEnd().endsWith("\\")) break;
  }
  return lines.join("\n").replace(/\\\n/g, " ");
}

function runStep(args: { PCC_BUILD_SHA?: string; RAILWAY_GIT_COMMIT_SHA?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "pcc-build-info-"));
  const out = join(dir, "BUILD_INFO.json");
  const script = buildInfoStep().split("/app/BUILD_INFO.json").join(out);
  let ok = true;
  let stderr = "";
  try {
    execFileSync("sh", ["-c", script], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PCC_BUILD_SHA: args.PCC_BUILD_SHA ?? "", RAILWAY_GIT_COMMIT_SHA: args.RAILWAY_GIT_COMMIT_SHA ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    ok = false;
    stderr = String((e as { stderr?: Buffer }).stderr ?? "");
  }
  const content = existsSync(out) ? readFileSync(out, "utf8") : null;
  return { ok, stderr, content };
}

describe("Dockerfile build-info step (N5)", () => {
  it("records CI's PCC_BUILD_SHA, lowercased, and it round-trips through readBuildInfo", () => {
    const r = runStep({ PCC_BUILD_SHA: SHA40.toUpperCase() });
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content!)).toEqual({ commit: SHA40, buildArg: "PCC_BUILD_SHA" });
    expect(readBuildInfo({ readFile: () => r.content, env: {} })).toMatchObject({ commit: SHA40, commitSource: "image_build", buildArg: "PCC_BUILD_SHA" });
  });

  it("records Railway's build commit when CI's is absent", () => {
    const r = runStep({ RAILWAY_GIT_COMMIT_SHA: OTHER40 });
    expect(JSON.parse(r.content!)).toEqual({ commit: OTHER40, buildArg: "RAILWAY_GIT_COMMIT_SHA" });
  });

  it("prefers CI's when both are given and agree", () => {
    const r = runStep({ PCC_BUILD_SHA: SHA40, RAILWAY_GIT_COMMIT_SHA: SHA40 });
    expect(JSON.parse(r.content!)).toEqual({ commit: SHA40, buildArg: "PCC_BUILD_SHA" });
  });

  it("NEGATIVE (review #2886): two different SHAs fail the build and write nothing", () => {
    const r = runStep({ PCC_BUILD_SHA: SHA40, RAILWAY_GIT_COMMIT_SHA: OTHER40 });
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/disagree/);
    expect(r.content).toBeNull();
  });

  it("NEGATIVE: a prefix, junk or nothing writes no file (the commit is then reported unknown)", () => {
    for (const args of [{}, { PCC_BUILD_SHA: "0123456" }, { PCC_BUILD_SHA: "abc; touch /tmp/pwned" }, { RAILWAY_GIT_COMMIT_SHA: `${SHA40}\nX: y` }]) {
      const r = runStep(args);
      expect(r.ok, JSON.stringify(args)).toBe(true);
      expect(r.content, JSON.stringify(args)).toBeNull();
    }
  });

  it("NEGATIVE: the image no longer sets PCC_BUILD_SHA as a runtime ENV", () => {
    expect(readFileSync(DOCKERFILE, "utf8")).not.toMatch(/^ENV PCC_BUILD_SHA/m);
  });
});
