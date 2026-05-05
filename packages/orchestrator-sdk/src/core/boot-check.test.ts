import { describe, it, expect } from "vitest";
import { assertProductionReady, findEnabledMocks } from "./boot-check.js";

describe("findEnabledMocks", () => {
  it("returns only MOCK_* keys with value 'true'", () => {
    const env: NodeJS.ProcessEnv = {
      MOCK_X: "true",
      MOCK_Y: "false",
      MOCK_Z: "true",
      OTHER: "true",
      NODE_ENV: "test",
    };
    expect(findEnabledMocks(env)).toEqual(["MOCK_X", "MOCK_Z"]);
  });

  it("returns empty when no MOCK_* are 'true'", () => {
    const env: NodeJS.ProcessEnv = { MOCK_X: "false", MOCK_Y: "0" };
    expect(findEnabledMocks(env)).toEqual([]);
  });

  it("treats 'TRUE' as not-equal-to-'true' (strict match)", () => {
    expect(findEnabledMocks({ MOCK_X: "TRUE" })).toEqual([]);
  });
});

describe("assertProductionReady — T1.8", () => {
  it("throws in production when any MOCK_*=true", () => {
    expect(() =>
      assertProductionReady({
        NODE_ENV: "production",
        MOCK_PCC_DISCOVERY: "true",
      })
    ).toThrow(/MOCK_\* must not be true in production/);
  });

  it("throws and lists every offending mock in the message", () => {
    expect(() =>
      assertProductionReady({
        NODE_ENV: "production",
        MOCK_PCC_DISCOVERY: "true",
        MOCK_CDP: "true",
      })
    ).toThrow(/MOCK_CDP, MOCK_PCC_DISCOVERY/);
  });

  it("does NOT throw in production when no MOCK_*=true", () => {
    const r = assertProductionReady({
      NODE_ENV: "production",
      MOCK_X: "false",
      MOCK_Y: undefined,
    });
    expect(r.ok).toBe(true);
    expect(r.offendingMocks).toEqual([]);
  });

  it("does NOT throw in non-production even when MOCK_*=true", () => {
    const r = assertProductionReady({
      NODE_ENV: "development",
      MOCK_PCC_DISCOVERY: "true",
    });
    expect(r.ok).toBe(false);
    expect(r.offendingMocks).toContain("MOCK_PCC_DISCOVERY");
  });

  it("does NOT throw when NODE_ENV is unset (treats as non-production)", () => {
    const r = assertProductionReady({ MOCK_X: "true" });
    expect(r.ok).toBe(false);
  });
});
