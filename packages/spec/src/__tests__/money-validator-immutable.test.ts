import { describe, expect, it } from "vitest";
import { SAFE_STATUS_WORDS, SAFE_MONEY_STATUS_WORDS, SETTLEMENT_READ_ROUTE, PLAIN_ID_RE, PLAIN_HEX_RE, PLAIN_TIME_RE, PLAIN_TRACE_RE, hexText, traceText } from "../money/money-status.js";

const CLAIM = "PAID IN FULL - verified by PCC";
describe("r2f runtime immutable money validators", () => {
  it.each([SAFE_STATUS_WORDS, SAFE_MONEY_STATUS_WORDS])("freezes status vocabulary %#", (words) => {
    expect(Object.isFrozen(words)).toBe(true);
    expect(() => Reflect.apply(Array.prototype.push, words, [CLAIM])).toThrow();
  });
  it.each(Object.entries({ SETTLEMENT_READ_ROUTE, PLAIN_ID_RE, PLAIN_HEX_RE, PLAIN_TIME_RE, PLAIN_TRACE_RE }))("does not export mutable RegExp state: %s", (_name, matcher) => {
    expect(matcher).not.toBeInstanceOf(RegExp);
    expect(Object.isFrozen(matcher)).toBe(true);
    expect(Reflect.get(matcher, "compile")).toBeUndefined();
    expect(Reflect.set(matcher, "test", () => true)).toBe(false);
  });
  it("keeps invalid wire values out of privileged slots", () => {
    expect(hexText(CLAIM)).toBe("unrecognised value");
    expect(traceText(CLAIM)).toBe("");
  });
});
