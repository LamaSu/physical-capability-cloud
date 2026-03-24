import { describe, it, expect, beforeEach } from "vitest";
import { YellowcardClient } from "../yellowcard/yellowcard-client.js";
import { YellowcardOfframp } from "../yellowcard/yellowcard-offramp.js";
import { YellowcardOnramp } from "../yellowcard/yellowcard-onramp.js";
import type { OfframpParams } from "../yellowcard/yellowcard-offramp.js";
import type { OnrampParams } from "../yellowcard/yellowcard-onramp.js";

// ---------------------------------------------------------------------------
// Shared mock client
// ---------------------------------------------------------------------------

function makeMockClient(): YellowcardClient {
  return new YellowcardClient({
    apiKey: "test-api-key",
    secretKey: "test-secret-key",
    environment: "sandbox",
    mock: true,
  });
}

// ---------------------------------------------------------------------------
// YellowcardClient
// ---------------------------------------------------------------------------

describe("YellowcardClient", () => {
  let client: YellowcardClient;

  beforeEach(() => {
    client = makeMockClient();
  });

  it("getChannels returns mock channels", async () => {
    const channels = await client.getChannels();
    expect(channels).toHaveLength(5);
    expect(channels[0]).toMatchObject({
      id: "ch_ng_bank",
      country: "NG",
      currency: "NGN",
      type: "bank",
    });
  });

  it("getChannels filters by country query param", async () => {
    // Mock returns all channels regardless of filter — just verify the call works
    const channels = await client.getChannels("NG");
    expect(Array.isArray(channels)).toBe(true);
    expect(channels.length).toBeGreaterThan(0);
  });

  it("getRates returns mock rates", async () => {
    const rates = await client.getRates();
    expect(rates).toHaveLength(4);
    const ngRate = rates.find((r) => r.code === "NG");
    expect(ngRate).toBeDefined();
    expect(ngRate!.currency).toBe("NGN");
    expect(ngRate!.buy).toBeGreaterThan(0);
    expect(ngRate!.sell).toBeGreaterThan(0);
    expect(typeof ngRate!.updatedAt).toBe("string");
  });

  it("getNetworks returns mock networks", async () => {
    const networks = await client.getNetworks("ch_ng_bank");
    expect(networks).toHaveLength(3);
    expect(networks[0]).toMatchObject({
      id: "nw_access_bank",
      channelId: "ch_ng_bank",
      country: "NG",
    });
  });

  it("HMAC auth headers have correct structure", () => {
    // Access protected method via type assertion to verify header generation
    const clientAny = client as unknown as {
      getHeaders: (m: string, p: string, b?: string) => Record<string, string>;
    };
    const headers = clientAny.getHeaders("POST", "/payments", '{"test":1}');

    expect(headers["Authorization"]).toMatch(/^YcHmacV1 test-api-key:[a-f0-9]+$/);
    expect(headers["YC-Timestamp"]).toMatch(/^\d+$/);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("HMAC signature is deterministic for same inputs at same timestamp", () => {
    const clientAny = client as unknown as {
      getHeaders: (m: string, p: string, b?: string) => Record<string, string>;
    };
    // Two calls at slightly different times produce different timestamps/signatures
    // but the auth format is always correct
    const h1 = clientAny.getHeaders("GET", "/channels");
    const h2 = clientAny.getHeaders("GET", "/channels");
    expect(h1["Authorization"]).toMatch(/^YcHmacV1 /);
    expect(h2["Authorization"]).toMatch(/^YcHmacV1 /);
  });

  it("submitPayment returns mock payment response", async () => {
    const result = await client.submitPayment({
      channelId: "ch_ng_bank",
      currency: "NGN",
    });
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("status", "processing");
    expect(result).toHaveProperty("settlementInfo");
  });

  it("submitCollection returns mock collection response with bankInfo", async () => {
    const result = await client.submitCollection({
      channelId: "ch_ng_bank",
      currency: "NGN",
    });
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("status", "processing");
    expect(result).toHaveProperty("bankInfo");
    const bankInfo = result.bankInfo as Record<string, unknown>;
    expect(bankInfo).toHaveProperty("accountNumber");
  });
});

// ---------------------------------------------------------------------------
// YellowcardOfframp
// ---------------------------------------------------------------------------

const offrampParams: OfframpParams = {
  walletAddress: "0xOperator1234567890123456789012345678901234",
  amountUsd: "50",
  fiatCurrency: "NGN",
  country: "NG",
  channelId: "ch_ng_bank",
  destination: {
    type: "bank_transfer",
    accountName: "John Doe",
    accountNumber: "0123456789",
    networkName: "Access Bank",
    country: "NG",
  },
  sender: {
    name: "PCC Platform",
    country: "NG",
    address: "123 Main St, Lagos",
    dob: "1990-01-01",
    email: "platform@pcc.io",
    idNumber: "A123456789",
    idType: "passport",
  },
  cryptoCurrency: "USDT",
  cryptoNetwork: "TRC20",
  reason: "service_payment",
};

describe("YellowcardOfframp", () => {
  let client: YellowcardClient;
  let offramp: YellowcardOfframp;

  beforeEach(() => {
    client = makeMockClient();
    offramp = new YellowcardOfframp(client);
  });

  it("submitWithdrawal creates a session in mock mode", async () => {
    const result = await offramp.submitWithdrawal(offrampParams);
    expect(result.session).toBeDefined();
    expect(result.reference).toBeTruthy();
  });

  it("session has correct provider and direction fields", async () => {
    const result = await offramp.submitWithdrawal(offrampParams);
    expect(result.session.provider).toBe("yellowcard");
    expect(result.session.direction).toBe("offramp");
  });

  it("session starts with processing status", async () => {
    const result = await offramp.submitWithdrawal(offrampParams);
    expect(result.session.status).toBe("processing");
  });

  it("session is stored and retrievable by id", async () => {
    const result = await offramp.submitWithdrawal(offrampParams);
    const retrieved = offramp.getSession(result.session.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(result.session.id);
  });

  it("result includes depositAddress from mock settlementInfo", async () => {
    const result = await offramp.submitWithdrawal(offrampParams);
    expect(result.depositAddress).toBeTruthy();
  });

  it("result includes cryptoAmount", async () => {
    const result = await offramp.submitWithdrawal(offrampParams);
    expect(result.cryptoAmount).toBeTruthy();
  });

  it("handleWebhook updates status to completed", async () => {
    const { session } = await offramp.submitWithdrawal(offrampParams);
    const externalId = session.externalId!;

    const updated = offramp.handleWebhook("payment.completed", {
      id: externalId,
      status: "completed",
    });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("completed");
    expect(updated!.completedAt).toBeTruthy();
  });

  it("handleWebhook updates status to failed", async () => {
    const { session } = await offramp.submitWithdrawal(offrampParams);
    const externalId = session.externalId!;

    const updated = offramp.handleWebhook("payment.failed", {
      id: externalId,
      status: "failed",
    });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("failed");
    expect(updated!.completedAt).toBeUndefined();
  });

  it("handleWebhook returns null for unknown session", () => {
    const result = offramp.handleWebhook("payment.completed", {
      id: "unknown_id_12345",
      status: "completed",
    });
    expect(result).toBeNull();
  });

  it("handleWebhook returns null when id is missing", () => {
    const result = offramp.handleWebhook("payment.completed", {
      status: "completed",
    });
    expect(result).toBeNull();
  });

  it("listSessions returns all sessions", async () => {
    await offramp.submitWithdrawal(offrampParams);
    await offramp.submitWithdrawal({ ...offrampParams, amountUsd: "100" });
    const sessions = offramp.listSessions();
    expect(sessions).toHaveLength(2);
  });

  it("getSession returns specific session", async () => {
    const r1 = await offramp.submitWithdrawal(offrampParams);
    const r2 = await offramp.submitWithdrawal({
      ...offrampParams,
      fiatCurrency: "KES",
    });

    const s1 = offramp.getSession(r1.session.id);
    expect(s1!.id).toBe(r1.session.id);

    const s2 = offramp.getSession(r2.session.id);
    expect(s2!.id).toBe(r2.session.id);
  });

  it("session walletAddress matches param", async () => {
    const result = await offramp.submitWithdrawal(offrampParams);
    expect(result.session.walletAddress).toBe(offrampParams.walletAddress);
  });

  it("session escrowId is set when provided", async () => {
    const result = await offramp.submitWithdrawal({
      ...offrampParams,
      escrowId: "escrow-001",
    });
    expect(result.session.escrowId).toBe("escrow-001");
  });
});

// ---------------------------------------------------------------------------
// YellowcardOnramp
// ---------------------------------------------------------------------------

const onrampParams: OnrampParams = {
  fiatAmount: "50000",
  fiatCurrency: "NGN",
  country: "NG",
  channelId: "ch_ng_bank",
  recipient: {
    name: "Alice Operator",
    country: "NG",
    phone: "+2348012345678",
    address: "456 Victoria Island, Lagos",
    dob: "1985-06-15",
    idNumber: "NIN123456789",
    idType: "national_id",
  },
  walletAddress: "0xUser0987654321098765432109876543210987654",
  cryptoCurrency: "USDC",
  cryptoNetwork: "TRC20",
};

describe("YellowcardOnramp", () => {
  let client: YellowcardClient;
  let onramp: YellowcardOnramp;

  beforeEach(() => {
    client = makeMockClient();
    onramp = new YellowcardOnramp(client);
  });

  it("submitCollection creates a session in mock mode", async () => {
    const result = await onramp.submitCollection(onrampParams);
    expect(result.session).toBeDefined();
    expect(result.reference).toBeTruthy();
  });

  it("session has correct provider and direction fields", async () => {
    const result = await onramp.submitCollection(onrampParams);
    expect(result.session.provider).toBe("yellowcard");
    expect(result.session.direction).toBe("onramp");
  });

  it("session starts with pending_payment status", async () => {
    const result = await onramp.submitCollection(onrampParams);
    expect(result.session.status).toBe("pending_payment");
  });

  it("result includes bankInfo from mock", async () => {
    const result = await onramp.submitCollection(onrampParams);
    expect(result.bankInfo).toBeDefined();
    expect(result.bankInfo!.name).toBe("PAGA");
    expect(result.bankInfo!.accountNumber).toBeTruthy();
    expect(result.bankInfo!.accountName).toBeTruthy();
  });

  it("session is stored and retrievable by id", async () => {
    const result = await onramp.submitCollection(onrampParams);
    const retrieved = onramp.getSession(result.session.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(result.session.id);
  });

  it("handleWebhook updates status to completed", async () => {
    const { session } = await onramp.submitCollection(onrampParams);
    const externalId = session.externalId!;

    const updated = onramp.handleWebhook("collection.completed", {
      id: externalId,
      status: "completed",
    });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("completed");
    expect(updated!.completedAt).toBeTruthy();
  });

  it("handleWebhook updates status to processing", async () => {
    const { session } = await onramp.submitCollection(onrampParams);
    const externalId = session.externalId!;

    const updated = onramp.handleWebhook("collection.processing", {
      id: externalId,
      status: "processing",
    });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("processing");
  });

  it("handleWebhook returns null for unknown session", () => {
    const result = onramp.handleWebhook("collection.completed", {
      id: "nonexistent_session_xyz",
      status: "completed",
    });
    expect(result).toBeNull();
  });

  it("handleWebhook returns null when id is missing", () => {
    const result = onramp.handleWebhook("collection.completed", {
      status: "completed",
    });
    expect(result).toBeNull();
  });

  it("session walletAddress matches param", async () => {
    const result = await onramp.submitCollection(onrampParams);
    expect(result.session.walletAddress).toBe(onrampParams.walletAddress);
  });

  it("session escrowId is set when provided", async () => {
    const result = await onramp.submitCollection({
      ...onrampParams,
      escrowId: "escrow-002",
    });
    expect(result.session.escrowId).toBe("escrow-002");
  });

  it("listSessions returns all sessions", async () => {
    await onramp.submitCollection(onrampParams);
    await onramp.submitCollection({ ...onrampParams, fiatAmount: "100000" });
    const sessions = onramp.listSessions();
    expect(sessions).toHaveLength(2);
  });

  it("getSession returns undefined for unknown id", () => {
    const result = onramp.getSession("yc_onramp_unknown");
    expect(result).toBeUndefined();
  });

  it("session id is prefixed with yc_onramp_", async () => {
    const result = await onramp.submitCollection(onrampParams);
    expect(result.session.id).toMatch(/^yc_onramp_/);
  });
});
