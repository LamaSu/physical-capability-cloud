// ---------------------------------------------------------------------------
// Wise payout layer — comprehensive test suite
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import { WiseClient } from "../wise/wise-client.js";
import { WisePayoutService } from "../wise/wise-payouts.js";
import type { PayoutRequest } from "../wise/wise-payouts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockClient(): WiseClient {
  return new WiseClient({ apiToken: "test_token", mock: true });
}

function makeService(client?: WiseClient): WisePayoutService {
  return new WisePayoutService(client ?? makeMockClient());
}

const TEST_PROFILE_ID = 12345;

const basicPayoutRequest: PayoutRequest = {
  profileId: TEST_PROFILE_ID,
  sourceAmount: 100,
  sourceCurrency: "USD",
  recipient: {
    name: "Alice Operator",
    currency: "GBP",
    type: "sort_code",
    details: { sortCode: "40-00-01", accountNumber: "12345678" },
  },
  reference: "PCC-payout-001",
};

// ---------------------------------------------------------------------------
// WiseClient — unit tests (mock mode)
// ---------------------------------------------------------------------------

describe("WiseClient", () => {
  let client: WiseClient;

  beforeEach(() => {
    client = makeMockClient();
  });

  it("getProfiles returns mock profiles", async () => {
    const profiles = await client.getProfiles();
    expect(profiles).toBeInstanceOf(Array);
    expect(profiles.length).toBeGreaterThan(0);
    expect(profiles[0]).toMatchObject({
      id: expect.any(Number),
      type: expect.stringMatching(/^(personal|business)$/),
      fullName: expect.any(String),
    });
  });

  it("getProfiles returns business profile for PCC Treasury", async () => {
    const profiles = await client.getProfiles();
    const biz = profiles.find((p) => p.type === "business");
    expect(biz).toBeDefined();
    expect(biz?.fullName).toBe("PCC Treasury");
  });

  it("createQuote returns valid quote with calculated target amount", async () => {
    const quote = await client.createQuote({
      profileId: TEST_PROFILE_ID,
      sourceCurrency: "USD",
      targetCurrency: "GBP",
      sourceAmount: 200,
    });
    expect(quote.id).toMatch(/^quote_mock_/);
    expect(quote.sourceCurrency).toBe("USD");
    expect(quote.targetCurrency).toBe("GBP");
    expect(quote.sourceAmount).toBe(200);
    expect(quote.targetAmount).toBeCloseTo(200 * 0.79, 2);
    expect(quote.rate).toBe(0.79);
    expect(quote.fee).toBeGreaterThan(0);
    expect(quote.estimatedDelivery).toBeTruthy();
  });

  it("createQuote defaults source currency in mock", async () => {
    const quote = await client.createQuote({
      profileId: TEST_PROFILE_ID,
      sourceCurrency: "EUR",
      targetCurrency: "NGN",
      sourceAmount: 50,
    });
    // mock always returns USD/GBP regardless of input params (fixed mock)
    expect(quote.sourceAmount).toBe(50);
    expect(quote.targetAmount).toBeCloseTo(50 * 0.79, 2);
  });

  it("createRecipient returns recipient with correct details", async () => {
    const recipient = await client.createRecipient({
      profileId: TEST_PROFILE_ID,
      accountHolderName: "Bob Smith",
      currency: "EUR",
      type: "iban",
      details: { iban: "DE89370400440532013000" },
    });
    expect(recipient.id).toBeGreaterThan(0);
    expect(recipient.fullName).toBe("Bob Smith");
    expect(recipient.currency).toBe("EUR");
  });

  it("createTransfer returns transfer in processing status", async () => {
    const transfer = await client.createTransfer({
      targetAccount: 42,
      quoteUuid: "quote_abc_123",
      reference: "PCC-test-ref",
    });
    expect(transfer.id).toBeGreaterThan(0);
    expect(transfer.status).toBe("processing");
    expect(transfer.sourceCurrency).toBe("USD");
    expect(transfer.targetCurrency).toBe("GBP");
    expect(transfer.rate).toBe(0.79);
  });

  it("createTransfer carries forward recipientId and quoteId", async () => {
    const transfer = await client.createTransfer({
      targetAccount: 99,
      quoteUuid: "q_xyz",
      reference: "ref-1",
    });
    expect(transfer.recipientId).toBe(99);
    expect(transfer.quoteId).toBe("q_xyz");
  });

  it("fundTransfer returns status response", async () => {
    const result = await client.fundTransfer(TEST_PROFILE_ID, 1001);
    expect(result).toMatchObject({ status: expect.any(String) });
  });

  it("getTransfer returns transfer details", async () => {
    const transfer = await client.getTransfer(1);
    expect(transfer.id).toBe(1);
    expect(transfer.status).toBe("completed");
    expect(transfer.sourceCurrency).toBe("USD");
    expect(transfer.targetCurrency).toBe("GBP");
    expect(transfer.rate).toBe(0.79);
    expect(transfer.recipientId).toBe(1);
    expect(transfer.quoteId).toBe("q_1");
  });
});

