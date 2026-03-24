import { describe, it, expect } from "vitest";
import { StripeOnrampClient, StripeCreditService } from "../stripe/index.js";

const TEST_WALLET = "0x1234567890123456789012345678901234567890" as const;

// ─── StripeOnrampClient ───────────────────────────────────────────────────────

describe("StripeOnrampClient", () => {
  const client = new StripeOnrampClient({
    secretKey: "sk_test_mock",
    publishableKey: "pk_test_mock",
    mock: true,
  });

  describe("createSession", () => {
    it("returns valid session structure in mock mode", async () => {
      const session = await client.createSession({
        walletAddress: TEST_WALLET,
        sourceAmount: "100",
      });

      expect(session.id).toMatch(/^cos_mock_/);
      expect(session.clientSecret).toMatch(/secret_mock/);
      expect(session.status).toBe("initialized");
    });

    it("uses default currency and network", async () => {
      const session = await client.createSession({ walletAddress: TEST_WALLET });
      // Check the tracked session for default values
      const tracked = client.getSession(`stripe_${session.id}`);
      expect(tracked?.cryptoCurrency).toBe("usdc");
      expect(tracked?.cryptoNetwork).toBe("base");
    });

    it("respects custom destination currency and network", async () => {
      const session = await client.createSession({
        walletAddress: TEST_WALLET,
        destinationCurrency: "eth",
        destinationNetwork: "ethereum",
      });
      const tracked = client.getSession(`stripe_${session.id}`);
      expect(tracked?.cryptoCurrency).toBe("eth");
      expect(tracked?.cryptoNetwork).toBe("ethereum");
    });

    it("stores escrowId when provided", async () => {
      const session = await client.createSession({
        walletAddress: TEST_WALLET,
        sourceAmount: "50",
        escrowId: "escrow_abc123",
      });
      const tracked = client.getSession(`stripe_${session.id}`);
      expect(tracked?.escrowId).toBe("escrow_abc123");
    });

    it("tracks sessions internally", async () => {
      const before = client.listSessions().length;
      await client.createSession({ walletAddress: TEST_WALLET });
      const after = client.listSessions().length;
      expect(after).toBe(before + 1);
    });
  });

  describe("getSession", () => {
    it("returns a tracked session by internal ID", async () => {
      const session = await client.createSession({
        walletAddress: TEST_WALLET,
        sourceAmount: "200",
      });
      const tracked = client.getSession(`stripe_${session.id}`);
      expect(tracked).toBeDefined();
      expect(tracked?.provider).toBe("stripe");
      expect(tracked?.direction).toBe("onramp");
      expect(tracked?.walletAddress).toBe(TEST_WALLET);
      expect(tracked?.fiatAmount).toBe("200");
    });

    it("returns undefined for unknown session ID", () => {
      expect(client.getSession("stripe_unknown_xyz")).toBeUndefined();
    });
  });

  describe("listSessions", () => {
    it("returns all tracked sessions", async () => {
      const freshClient = new StripeOnrampClient({
        secretKey: "sk_test_mock",
        publishableKey: "pk_test_mock",
        mock: true,
      });

      expect(freshClient.listSessions()).toHaveLength(0);

      await freshClient.createSession({ walletAddress: TEST_WALLET });
      await freshClient.createSession({ walletAddress: TEST_WALLET });

      expect(freshClient.listSessions()).toHaveLength(2);
    });
  });

  describe("publishableKey", () => {
    it("exposes publishable key", () => {
      expect(client.publishableKey).toBe("pk_test_mock");
    });
  });

  describe("handleWebhook", () => {
    it("returns null for unknown event type", async () => {
      const session = await client.createSession({ walletAddress: TEST_WALLET });
      const result = client.handleWebhook("payment_intent.created", { id: session.id });
      expect(result).toBeNull();
    });

    it("returns null for unknown session ID", () => {
      const result = client.handleWebhook("crypto.onramp_session_updated", {
        id: "nonexistent_session_id",
        status: "fulfillment_complete",
      });
      expect(result).toBeNull();
    });

    it("updates session status to pending_payment", async () => {
      const freshClient = new StripeOnrampClient({
        secretKey: "sk_test_mock",
        publishableKey: "pk_test_mock",
        mock: true,
      });
      const session = await freshClient.createSession({ walletAddress: TEST_WALLET });

      const updated = freshClient.handleWebhook("crypto.onramp_session_updated", {
        id: session.id,
        status: "requires_payment",
      });

      expect(updated).not.toBeNull();
      expect(updated?.status).toBe("pending_payment");
    });

    it("updates session status to processing", async () => {
      const freshClient = new StripeOnrampClient({
        secretKey: "sk_test_mock",
        publishableKey: "pk_test_mock",
        mock: true,
      });
      const session = await freshClient.createSession({ walletAddress: TEST_WALLET });

      const updated = freshClient.handleWebhook("crypto.onramp_session_updated", {
        id: session.id,
        status: "fulfillment_processing",
      });

      expect(updated?.status).toBe("processing");
    });

    it("updates session status to completed and sets completedAt", async () => {
      const freshClient = new StripeOnrampClient({
        secretKey: "sk_test_mock",
        publishableKey: "pk_test_mock",
        mock: true,
      });
      const session = await freshClient.createSession({ walletAddress: TEST_WALLET });

      const updated = freshClient.handleWebhook("crypto.onramp_session_updated", {
        id: session.id,
        status: "fulfillment_complete",
      });

      expect(updated?.status).toBe("completed");
      expect(updated?.completedAt).toBeDefined();
    });

    it("updates session status to failed for rejected", async () => {
      const freshClient = new StripeOnrampClient({
        secretKey: "sk_test_mock",
        publishableKey: "pk_test_mock",
        mock: true,
      });
      const session = await freshClient.createSession({ walletAddress: TEST_WALLET });

      const updated = freshClient.handleWebhook("crypto.onramp_session_updated", {
        id: session.id,
        status: "rejected",
      });

      expect(updated?.status).toBe("failed");
    });

    it("maps initialized stripe status to created", async () => {
      const freshClient = new StripeOnrampClient({
        secretKey: "sk_test_mock",
        publishableKey: "pk_test_mock",
        mock: true,
      });
      const session = await freshClient.createSession({ walletAddress: TEST_WALLET });

      const updated = freshClient.handleWebhook("crypto.onramp_session_updated", {
        id: session.id,
        status: "initialized",
      });

      expect(updated?.status).toBe("created");
    });

    it("updates updatedAt timestamp", async () => {
      const freshClient = new StripeOnrampClient({
        secretKey: "sk_test_mock",
        publishableKey: "pk_test_mock",
        mock: true,
      });
      const session = await freshClient.createSession({ walletAddress: TEST_WALLET });
      const tracked = freshClient.getSession(`stripe_${session.id}`);
      const originalUpdatedAt = tracked?.updatedAt;

      // Tiny delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 5));

      freshClient.handleWebhook("crypto.onramp_session_updated", {
        id: session.id,
        status: "requires_payment",
      });

      const updated = freshClient.getSession(`stripe_${session.id}`);
      expect(updated?.updatedAt).not.toBe(originalUpdatedAt);
    });
  });
});

