/**
 * OrderTranslator — bridges Cypher federation orders and PCC A2A
 * intents in both directions.
 *
 * - `cypherOrderToPccA2aIntent`: inbound. Cypher `Order` → PCC
 *   `submit_workflow` intent payload that the gateway can hand to
 *   `/api/jobs/submit` (or `/api/build/contract` for `quote`-priced
 *   services that need negotiation first).
 * - `pccSettlementToCypherOrderUpdate`: outbound. When a PCC job
 *   settles, produce the body to POST to Cypher's
 *   `/api/federation/orders/:id/status` endpoint.
 *
 * The translator does NOT make HTTP calls itself — it builds payloads
 * that the endpoint module (or a caller) sends. That keeps the
 * translator pure / easy to test.
 */

import type {
  CypherOrder,
  CypherOrderPriority,
  CypherOrderUpdate,
  PccA2aIntent,
  PccSettlementEvent,
} from "./types.js";

export interface OrderTranslatorOptions {
  /** PCC gateway base URL (used to derive callback URLs). */
  pccGatewayUrl: string;
  /** Cypher's instance id (so we tag outbound A2A intents). */
  cypherInstanceId?: string;
  /**
   * Resolver that maps a Cypher `federatedServiceId` to a PCC
   * capability id. The simple default uses the Cypher service id
   * directly, but real deployments should plug in a service-id
   * registry.
   */
  resolveCapabilityId?: (federatedServiceId: string) => string;
}

export interface TranslateContext {
  /** Optional: override capability resolution for one call. */
  capabilityIdOverride?: string;
  /**
   * Public URL Cypher will poll / PCC will push status updates to.
   * When undefined we fall back to `${pccGatewayUrl}/cypher/federation/orders/:id/status`.
   */
  callbackUrlOverride?: string;
}

export class OrderTranslator {
  private readonly pccGatewayUrl: string;
  private readonly cypherInstanceId?: string;
  private readonly resolveCapabilityId: (id: string) => string;

  constructor(opts: OrderTranslatorOptions) {
    if (!opts.pccGatewayUrl) {
      throw new Error("OrderTranslator: pccGatewayUrl is required");
    }
    this.pccGatewayUrl = opts.pccGatewayUrl.replace(/\/+$/, "");
    this.cypherInstanceId = opts.cypherInstanceId;
    this.resolveCapabilityId = opts.resolveCapabilityId ?? ((id) => id);
  }

  /**
   * Convert an inbound Cypher `Order` into a PCC A2A
   * `submit_workflow` intent payload.
   *
   * Mapping rules:
   * - `order.federatedServiceId` → `intent.capabilityId`
   *   (via the resolver — defaults to identity).
   * - `order.orderData` → `intent.params` (verbatim — PCC's job
   *   submit endpoint validates against the capability's input
   *   schema).
   * - `order.priority` → `intent.assuranceTier` per the table below.
   * - `intent.callbackUrl` → URL Cypher should poll / PCC pushes
   *   settlement to.
   *
   * Priority → tier mapping:
   * | priority | tier |
   * |---|---|
   * | scheduled | 0 |
   * | standard  | 1 |
   * | rush      | 2 |
   * | express   | 2 |
   *
   * (Tier 3 is reserved for medical / aerospace work that requires
   * ZK-attested evidence chains — that's an opt-in lane Cypher
   * doesn't drive today.)
   */
  cypherOrderToPccA2aIntent(order: CypherOrder, ctx: TranslateContext = {}): PccA2aIntent {
    if (!order || !order._id) {
      throw new Error("OrderTranslator.cypherOrderToPccA2aIntent: order._id is required");
    }
    if (!order.federatedServiceId) {
      throw new Error(
        "OrderTranslator.cypherOrderToPccA2aIntent: order.federatedServiceId is required",
      );
    }

    const capabilityId =
      ctx.capabilityIdOverride ?? this.resolveCapabilityId(order.federatedServiceId);

    const callbackUrl =
      ctx.callbackUrlOverride ??
      `${this.pccGatewayUrl}/cypher/federation/orders/${encodeURIComponent(order._id)}/status`;

    return {
      type: "submit_workflow",
      capabilityId,
      params: order.orderData ?? {},
      assuranceTier: priorityToTier(order.priority),
      callbackUrl,
      origin: {
        source: "cypher-federation",
        cypherOrderId: order._id,
        cypherOrderNumber: order.orderNumber,
        cypherInstanceId: this.cypherInstanceId,
      },
    };
  }

  /**
   * Build the body to POST to Cypher's
   * `/api/federation/orders/:id/status` when a PCC job settles.
   */
  pccSettlementToCypherOrderUpdate(
    settlement: PccSettlementEvent,
    orderId: string,
  ): CypherOrderUpdate {
    if (!orderId) {
      throw new Error(
        "OrderTranslator.pccSettlementToCypherOrderUpdate: orderId is required",
      );
    }
    if (!settlement || !settlement.jobId) {
      throw new Error(
        "OrderTranslator.pccSettlementToCypherOrderUpdate: settlement.jobId is required",
      );
    }

    const status: CypherOrderUpdate["status"] =
      settlement.status === "completed"
        ? "completed"
        : settlement.status === "cancelled"
          ? "cancelled"
          : "failed";

    return {
      orderId,
      status,
      message:
        settlement.status === "completed"
          ? `PCC job ${settlement.jobId} settled. Evidence ${settlement.evidenceBundleId ?? "none"}.`
          : settlement.reason ?? `PCC job ${settlement.jobId} ${settlement.status}`,
      settlement: {
        pccJobId: settlement.jobId,
        evidenceBundleId: settlement.evidenceBundleId,
        escrowAddress: settlement.escrowAddress,
        txHash: settlement.txHash,
        completedAt: settlement.completedAt,
      },
    };
  }
}

function priorityToTier(p: CypherOrderPriority | undefined): 0 | 1 | 2 | 3 {
  switch (p) {
    case "scheduled":
      return 0;
    case "rush":
    case "express":
      return 2;
    case "standard":
    default:
      return 1;
  }
}
