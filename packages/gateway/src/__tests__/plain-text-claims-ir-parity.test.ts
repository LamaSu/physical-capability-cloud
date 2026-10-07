/** Keep the IR kit's lexical detector equal to the canonical plain-text detector. */
import { describe, expect, it } from "vitest";
import {
  foldForClaims as irFoldForClaims,
  isMoneyClaim as irIsMoneyClaim,
  isProseClaim as irIsProseClaim,
  WITHHELD_FIELD as IR_WITHHELD_FIELD,
  WITHHELD_PROSE as IR_WITHHELD_PROSE,
} from "../mcp/dashboard-ir.js";
import {
  foldForClaims,
  isMoneyClaim,
  isProseClaim,
  WITHHELD_FIELD,
  WITHHELD_PROSE,
} from "../../../spec/src/money/plain-text-claims.js";
import {
  FIELD_DEFAULT_CASES,
  PLAIN_CLAIM_CASES,
  PLAIN_TEXT_CASES,
  PLAIN_TIME_ACCEPTED,
  PLAIN_TIME_REJECTED,
} from "../../../spec/src/__tests__/plain-text-fixtures.js";

// Exercise every string input from the shared corpus, including accepted kind/default
// values as well as the obfuscated claim fixtures. Non-string helper cases do not
// belong to these string-only detector entry points.
const inputs = [...new Set([
  ...PLAIN_CLAIM_CASES.map(([raw]) => raw),
  ...Object.values(PLAIN_TEXT_CASES).flatMap((cases) => cases.map(([raw]) => raw)),
  ...FIELD_DEFAULT_CASES.map(([, raw]) => raw),
  ...PLAIN_TIME_ACCEPTED,
  ...PLAIN_TIME_REJECTED,
].filter((raw): raw is string => typeof raw === "string"))];

describe("IR and spec plain-text claim detector parity", () => {
  it.each(inputs)("folds and classifies %j identically", (raw) => {
    expect(irFoldForClaims(raw)).toBe(foldForClaims(raw));
    expect(irIsMoneyClaim(raw)).toBe(isMoneyClaim(raw));
    expect(irIsProseClaim(raw)).toBe(isProseClaim(raw));
  });

  it.each(PLAIN_CLAIM_CASES)("keeps the shared prose-claim expectation for %j", (raw, expected) => {
    expect(irIsProseClaim(raw)).toBe(expected);
    expect(isProseClaim(raw)).toBe(expected);
  });

  it("keeps the prose withholding notice identical", () => {
    expect(IR_WITHHELD_PROSE).toBe(WITHHELD_PROSE);
  });

  it("keeps the field withholding notice identical", () => {
    expect(IR_WITHHELD_FIELD).toBe(WITHHELD_FIELD);
  });
});
