/**
 * product-qa #36: the negotiation session badge maps @pcc/spec's real (lowercase) SessionStatus
 * values exactly. It used to switch on uppercase words the API never sends, so everything rendered
 * gray.
 */
import { describe, it, expect } from "vitest";
import { SESSION_PIPELINE, SESSION_STATUSES, sessionPipelineIndex, sessionStatusColor } from "../negotiation-status.js";

describe("sessionStatusColor: one exact map over the spec's SessionStatus", () => {
  it("covers every spec status, and a bare session status is never green", () => {
    expect([...SESSION_STATUSES].sort()).toEqual(
      ["cancelled", "committed", "configuring", "created", "expired", "quoted", "reviewing", "settlement_failed"],
    );
    for (const s of SESSION_STATUSES) expect([s, sessionStatusColor(s)]).not.toEqual([s, "green"]);
  });

  it("settlement_failed has the failure tone; committed is funds-committed-no-outcome (gold); terminal states are gray", () => {
    expect(sessionStatusColor("settlement_failed")).toBe("red");
    expect(sessionStatusColor("committed")).toBe("gold");
    expect(["quoted", "reviewing"].map(sessionStatusColor)).toEqual(["gold", "gold"]);
    expect(["created", "configuring", "expired", "cancelled"].map(sessionStatusColor)).toEqual(["gray", "gray", "gray", "gray"]);
  });

  it("unknown values fail closed to gray: the old uppercase words, prototype keys, non-strings", () => {
    for (const v of ["COMMITTED", "QUOTED", "Committed", " committed", "funded", "", "constructor", "toString", "__proto__", "hasOwnProperty", null, undefined, 1, {}, ["committed"]]) {
      expect([v, sessionStatusColor(v)]).toEqual([v, "gray"]);
    }
  });
});

describe("sessionPipelineIndex: the happy path, in order", () => {
  it("indexes created..committed; statuses off the path and unknown values are -1", () => {
    expect(SESSION_PIPELINE).toEqual(["created", "configuring", "quoted", "reviewing", "committed"]);
    expect(["created", "configuring", "quoted", "reviewing", "committed"].map(sessionPipelineIndex)).toEqual([0, 1, 2, 3, 4]);
    for (const v of ["settlement_failed", "expired", "cancelled", "COMMITTED", "", null, 3]) expect([v, sessionPipelineIndex(v)]).toEqual([v, -1]);
  });
});
