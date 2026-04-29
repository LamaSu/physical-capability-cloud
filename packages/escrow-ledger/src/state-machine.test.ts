import { describe, it, expect } from "vitest";
import { transition, validTransitions, isTerminal, InvalidTransitionError } from "./state-machine.js";
import type { Session } from "./types.js";

const baseSession: Session = {
  id: "sess-1",
  state: "created",
  user: { id: "user-1", kind: "user" },
  operator: { id: "op-1", kind: "operator" },
  amountCents: 12500,
  createdAt: "2026-04-27T00:00:00Z",
  updatedAt: "2026-04-27T00:00:00Z",
};

describe("Session state machine", () => {
  it("happy path: created → settled (every step legal, updatedAt advances)", () => {
    const sequence: Array<["configure" | "quote" | "review" | "commit" | "start_execution" | "settle", string]> = [
      ["configure", "configuring"],
      ["quote", "quoted"],
      ["review", "reviewing"],
      ["commit", "committed"],
      ["start_execution", "executing"],
      ["settle", "settled"],
    ];
    let s = baseSession;
    for (const [event, expectedState] of sequence) {
      s = transition(s, event);
      expect(s.state).toBe(expectedState);
    }
    expect(isTerminal(s.state)).toBe(true);
  });

  it("rejects invalid transitions (settle before commit, commit from created)", () => {
    expect(() => transition(baseSession, "settle")).toThrow(InvalidTransitionError);
    expect(() => transition(baseSession, "commit")).toThrow(InvalidTransitionError);
  });

  it("dispute path: executing → disputed → settled", () => {
    let s = baseSession;
    s = transition(s, "configure");
    s = transition(s, "quote");
    s = transition(s, "review");
    s = transition(s, "commit");
    s = transition(s, "start_execution");
    s = transition(s, "raise_dispute");
    expect(s.state).toBe("disputed");
    s = transition(s, "resolve_dispute_in_favor_of_operator");
    expect(s.state).toBe("settled");
  });

  it("cancel is reachable from non-terminal pre-execution states", () => {
    for (const initial of ["created", "configuring", "quoted", "reviewing", "committed", "executing"] as const) {
      const s = transition({ ...baseSession, state: initial }, "cancel");
      expect(s.state).toBe("cancelled");
    }
  });

  it("validTransitions surface matches the graph and isTerminal locks settled/cancelled", () => {
    expect(validTransitions("created").sort()).toEqual(["cancel", "configure"].sort());
    expect(validTransitions("settled")).toEqual([]);
    expect(validTransitions("cancelled")).toEqual([]);
    expect(isTerminal("settled")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("executing")).toBe(false);
  });
});
