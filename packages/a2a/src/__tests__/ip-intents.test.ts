/**
 * Tests for IP / Story Protocol A2A intent types.
 *
 * Covers:
 *   - All 8 IP intent types can be constructed and type-narrow correctly
 *   - MessageBus routes IP intents correctly to subscribers
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MessageBus } from "../message-bus.js";
import type {
  AgentCard,
  A2AMessage,
  Intent,
  IPRegisterIntent,
  IPRegisterResultIntent,
  IPRevenueQueryIntent,
  IPRevenueResultIntent,
  IPClaimRevenueIntent,
  IPClaimResultIntent,
  IPProposeSplitIntent,
  IPSplitResponseIntent,
  IPRevenueSplitEntry,
} from "../types.js";

// ── Helpers ─────────────────────────────────────────────────────

function makeCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    id: `agent_${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Agent",
    role: "user",
    walletAddress: "0x0000000000000000000000000000000000000001",
    capabilities: [],
    endpoint: "agent://test",
    description: "test agent",
    supportedIntents: [],
    publicKey: "0xpub",
    ...overrides,
  };
}

function makeMessage(
  intent: Intent,
  overrides: Partial<A2AMessage> = {},
): A2AMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    conversationId: `conv_${Math.random().toString(36).slice(2, 8)}`,
    from: "agent_ip_requester",
    to: "agent_ip_handler",
    intent,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── Type-level guard helpers ─────────────────────────────────────

function isIPRegister(intent: Intent): intent is IPRegisterIntent {
  return intent.type === "ip_register";
}
function isIPRegisterResult(intent: Intent): intent is IPRegisterResultIntent {
  return intent.type === "ip_register_result";
}
function isIPRevenueQuery(intent: Intent): intent is IPRevenueQueryIntent {
  return intent.type === "ip_revenue_query";
}
function isIPRevenueResult(intent: Intent): intent is IPRevenueResultIntent {
  return intent.type === "ip_revenue_result";
}
function isIPClaimRevenue(intent: Intent): intent is IPClaimRevenueIntent {
  return intent.type === "ip_claim_revenue";
}
function isIPClaimResult(intent: Intent): intent is IPClaimResultIntent {
  return intent.type === "ip_claim_result";
}
function isIPProposeSplit(intent: Intent): intent is IPProposeSplitIntent {
  return intent.type === "ip_propose_split";
}
function isIPSplitResponse(intent: Intent): intent is IPSplitResponseIntent {
  return intent.type === "ip_split_response";
}

// ── Intent Construction Tests ────────────────────────────────────

describe("IP Intent Types — construction", () => {
  // ip_register

  it("constructs ip_register with required fields", () => {
    const intent: IPRegisterIntent = {
      type: "ip_register",
      capabilityId: "cap-cnc-001",
      designerAddress: "0xDEADBEEF",
      designerName: "Alice",
    };
    expect(intent.type).toBe("ip_register");
    expect(intent.capabilityId).toBe("cap-cnc-001");
    expect(intent.designerAddress).toBe("0xDEADBEEF");
    expect(intent.designerName).toBe("Alice");
    expect(intent.commercialRevShare).toBeUndefined();
  });

  it("constructs ip_register with optional commercialRevShare", () => {
    const intent: IPRegisterIntent = {
      type: "ip_register",
      capabilityId: "cap-cnc-002",
      designerAddress: "0xALICE",
      designerName: "Alice",
      commercialRevShare: 10,
    };
    expect(intent.commercialRevShare).toBe(10);
  });

  it("narrows ip_register from Intent union", () => {
    const intent: Intent = {
      type: "ip_register",
      capabilityId: "cap-test",
      designerAddress: "0xABC",
      designerName: "Bob",
    };
    expect(isIPRegister(intent)).toBe(true);
    if (isIPRegister(intent)) {
      expect(intent.capabilityId).toBe("cap-test");
    }
  });

  // ip_register_result

  it("constructs ip_register_result for success", () => {
    const intent: IPRegisterResultIntent = {
      type: "ip_register_result",
      ipId: "0xabc123abc123",
      txHash: "0xdeadbeef",
      licenseTermsId: "42",
      success: true,
    };
    expect(intent.type).toBe("ip_register_result");
    expect(intent.success).toBe(true);
    expect(intent.error).toBeUndefined();
  });

  it("constructs ip_register_result for failure with error", () => {
    const intent: IPRegisterResultIntent = {
      type: "ip_register_result",
      ipId: "",
      txHash: "",
      licenseTermsId: "",
      success: false,
      error: "STORY_PRIVATE_KEY not configured",
    };
    expect(intent.success).toBe(false);
    expect(intent.error).toBe("STORY_PRIVATE_KEY not configured");
  });

  it("narrows ip_register_result from Intent union", () => {
    const intent: Intent = {
      type: "ip_register_result",
      ipId: "0x111",
      txHash: "0x222",
      licenseTermsId: "1",
      success: true,
    };
    expect(isIPRegisterResult(intent)).toBe(true);
  });

  // ip_revenue_query

  it("constructs ip_revenue_query", () => {
    const intent: IPRevenueQueryIntent = {
      type: "ip_revenue_query",
      ipId: "0xip123",
    };
    expect(intent.type).toBe("ip_revenue_query");
    expect(intent.ipId).toBe("0xip123");
  });

  it("narrows ip_revenue_query from Intent union", () => {
    const intent: Intent = { type: "ip_revenue_query", ipId: "0xfeed" };
    expect(isIPRevenueQuery(intent)).toBe(true);
  });

  // ip_revenue_result

  it("constructs ip_revenue_result with token holders", () => {
    const intent: IPRevenueResultIntent = {
      type: "ip_revenue_result",
      ipId: "0xip456",
      totalRevenue: "5000",
      unclaimedRevenue: "3000",
      tokenHolders: [
        { address: "0xDESIGNER", tokensHeld: 10, claimable: "300" },
        { address: "0xOPERATOR", tokensHeld: 70, claimable: "2100" },
        { address: "0xVERIFIER", tokensHeld: 10, claimable: "300" },
        { address: "0xNETWORK", tokensHeld: 10, claimable: "300" },
      ],
    };
    expect(intent.type).toBe("ip_revenue_result");
    expect(intent.tokenHolders).toHaveLength(4);
    expect(
      intent.tokenHolders.reduce((s, h) => s + h.tokensHeld, 0),
    ).toBe(100);
  });

  it("constructs ip_revenue_result with empty vault", () => {
    const intent: IPRevenueResultIntent = {
      type: "ip_revenue_result",
      ipId: "0xip789",
      totalRevenue: "0",
      unclaimedRevenue: "0",
      tokenHolders: [],
    };
    expect(intent.totalRevenue).toBe("0");
    expect(intent.tokenHolders).toHaveLength(0);
  });

  it("narrows ip_revenue_result from Intent union", () => {
    const intent: Intent = {
      type: "ip_revenue_result",
      ipId: "0xfeed",
      totalRevenue: "0",
      unclaimedRevenue: "0",
      tokenHolders: [],
    };
    expect(isIPRevenueResult(intent)).toBe(true);
  });

  // ip_claim_revenue

  it("constructs ip_claim_revenue without tokenIds", () => {
    const intent: IPClaimRevenueIntent = {
      type: "ip_claim_revenue",
      ipId: "0xip000",
    };
    expect(intent.type).toBe("ip_claim_revenue");
    expect(intent.tokenIds).toBeUndefined();
  });

  it("constructs ip_claim_revenue with specific tokenIds", () => {
    const intent: IPClaimRevenueIntent = {
      type: "ip_claim_revenue",
      ipId: "0xip000",
      tokenIds: ["tok1", "tok2", "tok3"],
    };
    expect(intent.tokenIds).toHaveLength(3);
  });

  it("narrows ip_claim_revenue from Intent union", () => {
    const intent: Intent = { type: "ip_claim_revenue", ipId: "0xip" };
    expect(isIPClaimRevenue(intent)).toBe(true);
  });

  // ip_claim_result

  it("constructs ip_claim_result for successful claim", () => {
    const intent: IPClaimResultIntent = {
      type: "ip_claim_result",
      txHash: "0xclaim_tx",
      claimed: "3000",
      success: true,
    };
    expect(intent.type).toBe("ip_claim_result");
    expect(intent.success).toBe(true);
    expect(intent.claimed).toBe("3000");
  });

  it("constructs ip_claim_result with zero claimed when vault empty", () => {
    const intent: IPClaimResultIntent = {
      type: "ip_claim_result",
      txHash: "0x000",
      claimed: "0",
      success: true,
    };
    expect(intent.claimed).toBe("0");
  });

  it("narrows ip_claim_result from Intent union", () => {
    const intent: Intent = {
      type: "ip_claim_result",
      txHash: "0x0",
      claimed: "0",
      success: false,
    };
    expect(isIPClaimResult(intent)).toBe(true);
  });

  // ip_propose_split

  it("constructs ip_propose_split with all collaborator roles", () => {
    const splits: IPRevenueSplitEntry[] = [
      { address: "0xDESIGNER", role: "designer", percentage: 10, label: "CSD Author" },
      { address: "0xOPERATOR", role: "operator", percentage: 70, label: "Machine Operator" },
      { address: "0xVERIFIER", role: "verifier", percentage: 10, label: "Evidence Verifier" },
      { address: "0xNETWORK", role: "curator", percentage: 10, label: "Network Treasury" },
    ];

    const intent: IPProposeSplitIntent = {
      type: "ip_propose_split",
      ipId: "0xip_negotiate",
      splits,
    };

    expect(intent.type).toBe("ip_propose_split");
    expect(intent.splits).toHaveLength(4);
    expect(
      intent.splits.reduce((s, e) => s + e.percentage, 0),
    ).toBe(100);
  });

  it("accepts assembler role in splits", () => {
    const splits: IPRevenueSplitEntry[] = [
      { address: "0xASM", role: "assembler", percentage: 100, label: "Assembler" },
    ];
    const intent: IPProposeSplitIntent = {
      type: "ip_propose_split",
      ipId: "0xasm_ip",
      splits,
    };
    expect(intent.splits[0].role).toBe("assembler");
  });

  it("accepts the full ADR-12 ContributorRole enum in splits", () => {
    const splits: IPRevenueSplitEntry[] = [
      { address: "0xOP",  role: "operator",            percentage: 87, label: "Operator" },
      { address: "0xVR",  role: "verifier",            percentage:  3, label: "Verifier" },
      { address: "0xPA",  role: "protocol-author",     percentage:  2, label: "CSD Author" },
      { address: "0xIN",  role: "integrator",          percentage:  2, label: "Integrator" },
      { address: "0xMA",  role: "model-author",        percentage:  4, label: "Model Author" },
      { address: "0xNT",  role: "network-treasury",    percentage:  2, label: "Treasury" },
    ];
    const intent: IPProposeSplitIntent = {
      type: "ip_propose_split",
      ipId: "0xnew_roles_ip",
      splits,
    };
    expect(intent.splits).toHaveLength(6);
    expect(intent.splits.reduce((s, e) => s + e.percentage, 0)).toBe(100);
    const roles = intent.splits.map((e) => e.role);
    expect(roles).toContain("protocol-author");
    expect(roles).toContain("integrator");
    expect(roles).toContain("model-author");
    expect(roles).toContain("network-treasury");
  });

  it("accepts insurer and dataset-contributor roles", () => {
    const splits: IPRevenueSplitEntry[] = [
      { address: "0xINS", role: "insurer",             percentage: 50, label: "Insurer" },
      { address: "0xDS",  role: "dataset-contributor", percentage: 50, label: "Pilot" },
    ];
    const intent: IPProposeSplitIntent = {
      type: "ip_propose_split",
      ipId: "0xinsurer_ip",
      splits,
    };
    expect(intent.splits[0].role).toBe("insurer");
    expect(intent.splits[1].role).toBe("dataset-contributor");
  });

  it("narrows ip_propose_split from Intent union", () => {
    const intent: Intent = {
      type: "ip_propose_split",
      ipId: "0xip",
      splits: [{ address: "0x1", role: "operator", percentage: 100, label: "All" }],
    };
    expect(isIPProposeSplit(intent)).toBe(true);
  });

  // ip_split_response

  it("constructs ip_split_response for accepted split", () => {
    const intent: IPSplitResponseIntent = {
      type: "ip_split_response",
      accepted: true,
      splits: [
        { address: "0xA", role: "operator", percentage: 100, label: "All" },
      ],
    };
    expect(intent.type).toBe("ip_split_response");
    expect(intent.accepted).toBe(true);
    expect(intent.counterProposal).toBeUndefined();
  });

  it("constructs ip_split_response for counter-proposal", () => {
    const intent: IPSplitResponseIntent = {
      type: "ip_split_response",
      accepted: false,
      counterProposal: true,
      splits: [
        { address: "0xDESIGNER", role: "designer", percentage: 15, label: "CSD Author" },
        { address: "0xOPERATOR", role: "operator", percentage: 75, label: "Operator" },
        { address: "0xNETWORK", role: "curator", percentage: 10, label: "Network" },
      ],
    };
    expect(intent.accepted).toBe(false);
    expect(intent.counterProposal).toBe(true);
    expect(intent.splits).toHaveLength(3);
  });

  it("constructs ip_split_response for flat rejection (no counter)", () => {
    const intent: IPSplitResponseIntent = {
      type: "ip_split_response",
      accepted: false,
    };
    expect(intent.accepted).toBe(false);
    expect(intent.splits).toBeUndefined();
    expect(intent.counterProposal).toBeUndefined();
  });

  it("narrows ip_split_response from Intent union", () => {
    const intent: Intent = {
      type: "ip_split_response",
      accepted: true,
    };
    expect(isIPSplitResponse(intent)).toBe(true);
  });
});

// ── MessageBus Routing Tests ─────────────────────────────────────

describe("MessageBus routes IP intents", () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
  });

  it("delivers ip_register to an IP handler agent", async () => {
    const handler = makeCard({ id: "agent_ip_handler", supportedIntents: ["ip_register"] });
    bus.register(handler);

    const received = vi.fn();
    bus.subscribe("agent_ip_handler", received);

    const intent: IPRegisterIntent = {
      type: "ip_register",
      capabilityId: "cap-bus-001",
      designerAddress: "0xAAA",
      designerName: "Alice",
    };

    await bus.send(makeMessage(intent, { to: "agent_ip_handler" }));

    expect(received).toHaveBeenCalledOnce();
    const msg = received.mock.calls[0][0] as A2AMessage;
    expect(msg.intent.type).toBe("ip_register");
    if (isIPRegister(msg.intent)) {
      expect(msg.intent.capabilityId).toBe("cap-bus-001");
    }
  });

  it("delivers ip_register_result back to requester", async () => {
    const requester = makeCard({ id: "agent_ip_requester" });
    bus.register(requester);

    const received = vi.fn();
    bus.subscribe("agent_ip_requester", received);

    const intent: IPRegisterResultIntent = {
      type: "ip_register_result",
      ipId: "0xipBUS",
      txHash: "0xtxBUS",
      licenseTermsId: "7",
      success: true,
    };

    await bus.send(makeMessage(intent, { to: "agent_ip_requester" }));

    expect(received).toHaveBeenCalledOnce();
    const msg = received.mock.calls[0][0] as A2AMessage;
    if (isIPRegisterResult(msg.intent)) {
      expect(msg.intent.ipId).toBe("0xipBUS");
      expect(msg.intent.success).toBe(true);
    }
  });

  it("delivers ip_revenue_query to revenue handler", async () => {
    const revenueHandler = makeCard({
      id: "agent_revenue_handler",
      supportedIntents: ["ip_revenue_query"],
    });
    bus.register(revenueHandler);

    const received = vi.fn();
    bus.subscribe("agent_revenue_handler", received);

    const intent: IPRevenueQueryIntent = {
      type: "ip_revenue_query",
      ipId: "0xip_revenue_bus",
    };

    await bus.send(makeMessage(intent, { to: "agent_revenue_handler" }));

    expect(received).toHaveBeenCalledOnce();
    const msg = received.mock.calls[0][0] as A2AMessage;
    expect(msg.intent.type).toBe("ip_revenue_query");
    if (isIPRevenueQuery(msg.intent)) {
      expect(msg.intent.ipId).toBe("0xip_revenue_bus");
    }
  });

  it("delivers ip_revenue_result with token holders", async () => {
    const requester = makeCard({ id: "agent_revenue_requester" });
    bus.register(requester);

    const received = vi.fn();
    bus.subscribe("agent_revenue_requester", received);

    const intent: IPRevenueResultIntent = {
      type: "ip_revenue_result",
      ipId: "0xip_res",
      totalRevenue: "10000",
      unclaimedRevenue: "5000",
      tokenHolders: [
        { address: "0xH1", tokensHeld: 50, claimable: "2500" },
        { address: "0xH2", tokensHeld: 50, claimable: "2500" },
      ],
    };

    await bus.send(makeMessage(intent, { to: "agent_revenue_requester" }));

    expect(received).toHaveBeenCalledOnce();
    const msg = received.mock.calls[0][0] as A2AMessage;
    if (isIPRevenueResult(msg.intent)) {
      expect(msg.intent.totalRevenue).toBe("10000");
      expect(msg.intent.tokenHolders).toHaveLength(2);
    }
  });

  it("delivers ip_claim_revenue to claim handler", async () => {
    const claimHandler = makeCard({
      id: "agent_claim_handler",
      supportedIntents: ["ip_claim_revenue"],
    });
    bus.register(claimHandler);

    const received = vi.fn();
    bus.subscribe("agent_claim_handler", received);

    await bus.send(
      makeMessage(
        { type: "ip_claim_revenue", ipId: "0xip_claim" },
        { to: "agent_claim_handler" },
      ),
    );

    expect(received).toHaveBeenCalledOnce();
    const msg = received.mock.calls[0][0] as A2AMessage;
    expect(msg.intent.type).toBe("ip_claim_revenue");
  });

  it("delivers ip_claim_result back to claimer", async () => {
    const claimer = makeCard({ id: "agent_claimer" });
    bus.register(claimer);

    const received = vi.fn();
    bus.subscribe("agent_claimer", received);

    const intent: IPClaimResultIntent = {
      type: "ip_claim_result",
      txHash: "0xclaim_hash",
      claimed: "500",
      success: true,
    };

    await bus.send(makeMessage(intent, { to: "agent_claimer" }));

    expect(received).toHaveBeenCalledOnce();
    const msg = received.mock.calls[0][0] as A2AMessage;
    if (isIPClaimResult(msg.intent)) {
      expect(msg.intent.claimed).toBe("500");
    }
  });

  it("delivers ip_propose_split during contract negotiation", async () => {
    const broker = makeCard({
      id: "agent_broker",
      supportedIntents: ["ip_propose_split"],
    });
    bus.register(broker);

    const received = vi.fn();
    bus.subscribe("agent_broker", received);

    const intent: IPProposeSplitIntent = {
      type: "ip_propose_split",
      ipId: "0xnegotiate_ip",
      splits: [
        { address: "0xOP", role: "operator", percentage: 80, label: "Operator" },
        { address: "0xNET", role: "curator", percentage: 20, label: "Network" },
      ],
    };

    await bus.send(makeMessage(intent, { to: "agent_broker" }));

    expect(received).toHaveBeenCalledOnce();
    const msg = received.mock.calls[0][0] as A2AMessage;
    if (isIPProposeSplit(msg.intent)) {
      expect(msg.intent.splits).toHaveLength(2);
    }
  });

  it("delivers ip_split_response with counter-proposal back to user agent", async () => {
    const userAgent = makeCard({ id: "agent_user_negotiate" });
    bus.register(userAgent);

    const received = vi.fn();
    bus.subscribe("agent_user_negotiate", received);

    const intent: IPSplitResponseIntent = {
      type: "ip_split_response",
      accepted: false,
      counterProposal: true,
      splits: [
        { address: "0xOP", role: "operator", percentage: 90, label: "Operator" },
        { address: "0xNET", role: "curator", percentage: 10, label: "Network" },
      ],
    };

    await bus.send(makeMessage(intent, { to: "agent_user_negotiate" }));

    expect(received).toHaveBeenCalledOnce();
    const msg = received.mock.calls[0][0] as A2AMessage;
    if (isIPSplitResponse(msg.intent)) {
      expect(msg.intent.accepted).toBe(false);
      expect(msg.intent.counterProposal).toBe(true);
      expect(msg.intent.splits).toHaveLength(2);
    }
  });

  it("findByIntent finds IP-capable agents", () => {
    bus.register(
      makeCard({
        id: "agent_ip_mgr",
        supportedIntents: ["ip_register", "ip_claim_revenue", "ip_propose_split"],
      }),
    );
    bus.register(
      makeCard({ id: "agent_other", supportedIntents: ["discover_capabilities"] }),
    );

    const ipAgents = bus.findByIntent("ip_register");
    expect(ipAgents).toHaveLength(1);
    expect(ipAgents[0].id).toBe("agent_ip_mgr");
  });

  it("conversation topic is set to the IP intent type", async () => {
    const handler = makeCard({ id: "agent_ip_topic" });
    bus.register(handler);

    const convId = "conv_ip_test_001";
    const msg = makeMessage(
      { type: "ip_revenue_query", ipId: "0xip_topic" },
      { conversationId: convId, to: "agent_ip_topic" },
    );
    await bus.send(msg);

    const convo = bus.getConversation(convId);
    expect(convo).toBeDefined();
    expect(convo!.topic).toBe("ip_revenue_query");
  });
});
