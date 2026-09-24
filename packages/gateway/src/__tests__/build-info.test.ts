import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readBuildInfo, type BuildInfo } from "../build-info.js";

// Build provenance (STATUS-BOARD N5): readBuildInfo decides which commit
// /api/health reports. It must never echo arbitrary env content and never
// invent a SHA: a malformed value is treated exactly like an absent one.

const SHA40 = "0123456789abcdef0123456789abcdef01234567";
const OTHER40 = "fedcba9876543210fedcba9876543210fedcba98";

const UNKNOWN: BuildInfo = { commit: null, commitSource: "unknown" };

const ENV_KEYS = ["PCC_BUILD_SHA", "RAILWAY_GIT_COMMIT_SHA"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("readBuildInfo: precedence", () => {
  it("prefers PCC_BUILD_SHA (baked by CI) over RAILWAY_GIT_COMMIT_SHA", () => {
    expect(readBuildInfo({ PCC_BUILD_SHA: SHA40, RAILWAY_GIT_COMMIT_SHA: OTHER40 })).toEqual({
      commit: SHA40,
      commitSource: "image_build",
    });
  });

  it("uses RAILWAY_GIT_COMMIT_SHA when PCC_BUILD_SHA is absent", () => {
    expect(readBuildInfo({ RAILWAY_GIT_COMMIT_SHA: OTHER40 })).toEqual({
      commit: OTHER40,
      commitSource: "railway_deploy",
    });
  });

  it("returns { commit: null, commitSource: 'unknown' } when both are absent", () => {
    expect(readBuildInfo({})).toEqual(UNKNOWN);
  });

  it("falls through an INVALID PCC_BUILD_SHA to a valid RAILWAY_GIT_COMMIT_SHA", () => {
    expect(readBuildInfo({ PCC_BUILD_SHA: "not-a-sha", RAILWAY_GIT_COMMIT_SHA: OTHER40 })).toEqual({
      commit: OTHER40,
      commitSource: "railway_deploy",
    });
  });

  it("falls through an EMPTY PCC_BUILD_SHA (the Dockerfile ARG default) to RAILWAY_GIT_COMMIT_SHA", () => {
    expect(readBuildInfo({ PCC_BUILD_SHA: "", RAILWAY_GIT_COMMIT_SHA: OTHER40 })).toEqual({
      commit: OTHER40,
      commitSource: "railway_deploy",
    });
  });

  it("is 'unknown' when both values are present but invalid (never echoes either)", () => {
    expect(readBuildInfo({ PCC_BUILD_SHA: "${evil}", RAILWAY_GIT_COMMIT_SHA: "abc; rm -rf /" })).toEqual(
      UNKNOWN,
    );
  });

  it("reads process.env by default", () => {
    process.env.PCC_BUILD_SHA = SHA40;
    expect(readBuildInfo()).toEqual({ commit: SHA40, commitSource: "image_build" });

    delete process.env.PCC_BUILD_SHA;
    process.env.RAILWAY_GIT_COMMIT_SHA = OTHER40;
    expect(readBuildInfo()).toEqual({ commit: OTHER40, commitSource: "railway_deploy" });

    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    expect(readBuildInfo()).toEqual(UNKNOWN);
  });
});

describe("readBuildInfo: accepted values", () => {
  it.each([
    ["7-char short SHA", "abc1234", "abc1234"],
    ["40-char full SHA", SHA40, SHA40],
    ["uppercase hex, lowercased", "ABCDEF0123456789ABCDEF0123456789ABCDEF01", "abcdef0123456789abcdef0123456789abcdef01"],
    ["mixed case, lowercased", "AbC1234", "abc1234"],
    ["surrounding whitespace trimmed", "  abc1234\t", "abc1234"],
    ["trailing newline trimmed (e.g. from a file or $(...))", "abc1234\n", "abc1234"],
  ])("accepts %s", (_label, raw, expected) => {
    expect(readBuildInfo({ PCC_BUILD_SHA: raw })).toEqual({ commit: expected, commitSource: "image_build" });
    expect(readBuildInfo({ RAILWAY_GIT_COMMIT_SHA: raw })).toEqual({
      commit: expected,
      commitSource: "railway_deploy",
    });
  });
});

describe("readBuildInfo: rejected values are treated as absent", () => {
  it.each([
    ["empty string", ""],
    ["spaces only", "   "],
    ["tabs/newlines only", "\t\n\r\n"],
    ["6 chars (too short)", "abc123"],
    ["41 chars (too long)", `${SHA40}8`],
    ["64-char hex (longer than a SHA-1)", "a".repeat(64)],
    ["non-hex letters", "zzzzzzz"],
    ["hex-like with a non-hex char", "abc123g"],
    ["0x prefix", "0xabc1234"],
    ["shell injection", "abc; rm -rf /"],
    ["template injection", "${evil}"],
    ["embedded newline (second line smuggled)", "abc1234\ndeadbeef"],
    ["embedded newline + header injection", "abc1234\nX-Injected: 1"],
    ["embedded CRLF", "abc1234\r\ndeadbee"],
    ["internal space", "abc1234 deadbee"],
    ["html", "<script>alert(1)</script>"],
  ])("rejects %s", (_label, raw) => {
    expect(readBuildInfo({ PCC_BUILD_SHA: raw })).toEqual(UNKNOWN);
    expect(readBuildInfo({ RAILWAY_GIT_COMMIT_SHA: raw })).toEqual(UNKNOWN);
  });
});

describe("readBuildInfo: invariants", () => {
  it("commitSource is 'unknown' exactly when commit is null", () => {
    const envs: NodeJS.ProcessEnv[] = [
      {},
      { PCC_BUILD_SHA: SHA40 },
      { RAILWAY_GIT_COMMIT_SHA: OTHER40 },
      { PCC_BUILD_SHA: "zzzzzzz" },
      { RAILWAY_GIT_COMMIT_SHA: "" },
      { PCC_BUILD_SHA: "zzzzzzz", RAILWAY_GIT_COMMIT_SHA: "${evil}" },
    ];
    for (const env of envs) {
      const info = readBuildInfo(env);
      expect(info.commit === null).toBe(info.commitSource === "unknown");
      if (info.commit !== null) expect(info.commit).toMatch(/^[0-9a-f]{7,40}$/);
    }
  });

  it("does not mutate the env it is given", () => {
    const env: NodeJS.ProcessEnv = { PCC_BUILD_SHA: "  ABC1234 ", RAILWAY_GIT_COMMIT_SHA: "zzz" };
    readBuildInfo(env);
    expect(env).toEqual({ PCC_BUILD_SHA: "  ABC1234 ", RAILWAY_GIT_COMMIT_SHA: "zzz" });
  });
});