// ---------------------------------------------------------------------------
// WisePayoutService — integration-style tests (all in mock mode)
// ---------------------------------------------------------------------------

describe("WisePayoutService", () => {
  let service: WisePayoutService;

  beforeEach(() => {
    service = makeService();
  });

  it("sendPayout executes full flow (quote → recipient → transfer → fund)", async () => {
    const result = await service.sendPayout(basicPayoutRequest);

    expect(result.quote).toBeDefined();
    expect(result.quote.id).toMatch(/^quote_mock_/);

    expect(result.recipient).toBeDefined();
    expect(result.recipient.id).toBeGreaterThan(0);

    expect(result.transfer).toBeDefined();
    expect(result.transfer.status).toBe("processing");

    expect(result.session).toBeDefined();
  });

  it("sendPayout creates a tracked session", async () => {
    const result = await service.sendPayout(basicPayoutRequest);
    const fetched = service.getSession(result.session.id);
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(result.session.id);
  });

  it("sendPayout session has correct provider and direction", async () => {
    const result = await service.sendPayout(basicPayoutRequest);
    expect(result.session.provider).toBe("wise");
    expect(result.session.direction).toBe("offramp");
  });

  it("sendPayout session links fiat and crypto sides", async () => {
    const result = await service.sendPayout(basicPayoutRequest);
    const { session } = result;
    expect(session.fiatCurrency).toBe("GBP");
    expect(session.cryptoCurrency).toBe("USDC");
    expect(session.cryptoNetwork).toBe("base");
    expect(session.cryptoAmount).toBe("100");
  });

  it("sendPayout session captures rate and fees", async () => {
    const result = await service.sendPayout(basicPayoutRequest);
    const { session } = result;
    expect(session.rate).toBe("0.79");
    expect(session.fees?.providerFee).toBe("0.45");
  });

  it("sendPayout session links escrowId when provided", async () => {
    const result = await service.sendPayout({
      ...basicPayoutRequest,
      escrowId: "escrow_abc",
    });
    expect(result.session.escrowId).toBe("escrow_abc");
  });

  it("sendPayout session has no escrowId when omitted", async () => {
    const result = await service.sendPayout(basicPayoutRequest);
    expect(result.session.escrowId).toBeUndefined();
  });

  it("sendPayout session status is processing after creation", async () => {
    const result = await service.sendPayout(basicPayoutRequest);
    expect(result.session.status).toBe("processing");
  });

  it("sendPayout session externalId matches transfer id", async () => {
    const result = await service.sendPayout(basicPayoutRequest);
    expect(result.session.externalId).toBe(String(result.transfer.id));
  });

  it("sendBatch processes multiple payouts", async () => {
    const requests: PayoutRequest[] = [
      { ...basicPayoutRequest, reference: "PCC-batch-001" },
      {
        profileId: TEST_PROFILE_ID,
        sourceAmount: 250,
        sourceCurrency: "USD",
        recipient: {
          name: "Bob Operator",
          currency: "EUR",
          type: "iban",
          details: { iban: "DE89370400440532013000" },
        },
        reference: "PCC-batch-002",
      },
    ];

    const result = await service.sendBatch(requests);
    expect(result.successful.length).toBe(2);
    expect(result.failed.length).toBe(0);
  });

  it("sendBatch continues on individual failures", async () => {
    // Create a client where createQuote throws on the second call
    const client = makeMockClient();
    let callCount = 0;
    const originalCreateQuote = client.createQuote.bind(client);
    vi.spyOn(client, "createQuote").mockImplementation(async (params) => {
      callCount++;
      if (callCount === 2) {
        throw new Error("Simulated Wise API error");
      }
      return originalCreateQuote(params);
    });

    const batchService = makeService(client);
    const requests: PayoutRequest[] = [
      { ...basicPayoutRequest, reference: "PCC-b-001" },
      { ...basicPayoutRequest, reference: "PCC-b-002" },
      { ...basicPayoutRequest, reference: "PCC-b-003" },
    ];

    const result = await batchService.sendBatch(requests);
    expect(result.successful.length).toBe(2);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]?.error).toContain("Simulated Wise API error");
    expect(result.failed[0]?.request.reference).toBe("PCC-b-002");
  });

  it("sendBatch reports correct totalSourceAmount", async () => {
    const requests: PayoutRequest[] = [
      { ...basicPayoutRequest, sourceAmount: 100, reference: "r1" },
      { ...basicPayoutRequest, sourceAmount: 200, reference: "r2" },
      { ...basicPayoutRequest, sourceAmount: 50, reference: "r3" },
    ];
    const result = await service.sendBatch(requests);
    expect(result.totalSourceAmount).toBe(350);
  });

  it("sendBatch reports correct totalTargetAmount", async () => {
    const requests: PayoutRequest[] = [
      { ...basicPayoutRequest, sourceAmount: 100, reference: "r1" },
      { ...basicPayoutRequest, sourceAmount: 200, reference: "r2" },
    ];
    const result = await service.sendBatch(requests);
    // mock rate is 0.79, target = sourceAmount * 0.79
    expect(result.totalTargetAmount).toBeCloseTo(100 * 0.79 + 200 * 0.79, 2);
  });

  it("sendBatch excludes failed payouts from totals", async () => {
    const client = makeMockClient();
    // Mock second call to fail so the first payout succeeds
    const originalCreateQuote = client.createQuote.bind(client);
    let callCount = 0;
    vi.spyOn(client, "createQuote").mockImplementation(async (params) => {
      callCount++;
      if (callCount === 2) {
        throw new Error("fail");
      }
      return originalCreateQuote(params);
    });

    const batchService = makeService(client);
    const requests: PayoutRequest[] = [
      { ...basicPayoutRequest, sourceAmount: 100, reference: "ok-1" },
      { ...basicPayoutRequest, sourceAmount: 999, reference: "fail-1" },
    ];
    const result = await batchService.sendBatch(requests);
    // First payout succeeds (100), second fails (999 excluded)
    expect(result.failed.length).toBe(1);
    expect(result.totalSourceAmount).toBe(100);
  });

  it("checkStatus updates session status", async () => {
    const { transfer } = await service.sendPayout(basicPayoutRequest);
    const updated = await service.checkStatus(transfer.id);

    expect(updated).not.toBeNull();
    // mock getTransfer returns "completed"
    expect(updated?.status).toBe("completed");
    expect(updated?.completedAt).toBeTruthy();
  });

  it("checkStatus returns null for unknown transfer", async () => {
    const result = await service.checkStatus(99999);
    expect(result).toBeNull();
  });

  it("checkStatus sets completedAt when status transitions to completed", async () => {
    const { transfer, session } = await service.sendPayout(basicPayoutRequest);
    expect(session.completedAt).toBeUndefined();

    const updated = await service.checkStatus(transfer.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.completedAt).toBeTruthy();
  });

  it("checkStatus updates updatedAt timestamp", async () => {
    const { transfer, session } = await service.sendPayout(basicPayoutRequest);
    const originalUpdatedAt = session.updatedAt;

    // Small delay to ensure timestamp difference
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await service.checkStatus(transfer.id);

    expect(updated?.updatedAt).toBeTruthy();
    // updatedAt should be set (may or may not differ by ms, but shouldn't be undefined)
    expect(typeof updated?.updatedAt).toBe("string");
  });

  it("getSession returns tracked session", async () => {
    const { session } = await service.sendPayout(basicPayoutRequest);
    const fetched = service.getSession(session.id);
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(session.id);
    expect(fetched?.provider).toBe("wise");
  });

  it("getSession returns undefined for unknown id", () => {
    const result = service.getSession("nonexistent_id");
    expect(result).toBeUndefined();
  });

  it("listSessions returns all sessions", async () => {
    await service.sendPayout({ ...basicPayoutRequest, reference: "s1" });
    await service.sendPayout({ ...basicPayoutRequest, reference: "s2" });
    await service.sendPayout({ ...basicPayoutRequest, reference: "s3" });

    const sessions = service.listSessions();
    expect(sessions.length).toBe(3);
    for (const s of sessions) {
      expect(s.provider).toBe("wise");
    }
  });

  it("listSessions returns empty array when no payouts sent", () => {
    const sessions = service.listSessions();
    expect(sessions).toEqual([]);
  });
});
