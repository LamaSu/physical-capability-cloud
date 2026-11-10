import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as spec from "../money/plain-text-claims.js";
import { nameText, idText, statusPillText, reportedText } from "../money/money-status.js";
import { BIDI_CONTROL_POINTS, DEFAULT_IGNORABLE_POINTS } from "./plain-text-fixtures.js";
const source = readFileSync(new URL("../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js", import.meta.url), "utf8");
type Kit = { mentionsWithheld: (s: string) => boolean; isProseClaim: (s: string) => boolean; isMoneyClaim: (s: string) => boolean; statesAmount: (s: string) => boolean; nameText: (s: string) => { t: string }; idText: (s: string) => { t: string }; statusPillText: (s: string, v: boolean, m: boolean) => { t: string }; reportedText: (s: string, v: boolean, m: boolean) => { t: string } };
const context: { kit?: Kit } = {};
const helpers = source.replace(/  if \(document\.readyState === 'loading'\)[\s\S]*?\n\}\)\(\);\s*$/, "window.kit = { mentionsWithheld, isProseClaim, isMoneyClaim, statesAmount, nameText, idText, statusPillText, reportedText };\n})();");
if (helpers === source) throw new Error("missing boot dispatch");
new Function("window", "document", helpers)(context, {});
const kit = context.kit!;
for (const [copy, detector] of [["spec", spec], ["kit", kit]] as const) {
  describe(copy + " bidi/invisible guard", () => {
    it.each(BIDI_CONTROL_POINTS)("withholds raw Bidi_Control U+%s in both predicates", (cp) => {
      const raw = "Plate reader run 3" + String.fromCodePoint(cp);
      expect(detector.isProseClaim(raw)).toBe(true);
      expect(detector.isMoneyClaim(raw)).toBe(true);
    });
    it("folds EVERY Default_Ignorable before detecting a claim", () => {
      const missed = DEFAULT_IGNORABLE_POINTS.filter((cp) => !detector.isProseClaim("veri" + String.fromCodePoint(cp) + "fied"));
      expect(missed.map((cp) => "U+" + cp.toString(16))).toEqual([]);
    });
    it.each([0x05d0, 0x0627, 0x05f3, 0x07ca, 0x10840, 0x1e900])("checks amounts after removing strong RTL U+%s", (cp) => {
      const raw = "$" + String.fromCodePoint(cp) + "5,000";
      expect(detector.statesAmount(raw)).toBe(true);
      expect(detector.isMoneyClaim(raw)).toBe(true);
      expect(detector.isProseClaim(raw)).toBe(true);
    });
    it("also checks claim words with strong RTL characters removed", () => {
      expect(detector.isMoneyClaim("veri" + String.fromCodePoint(0x05d0) + "fied")).toBe(true);
      expect(detector.isProseClaim("veri" + String.fromCodePoint(0x0627) + "fied")).toBe(true);
    });
  });
}
for (const [copy, helpers] of [["spec", { nameText, idText, statusPillText, reportedText }], ["kit", kit]] as const) {
  for (const name of ["nameText", "idText", "statusPillText", "reportedText"] as const) {
    it.each([0x202e, 0x070f])(copy + " " + name + " withholds raw directional control %s even when verified", (cp) => {
      for (const verified of [false, true]) {
        const result = helpers[name](String.fromCodePoint(cp) + "deifirev tnemyaP", verified, true);
        expect(typeof result === "string" ? result : result.t).toBe(spec.WITHHELD_FIELD);
      }
    });
  }
}

it("spec identifier pair check also sees the strong-RTL-removed view", () => {
  expect(idText("paym" + String.fromCodePoint(0x05d0) + "ent-from-the-remote-operator-received")).toBe(spec.WITHHELD_FIELD);
});
it("kit identifier pair check also sees the strong-RTL-removed view", () => {
  expect(kit.idText("paym" + String.fromCodePoint(0x0627) + "ent-from-the-remote-operator-received").t).toBe(spec.WITHHELD_FIELD);
});

it("spec reserved notice check also sees the strong-RTL-removed view", () => {
  expect(spec.mentionsWithheld("withh" + String.fromCodePoint(0x05d0) + "eld")).toBe(true);
});
it("kit reserved notice check also sees the strong-RTL-removed view", () => {
  expect(kit.mentionsWithheld("withh" + String.fromCodePoint(0x0627) + "eld")).toBe(true);
});
