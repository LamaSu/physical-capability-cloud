/**
 * RegistrationRepository.transitionStatus — compare-and-swap status transitions.
 *
 * The onboarding review routes used to check a registration's status with
 * findById and then write it with updateStatus, so a second writer could land
 * between the two. transitionStatus folds the status check into the UPDATE's
 * WHERE clause: whichever transition commits first wins, and the loser matches
 * zero rows and gets null instead of overwriting the winner.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store } from "../index.js";

describe("RegistrationRepository.transitionStatus (compare-and-swap)", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore({ seed: false });
    store.repos.registrations.insert({
      id: "reg-1",
      name: "reg",
      category: "fdm",
      manufacturer: "Acme",
      model: "X1",
      description: "original",
      photos: [],
      capabilities: [] as any,
      spaceRequirements: {} as any,
      pricing: { baseCost: "0", minimum: "0", currency: "USDC" } as any,
      operator: { walletAddress: "0xowner", displayName: "Op", certifications: [], trainingAcknowledgments: {} } as any,
      status: "reviewing",
      createdAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    store.close();
  });

  it("applies the transition and returns the updated row when the status matches", () => {
    const at = new Date().toISOString();
    const row = store.repos.registrations.transitionStatus("reg-1", ["submitted", "reviewing"], "approved", { approvedAt: at });
    expect(row).not.toBeNull();
    expect(row!.status).toBe("approved");
    expect(row!.approvedAt).toBe(at);
    expect(store.repos.registrations.findById("reg-1")!.status).toBe("approved");
  });

  it("returns null and writes nothing when the status is not in the from-set", () => {
    const row = store.repos.registrations.transitionStatus("reg-1", ["approved"], "active");
    expect(row).toBeNull();
    const stored = store.repos.registrations.findById("reg-1")!;
    expect(stored.status).toBe("reviewing");
    expect(stored.description).toBe("original");
  });

  it("lets exactly one of two conflicting transitions from the same state win", () => {
    const approve = store.repos.registrations.transitionStatus("reg-1", ["reviewing"], "approved", {
      approvedAt: new Date().toISOString(),
    });
    const reject = store.repos.registrations.transitionStatus("reg-1", ["reviewing"], "rejected", {
      description: "REJECTED: late",
    });
    expect(approve).not.toBeNull();
    expect(reject).toBeNull();
    const stored = store.repos.registrations.findById("reg-1")!;
    expect(stored.status).toBe("approved");
    expect(stored.description).toBe("original");
  });

  it("does not repeat a transition out of its own target state", () => {
    expect(store.repos.registrations.transitionStatus("reg-1", ["submitted", "reviewing"], "approved")).not.toBeNull();
    expect(store.repos.registrations.transitionStatus("reg-1", ["submitted", "reviewing"], "approved")).toBeNull();
  });

  it("matches nothing for an empty from-set or an unknown id", () => {
    expect(store.repos.registrations.transitionStatus("reg-1", [], "approved")).toBeNull();
    expect(store.repos.registrations.transitionStatus("missing", ["reviewing"], "approved")).toBeNull();
    expect(store.repos.registrations.findById("reg-1")!.status).toBe("reviewing");
  });

  it("writes an empty-string description when one is given (only undefined is skipped)", () => {
    const row = store.repos.registrations.transitionStatus("reg-1", ["reviewing"], "reviewing", { description: "" });
    expect(row!.description).toBe("");
  });
});
