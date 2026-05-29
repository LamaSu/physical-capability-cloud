import { describe, it, expect } from "vitest";
import {
  isHybridActive,
  isHybridServed,
  readRankerMode,
} from "../ranker-config.js";

describe("readRankerMode", () => {
  it("defaults to legacy", () => {
    expect(readRankerMode({} as NodeJS.ProcessEnv)).toBe("legacy");
    expect(
      readRankerMode({ PCC_RANKER_MODE: "" } as NodeJS.ProcessEnv),
    ).toBe("legacy");
  });

  it("accepts legacy / shadow / hybrid", () => {
    expect(
      readRankerMode({ PCC_RANKER_MODE: "legacy" } as NodeJS.ProcessEnv),
    ).toBe("legacy");
    expect(
      readRankerMode({ PCC_RANKER_MODE: "shadow" } as NodeJS.ProcessEnv),
    ).toBe("shadow");
    expect(
      readRankerMode({ PCC_RANKER_MODE: "hybrid" } as NodeJS.ProcessEnv),
    ).toBe("hybrid");
  });

  it("is case-insensitive", () => {
    expect(
      readRankerMode({ PCC_RANKER_MODE: "Hybrid" } as NodeJS.ProcessEnv),
    ).toBe("hybrid");
  });

  it("falls back to legacy on unknown values", () => {
    expect(
      readRankerMode({ PCC_RANKER_MODE: "bogus" } as NodeJS.ProcessEnv),
    ).toBe("legacy");
  });
});

describe("isHybridActive + isHybridServed", () => {
  it("isHybridActive: shadow + hybrid true; legacy false", () => {
    expect(isHybridActive("legacy")).toBe(false);
    expect(isHybridActive("shadow")).toBe(true);
    expect(isHybridActive("hybrid")).toBe(true);
  });

  it("isHybridServed: only hybrid true", () => {
    expect(isHybridServed("legacy")).toBe(false);
    expect(isHybridServed("shadow")).toBe(false);
    expect(isHybridServed("hybrid")).toBe(true);
  });
});
