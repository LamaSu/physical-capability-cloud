import { describe, expect, it } from "vitest";
import { shouldSeedDemoData } from "./seed-policy.js";

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