// ─── StripeCreditService ──────────────────────────────────────────────────────

describe("StripeCreditService", () => {
  describe("createDepositSession (mock mode)", () => {
    it("auto-credits user in mock mode", async () => {
      const svc = new StripeCreditService({ secretKey: "sk_test_mock", mock: true });
      const { sessionId, url } = await svc.createDepositSession("user_1", 10);

      expect(sessionId).toMatch(/^cs_mock_/);
      expect(url).toMatch(/checkout\.stripe\.com\/mock/);

      const balance = svc.getBalance("user_1");
      expect(balance).toBeDefined();
      expect(balance?.credits).toBe(1000); // 10 USD * 100 credits/dollar
      expect(balance?.totalDeposited).toBe(10);
    });

    it("uses custom creditsPerDollar ratio", async () => {
      const svc = new StripeCreditService({
        secretKey: "sk_test_mock",
        mock: true,
        creditsPerDollar: 50,
      });
      await svc.createDepositSession("user_2", 20);
      const balance = svc.getBalance("user_2");
      expect(balance?.credits).toBe(1000); // 20 * 50
    });
  });

  describe("addCredits", () => {
    it("creates a new balance for a new user", () => {
      const svc = new StripeCreditService({ secretKey: "sk_test_mock", mock: true });
      const balance = svc.addCredits("user_new", 500, 5);

      expect(balance.userId).toBe("user_new");
      expect(balance.credits).toBe(500);
      expect(balance.totalDeposited).toBe(5);
      expect(balance.totalSpent).toBe(0);
      expect(balance.lastDeposit).toBeDefined();
    });

    it("adds to existing balance for a returning user", () => {
      const svc = new StripeCreditService({ secretKey: "sk_test_mock", mock: true });
      svc.addCredits("user_returning", 300, 3);
      const balance = svc.addCredits("user_returning", 200, 2);

      expect(balance.credits).toBe(500);
      expect(balance.totalDeposited).toBe(5);
    });
  });

  describe("deductCredits", () => {
    it("succeeds and deducts when user has sufficient balance", () => {
      const svc = new StripeCreditService({ secretKey: "sk_test_mock", mock: true });
      svc.addCredits("user_spend", 100, 1);

      const ok = svc.deductCredits("user_spend", 40);
      expect(ok).toBe(true);

      const balance = svc.getBalance("user_spend");
      expect(balance?.credits).toBe(60);
      expect(balance?.totalSpent).toBe(40);
    });

    it("fails when user has insufficient balance", () => {
      const svc = new StripeCreditService({ secretKey: "sk_test_mock", mock: true });
      svc.addCredits("user_low", 10, 1);

      const ok = svc.deductCredits("user_low", 100);
      expect(ok).toBe(false);

      // Balance should be unchanged
      expect(svc.getBalance("user_low")?.credits).toBe(10);
    });

    it("fails for an unknown user", () => {
      const svc = new StripeCreditService({ secretKey: "sk_test_mock", mock: true });
      const ok = svc.deductCredits("ghost_user", 1);
      expect(ok).toBe(false);
    });

    it("fails when balance is exactly zero", () => {
      const svc = new StripeCreditService({ secretKey: "sk_test_mock", mock: true });
      svc.addCredits("user_zero", 0, 0);
      const ok = svc.deductCredits("user_zero", 1);
      expect(ok).toBe(false);
    });
  });

  describe("getBalance", () => {
    it("returns undefined for unknown user", () => {
      const svc = new StripeCreditService({ secretKey: "sk_test_mock", mock: true });
      expect(svc.getBalance("nobody")).toBeUndefined();
    });

    it("returns the balance for a known user", () => {
      const svc = new StripeCreditService({ secretKey: "sk_test_mock", mock: true });
      svc.addCredits("user_known", 250, 2.5);

      const balance = svc.getBalance("user_known");
      expect(balance?.userId).toBe("user_known");
      expect(balance?.credits).toBe(250);
    });
  });

  describe("handleCheckoutWebhook", () => {
    it("processes payment and credits the user", () => {
      const svc = new StripeCreditService({ secretKey: "sk_test_mock", mock: true });

      const balance = svc.handleCheckoutWebhook({
        id: "cs_abc123",
        amount_total: 1500, // $15.00 in cents
        metadata: {
          user_id: "user_webhook",
          credits: "1500",
        },
      });

      expect(balance).not.toBeNull();
      expect(balance?.userId).toBe("user_webhook");
      expect(balance?.credits).toBe(1500);
      expect(balance?.totalDeposited).toBe(15);
    });

    it("returns null when metadata is missing user_id", () => {
      const svc = new StripeCreditService({ secretKey: "sk_test_mock", mock: true });
      const result = svc.handleCheckoutWebhook({
        id: "cs_bad",
        amount_total: 1000,
        metadata: { credits: "1000" },
      });
      expect(result).toBeNull();
    });

    it("returns null when metadata is missing credits", () => {
      const svc = new StripeCreditService({ secretKey: "sk_test_mock", mock: true });
      const result = svc.handleCheckoutWebhook({
        id: "cs_bad2",
        amount_total: 1000,
        metadata: { user_id: "user_x" },
      });
      expect(result).toBeNull();
    });

    it("returns null when metadata is absent entirely", () => {
      const svc = new StripeCreditService({ secretKey: "sk_test_mock", mock: true });
      const result = svc.handleCheckoutWebhook({
        id: "cs_no_meta",
        amount_total: 1000,
      });
      expect(result).toBeNull();
    });
  });
});
