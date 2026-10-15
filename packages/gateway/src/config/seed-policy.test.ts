import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldSeedDemoData, warnInvalidSeedDataOverride } from "./seed-policy.js";

describe.each([
  ["production", false],
  ["development", true],
  ["test", true],
  [undefined, true],
] as const)(
  "shouldSeedDemoData with NODE_ENV=%j",
  (nodeEnv, defaultSeed) => {
    it.each([
      [undefined, defaultSeed],
      ["true", true],
      ["false", false],
      ["FALSE", defaultSeed],
      ["0", defaultSeed],
      ["", defaultSeed],
    ] as const)(
      "applies PCC_SEED_DATA=%j",
      (value, expected) => {
        expect(shouldSeedDemoData(value, nodeEnv)).toBe(expected);
      },
    );
  },
);

describe("shouldSeedDemoData with an existing always-on demo default", () => {
  it.each([
    [undefined, true],
    ["true", true],
    ["false", false],
    ["FALSE", true],
    ["0", true],
    ["", true],
  ] as const)("applies PCC_SEED_DATA=%j in production", (value, expected) => {
    expect(shouldSeedDemoData(value, "production", true)).toBe(expected);
  });
});

describe("warnInvalidSeedDataOverride", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["production", false],
    ["development", true],
  ] as const)("warns once for FALSE with the %s default", (nodeEnv, defaultSeed) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnInvalidSeedDataOverride("FALSE", nodeEnv);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `Invalid PCC_SEED_DATA "FALSE"; falling back to default ${defaultSeed}.`,
    );
  });

  it.each([undefined, "true", "false"] as const)(
    "does not warn for PCC_SEED_DATA=%j",
    (value) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      warnInvalidSeedDataOverride(value, "production");

      expect(warn).not.toHaveBeenCalled();
    },
  );
});
