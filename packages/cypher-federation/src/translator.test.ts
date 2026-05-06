import { describe, expect, it } from "vitest";

import { OrderTranslator } from "./translator.js";
import type { CypherOrder, PccSettlementEvent } from "./types.js";

const PCC_GATEWAY = "https://capability.network";

function sampleOrder(over: Partial<CypherOrder> = {}): CypherOrder {
  return {
    _id: "ord_abc123",
    orderNumber: "FED-20260506-0001",
    federatedServiceId: "srv_pcc_fdm_1",
    orderData: { quantity: 4, material: "PLA", notes: "rush job" },
    priority: "standard",
    requester: { userId: "u1", email: "ops@x", orgId: "org_1" },
    createdAt: "2026-05-06T18:00:00Z",
    status: "pending",
    ...over,
  };
}

describe("OrderTranslator constructor", () => {
  it("requires pccGatewayUrl", () => {
    // @ts-expect-error — empty options
    expect(() => new OrderTranslator({})).toThrow(/pccGatewayUrl/);
  });
});

describe("cypherOrderToPccA2aIntent", () => {
  it("maps federatedServiceId to capabilityId via the default resolver", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY });
    const intent = t.cypherOrderToPccA2aIntent(sampleOrder());
    expect(intent.type).toBe("submit_workflow");
    expect(intent.capabilityId).toBe("srv_pcc_fdm_1");
  });

  it("uses a custom capability resolver when provided", () => {
    const t = new OrderTranslator({
      pccGatewayUrl: PCC_GATEWAY,
      resolveCapabilityId: (id) => `cap-from-${id}`,
    });
    const intent = t.cypherOrderToPccA2aIntent(sampleOrder());
    expect(intent.capabilityId).toBe("cap-from-srv_pcc_fdm_1");
  });

  it("forwards orderData verbatim into intent.params", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY });
    const intent = t.cypherOrderToPccA2aIntent(sampleOrder());
    expect(intent.params).toEqual({ quantity: 4, material: "PLA", notes: "rush job" });
  });

  it("maps priority 'standard' → assuranceTier 1", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY });
    expect(t.cypherOrderToPccA2aIntent(sampleOrder()).assuranceTier).toBe(1);
  });

  it("maps priority 'rush' → assuranceTier 2", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY });
    expect(t.cypherOrderToPccA2aIntent(sampleOrder({ priority: "rush" })).assuranceTier).toBe(2);
  });

  it("maps priority 'express' → assuranceTier 2", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY });
    expect(t.cypherOrderToPccA2aIntent(sampleOrder({ priority: "express" })).assuranceTier).toBe(2);
  });

  it("maps priority 'scheduled' → assuranceTier 0", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY });
    expect(t.cypherOrderToPccA2aIntent(sampleOrder({ priority: "scheduled" })).assuranceTier).toBe(0);
  });

  it("defaults to tier 1 when priority is missing", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY });
    expect(t.cypherOrderToPccA2aIntent(sampleOrder({ priority: undefined })).assuranceTier).toBe(1);
  });

  it("emits a callbackUrl pointing back at the federation order-status endpoint", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY });
    const intent = t.cypherOrderToPccA2aIntent(sampleOrder());
    expect(intent.callbackUrl).toBe(
      `${PCC_GATEWAY}/cypher/federation/orders/ord_abc123/status`,
    );
  });

  it("URL-encodes the order id in the callback URL", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY });
    const intent = t.cypherOrderToPccA2aIntent(sampleOrder({ _id: "ord/with slash" }));
    expect(intent.callbackUrl).toBe(
      `${PCC_GATEWAY}/cypher/federation/orders/ord%2Fwith%20slash/status`,
    );
  });

  it("respects callbackUrlOverride", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY });
    const intent = t.cypherOrderToPccA2aIntent(sampleOrder(), {
      callbackUrlOverride: "https://example/cb",
    });
    expect(intent.callbackUrl).toBe("https://example/cb");
  });

  it("respects capabilityIdOverride", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY });
    const intent = t.cypherOrderToPccA2aIntent(sampleOrder(), {
      capabilityIdOverride: "explicit-cap",
    });
    expect(intent.capabilityId).toBe("explicit-cap");
  });

  it("attaches origin metadata including instance id", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY, cypherInstanceId: "waybio" });
    const intent = t.cypherOrderToPccA2aIntent(sampleOrder());
    expect(intent.origin).toEqual({
      source: "cypher-federation",
      cypherOrderId: "ord_abc123",
      cypherOrderNumber: "FED-20260506-0001",
      cypherInstanceId: "waybio",
    });
  });

  it("rejects orders missing _id", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY });
    expect(() => t.cypherOrderToPccA2aIntent(sampleOrder({ _id: "" }))).toThrow(/_id is required/);
  });

  it("rejects orders missing federatedServiceId", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY });
    expect(() => t.cypherOrderToPccA2aIntent(sampleOrder({ federatedServiceId: "" }))).toThrow(
      /federatedServiceId is required/,
    );
  });

  it("treats null orderData as empty params object", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY });
    // @ts-expect-error — orderData is required by type but we test runtime tolerance
    const intent = t.cypherOrderToPccA2aIntent(sampleOrder({ orderData: null }));
    expect(intent.params).toEqual({});
  });
});

describe("pccSettlementToCypherOrderUpdate", () => {
  it("maps a successful settlement to status='completed'", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY });
    const settlement: PccSettlementEvent = {
      jobId: "job-uuid-1",
      status: "completed",
      evidenceBundleId: "bundle-1",
      escrowAddress: "0xabc",
      txHash: "0xdef",
      completedAt: "2026-05-06T20:00:00Z",
    };
    const update = t.pccSettlementToCypherOrderUpdate(settlement, "ord_abc123");
    expect(update.orderId).toBe("ord_abc123");
    expect(update.status).toBe("completed");
    expect(update.settlement?.pccJobId).toBe("job-uuid-1");
    expect(update.settlement?.evidenceBundleId).toBe("bundle-1");
    expect(update.message).toContain("settled");
  });

  it("maps cancelled to cancelled and failed to failed", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY });
    expect(
      t.pccSettlementToCypherOrderUpdate(
        { jobId: "j1", status: "cancelled" },
        "ord1",
      ).status,
    ).toBe("cancelled");
    expect(
      t.pccSettlementToCypherOrderUpdate(
        { jobId: "j1", status: "failed", reason: "device offline" },
        "ord1",
      ).status,
    ).toBe("failed");
  });

  it("uses settlement.reason as the message on failure", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY });
    const update = t.pccSettlementToCypherOrderUpdate(
      { jobId: "j1", status: "failed", reason: "device offline" },
      "ord1",
    );
    expect(update.message).toBe("device offline");
  });

  it("rejects empty orderId or jobId", () => {
    const t = new OrderTranslator({ pccGatewayUrl: PCC_GATEWAY });
    expect(() =>
      t.pccSettlementToCypherOrderUpdate({ jobId: "j1", status: "completed" }, ""),
    ).toThrow(/orderId is required/);
    expect(() =>
      t.pccSettlementToCypherOrderUpdate({ jobId: "", status: "completed" }, "ord1"),
    ).toThrow(/jobId is required/);
  });
});
