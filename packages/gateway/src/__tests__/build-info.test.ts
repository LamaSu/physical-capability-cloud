import { describe, it, expect, vi } from "vitest";
import { BUILD_INFO_FILE, readBuildInfo, type BuildInfo } from "../build-info.js";

// Build provenance (STATUS-BOARD N5): readBuildInfo decides which commit /api/health
// reports. The commit comes ONLY from the file baked into the image at build time, so no
// runtime variable can change it (coord-watch #2886: a service variable used to override the
// baked value, and was then reported as the build). It never echoes arbitrary content and
// never invents a SHA.

const SHA40 = "0123456789abcdef0123456789abcdef01234567";
const OTHER40 = "fedcba9876543210fedcba9876543210fedcba98";

const file = (content: string | null) => () => content;
const info = (content: string | null, env: NodeJS.ProcessEnv = {}) => readBuildInfo({ readFile: file(content), env });
const baked = (commit: unknown, buildArg: unknown = "PCC_BUILD_SHA") => JSON.stringify({ commit, buildArg });
const UNKNOWN: BuildInfo = { commit: null, commitSource: "unknown", buildArg: null, deployMetadata: { railwayGitCommitSha: null } };

describe("readBuildInfo: the image file is the only source of `commit`", () => {
  it("reads the commit and the build argument the Dockerfile recorded", () => {
    expect(info(baked(SHA40))).toEqual({
      commit: SHA40,
      commitSource: "image_build",
      buildArg: "PCC_BUILD_SHA",
      deployMetadata: { railwayGitCommitSha: null },
    });
    expect(info(baked(OTHER40, "RAILWAY_GIT_COMMIT_SHA"))).toMatchObject({ commit: OTHER40, buildArg: "RAILWAY_GIT_COMMIT_SHA" });
  });

  it("reads the fixed path /app/BUILD_INFO.json, which no variable can redirect", () => {
    expect(BUILD_INFO_FILE).toBe("/app/BUILD_INFO.json");
    const readFile = vi.fn(() => null);
    readBuildInfo({ readFile, env: { PCC_BUILD_INFO_PATH: "/tmp/fake.json" } as NodeJS.ProcessEnv });
    expect(readFile).toHaveBeenCalledWith("/app/BUILD_INFO.json");
  });

  it("NEGATIVE (review #2886): a runtime PCC_BUILD_SHA never reaches `commit`, with or without the file", () => {
    expect(info(null, { PCC_BUILD_SHA: SHA40 })).toEqual(UNKNOWN);
    expect(info(baked(SHA40), { PCC_BUILD_SHA: OTHER40 }).commit).toBe(SHA40);
  });

  it("NEGATIVE: Railway's runtime commit is deploy metadata, never `commit`", () => {
    const r = info(null, { RAILWAY_GIT_COMMIT_SHA: OTHER40.toUpperCase() });
    expect(r.commit).toBeNull();
    expect(r.commitSource).toBe("unknown");
    expect(r.deployMetadata).toEqual({ railwayGitCommitSha: OTHER40 });
    expect(info(baked(SHA40), { RAILWAY_GIT_COMMIT_SHA: OTHER40 })).toMatchObject({
      commit: SHA40,
      deployMetadata: { railwayGitCommitSha: OTHER40 },
    });
  });

  it("NEGATIVE (review #2886): only a full 40-hex SHA is accepted; a prefix could be ambiguous", () => {
    expect(info(baked("0123456"))).toEqual(UNKNOWN);
    expect(info(baked(SHA40.slice(0, 39)))).toEqual(UNKNOWN);
    expect(info(baked(SHA40 + "0"))).toEqual(UNKNOWN);
    expect(info(null, { RAILWAY_GIT_COMMIT_SHA: "0123456" }).deployMetadata.railwayGitCommitSha).toBeNull();
  });

  it("NEGATIVE: an absent, malformed or tampered file is unknown, never echoed", () => {
    for (const content of [
      null,
      "",
      "not json",
      "[]",
      "null",
      JSON.stringify(SHA40),
      baked(SHA40.toUpperCase()),
      baked(` ${SHA40}`),
      baked(`${SHA40}\nX-Injected: pwned`),
      baked(SHA40, "SOMETHING_ELSE"),
      baked(SHA40, null),
      baked(12345),
      baked(SHA40) + " ".repeat(600),
    ]) {
      expect(info(content), String(content).slice(0, 40)).toEqual(UNKNOWN);
    }
  });

  it("an unreadable path (the default reader) is unknown, not an error", () => {
    // /app/BUILD_INFO.json does not exist outside the image.
    expect(readBuildInfo({ env: {} })).toEqual(UNKNOWN);
  });
});
