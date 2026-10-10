/**
 * toPlanCard — the display-ready projection the Runtype widget renders.
 *
 * The properties that matter: matched legs get real prices, unmatched legs get
 * NO price (never the placeholder), the total is matched-only, committable
 * mirrors the commitment guard, and an uncommittable plan carries a
 * plain-language reason instead of a Confirm button.
 */

import { describe, it, expect } from "vitest";
import { toPlanCard } from "../services/plan-card.js";
import type { DecompositionResult, CapabilityNode } from "@pcc/spec";

function node(p: Partial<CapabilityNode> & { id: string }): CapabilityNode {
  return {
    requestId: "req-1",
    name: p.id,
    description: "",
    capabilityType: "x",
    category: "x",
    estimatedCost: 0,
    estimatedHours: 1,
    dependencies: [],
    parallel: false,
    status: "pending",
    materials: [],
    evidenceRequirements: [],
    ...p,
  } as CapabilityNode;
}

function result(nodes: CapabilityNode[], extra: Partial<DecompositionResult> = {}): DecompositionResult {
  return {
    nodes,
    totalEstimatedCost: nodes.reduce((s, n) => s + n.estimatedCost, 0),
    totalEstimatedHours: nodes.reduce((s, n) => s + n.estimatedHours, 0),
    criticalPath: [],
    parallelTracks: [],
    ...extra,
  } as DecompositionResult;
}

const DIG = `0x${"a".repeat(64)}`;

describe("toPlanCard — a fully matched plan", () => {
  const r = result([
    node({ id: "print", name: "Print your document", description: "laser print", capabilityType: "document-printing",
      estimatedCost: 2, estimatedHours: 0.5, matchStatus: "matched", matchedCapabilityDigest: DIG, matchedCapabilityName: "Document Printing" }),
    node({ id: "mail", name: "Mail it", description: "USPS drop", capabilityType: "mail.drop",
      estimatedCost: 5, estimatedHours: 72, dependencies: ["print"], matchStatus: "matched", matchedCapabilityDigest: DIG, matchedCapabilityName: "Mail Drop" }),
  ], { criticalPath: ["print", "mail"] });
  const card = toPlanCard(r);

  it("shows plain-language legs with providers and fixed-precision prices", () => {
    expect(card.legs.map((l) => l.title)).toEqual(["Print your document", "Mail it"]);
    expect(card.legs[0]).toMatchObject({ matched: true, provider: "Document Printing", price: "2.00" });
    expect(card.legs[1]).toMatchObject({ matched: true, provider: "Mail Drop", price: "5.00" });
  });

  it("totals matched prices, fixed-precision", () => {
    expect(card.total).toBe("7.00");
    expect(card.currency).toBe("USDC");
  });

  it("ETA is the critical path, not the sum (parallel legs overlap)", () => {
    // 0.5 + 72 along the path, not summed differently
    expect(card.etaHours).toBe(72.5);
  });

  it("is committable with no blocked message", () => {
    expect(card.committable).toBe(true);
    expect(card.unfulfillable).toEqual([]);
    expect(card.blockedMessage).toBeNull();
  });
});

describe("toPlanCard — an unmatched leg is honest, not a placeholder price", () => {
  const r = result([
    node({ id: "print", name: "Print", description: "", estimatedCost: 2, matchStatus: "matched", matchedCapabilityDigest: DIG, matchedCapabilityName: "Printer" }),
    // unmatched: estimatedCost carries the UNMATCHED_UNIT_COST placeholder (10)
    node({ id: "mail", name: "Mail it", description: "", estimatedCost: 10, matchStatus: "none" }),
  ]);
  const card = toPlanCard(r);

  it("gives an unmatched leg NO price and NO provider", () => {
    const mail = card.legs.find((l) => l.id === "mail")!;
    expect(mail.matched).toBe(false);
    expect(mail.price).toBeNull();
    expect(mail.provider).toBeNull();
  });

  it("EXCLUDES the placeholder from the total — total is matched-only", () => {
    // 2 only, never 2+10
    expect(card.total).toBe("2.00");
  });

  it("is NOT committable and says why in plain language", () => {
    expect(card.committable).toBe(false);
    expect(card.unfulfillable).toEqual(["Mail it"]);
    expect(card.blockedMessage).toMatch(/no provider for: Mail it/);
  });
});

describe("toPlanCard — a matched node MISSING its digest is uncommittable", () => {
  it("treats matchStatus:matched without a digest as not-matched (guard parity)", () => {
    const r = result([
      node({ id: "print", name: "Print", estimatedCost: 2, matchStatus: "matched" /* no digest */ }),
    ]);
    const card = toPlanCard(r);
    expect(card.legs[0].matched).toBe(false);
    expect(card.committable).toBe(false);
    expect(card.total).toBe("0.00");
  });
});

describe("toPlanCard — empty decompose", () => {
  it("is not committable and says a plan could not be formed", () => {
    const card = toPlanCard(result([]));
    expect(card.legs).toEqual([]);
    expect(card.committable).toBe(false);
    expect(card.blockedMessage).toMatch(/No plan could be formed/);
  });
});
