import { describe, it, expect } from "vitest";
import {
  intentToAcpMemo,
  acpMemoToIntent,
  capabilityToJobOffering,
  jobOfferingToQuoteRequest,
  getAcpPhase,
  isPhaseTransition,
} from "../acp-bridge.js";
import type { RequestQuoteIntent, SubmitWorkflowIntent } from "@pcc/a2a";

describe("intentToAcpMemo", () => {
  it("maps request_quote to JobRequest memo in NEGOTIATION phase", () => {
    const intent: RequestQuoteIntent = {
      type: "request_quote",
      capabilityType: "hplc",
      params: { material: "peptide" },
      assuranceTier: 2,
    };

    const memo = intentToAcpMemo(intent);

    expect(memo.type).toBe("JobRequest");
    expect(memo.nextPhase).toBe("NEGOTIATION");
    expect(memo.status).toBe("pending");
    expect(JSON.parse(memo.content).type).toBe("request_quote");
  });

  it("maps submit_workflow to Transaction memo", () => {
    const intent: SubmitWorkflowIntent = {
      type: "submit_workflow",
      cwm: {},
      acceptedQuotes: { step1: "quote-001" },
      payerWallet: "0xabc",
    };

    const memo = intentToAcpMemo(intent);

    expect(memo.type).toBe("Transaction");
    expect(memo.nextPhase).toBe("TRANSACTION");
    expect(memo.payableDetails).toBeDefined();
    expect(memo.payableDetails!.currency).toBe("USDC");
  });

  it("defaults to General memo for unknown intents", () => {
    const intent = { type: "text_message", text: "hello" } as any;
    const memo = intentToAcpMemo(intent);
    expect(memo.type).toBe("General");
  });
});

describe("acpMemoToIntent", () => {
  it("round-trips a PCC intent through ACP memo format", () => {
    const original: RequestQuoteIntent = {
      type: "request_quote",
      capabilityType: "cnc-3axis",
      params: { material: "aluminum" },
      assuranceTier: 1,
    };

    const memo = intentToAcpMemo(original);
    const restored = acpMemoToIntent(memo);

    expect(restored).not.toBeNull();
    expect(restored!.type).toBe("request_quote");
    expect((restored as RequestQuoteIntent).capabilityType).toBe("cnc-3axis");
  });

  it("returns null for invalid memo content", () => {
    const result = acpMemoToIntent({
      content: "not json",
      type: "General",
      nextPhase: "REQUEST",
      status: "pending",
    });
    expect(result).toBeNull();
  });
});

describe("capabilityToJobOffering", () => {
  it("converts a PCC capability to ACP format", () => {
    const offering = capabilityToJobOffering({
      name: "HPLC Purity Analysis",
      description: "Shimadzu HPLC with UV detector",
      basePrice: "280000000", // $280 USDC
      estimatedMinutes: 240,
      parameters: { detector: "UV", sampleType: "peptide" },
    });

    expect(offering.name).toBe("HPLC Purity Analysis");
    expect(offering.price).toBe("280000000");
    expect(offering.slaMinutes).toBe(240);
    expect(offering.fundTransfer).toBe(false); // PCC uses milestone escrow
    expect(offering.deliverables).toContain("IPFS CID");
  });
});

describe("jobOfferingToQuoteRequest", () => {
  it("converts ACP job offering to PCC quote request", () => {
    const intent = jobOfferingToQuoteRequest(
      {
        name: "CNC Machining",
        description: "3-axis CNC",
        price: "500000000",
        slaMinutes: 480,
        fundTransfer: false,
        requirements: '{"material":"aluminum"}',
        deliverables: "Machined part",
      },
      "cnc-3axis",
    );

    expect(intent.type).toBe("request_quote");
    expect(intent.capabilityType).toBe("cnc-3axis");
    expect(intent.params.material).toBe("aluminum");
    expect(intent.assuranceTier).toBe(1);
  });
});

describe("getAcpPhase", () => {
  it("returns correct phases for known intents", () => {
    expect(getAcpPhase("discover_capabilities")).toBe("REQUEST");
    expect(getAcpPhase("request_quote")).toBe("NEGOTIATION");
    expect(getAcpPhase("submit_workflow")).toBe("TRANSACTION");
    expect(getAcpPhase("request_evaluation")).toBe("EVALUATION");
    expect(getAcpPhase("job_completed")).toBe("COMPLETED");
  });

  it("defaults to REQUEST for unknown intents", () => {
    expect(getAcpPhase("unknown_intent")).toBe("REQUEST");
  });
});

describe("isPhaseTransition", () => {
  it("returns true for phase-changing intents", () => {
    expect(isPhaseTransition("request_quote")).toBe(true);
    expect(isPhaseTransition("submit_workflow")).toBe(true);
    expect(isPhaseTransition("evaluation_result")).toBe(true);
  });

  it("returns false for unknown intents", () => {
    expect(isPhaseTransition("unknown")).toBe(false);
  });
});
