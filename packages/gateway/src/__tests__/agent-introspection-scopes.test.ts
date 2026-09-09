/**
 * agent-introspection scopeSatisfied — narrow keys must report the truth.
 *
 * This endpoint exists so an agent learns what to ask for instead of just
 * failing ("failing a request is not an interface. needs_scope:operator.write
 * is"). It advertises a DOTTED vocabulary (operator.write, jobs.read,
 * settlement.read) while middleware/scope-checker.ts enforces a FLAT one
 * (operator, settlement, admin, ...). The two sets are disjoint.
 *
 * That was invisible while every key carried "*" — the function's own docstring
 * says it was written for exactly that world. PR #309 mints self-service keys
 * as ["operator"], at which point a brand-new key satisfied NOTHING here and
 * this endpoint told every fresh agent it could reach nothing, while the actual
 * requests would have succeeded. These tests pin the bridge between the two
 * vocabularies so that regression cannot come back silently.
 */

import { describe, it, expect } from "vitest";
import { scopeSatisfied } from "../routes/agent-introspection.js";

describe("scopeSatisfied — dotted advertisement vs flat enforcement", () => {
  it("still honours the legacy wildcard", () => {
    expect(scopeSatisfied(["*"], "operator.write")).toBe(true);
    expect(scopeSatisfied(["*"], "settlement.read")).toBe(true);
  });

  it("treats a null requirement as always satisfied", () => {
    expect(scopeSatisfied([], null)).toBe(true);
  });

  // The regression PR #309 would otherwise have shipped.
  it("a flat `operator` key satisfies the operator family", () => {
    expect(scopeSatisfied(["operator"], "operator.read")).toBe(true);
    expect(scopeSatisfied(["operator"], "operator.write")).toBe(true);
  });

  it("a flat `settlement` key satisfies the settlement family", () => {
    expect(scopeSatisfied(["operator", "settlement"], "settlement.read")).toBe(true);
  });

  it("`admin` satisfies everything, as it does in the scope-checker", () => {
    expect(scopeSatisfied(["admin"], "operator.write")).toBe(true);
    expect(scopeSatisfied(["admin"], "settlement.read")).toBe(true);
    expect(scopeSatisfied(["admin"], "jobs.write")).toBe(true);
  });

  it("still honours an explicit dotted grant and a family wildcard", () => {
    expect(scopeSatisfied(["operator.read"], "operator.read")).toBe(true);
    expect(scopeSatisfied(["operator.*"], "operator.write")).toBe(true);
  });

  // The load-bearing negatives: bridging the vocabularies must not make this
  // endpoint claim reachability it does not have.
  it("does NOT let one family satisfy another", () => {
    expect(scopeSatisfied(["operator"], "settlement.read")).toBe(false);
    expect(scopeSatisfied(["operator"], "jobs.write")).toBe(false);
    expect(scopeSatisfied(["settlement"], "operator.write")).toBe(false);
  });

  it("reports nothing reachable for a key with no scopes", () => {
    expect(scopeSatisfied([], "operator.read")).toBe(false);
    expect(scopeSatisfied([], "settlement.read")).toBe(false);
  });

  it("does not treat a partial family-name match as a hit", () => {
    expect(scopeSatisfied(["oper"], "operator.read")).toBe(false);
    expect(scopeSatisfied(["operatorx"], "operator.read")).toBe(false);
  });
});
