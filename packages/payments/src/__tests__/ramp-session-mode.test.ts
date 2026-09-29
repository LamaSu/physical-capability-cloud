/**
 * Record-level provenance (board N48, cross-family review r2 finding "session listing lost
 * simulation provenance"): every stored FiatRampSession carries `mode`, set by the client that
 * created it: simulated (mock client), sandbox (provider test environment) or production.
 * Yellowcard and Wise derive it from the base URL they actually call, so the label cannot
 * disagree with where the request went.
 *
 * Also: the CDP onramp client never builds a real-money checkout for a testnet client or
 * without an app id (it used to fall back to an empty one).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { StripeOnrampClient } from "../stripe/index.js";
import { YellowcardClient, YellowcardOfframp, YellowcardOnramp } from "../yellowcard/index.js";
import { WiseClient, WisePayoutService } from "../wise/index.js";
import { CdpOnrampClient } from "../cdp/index.js";

const WALLET = "0x1111111111111111111111111111111111111111" as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fetch stub that answers every provider call with `body` and records the URLs called. */
function stubFetch(body: Record<string, unknown>): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return urls;
}

describe("Stripe onramp sessions record their mode", () => {
  it("mock: simulated, and nothing is called", async () => {
    const urls = stubFetch({});
    const c = new StripeOnrampClient({ secretKey: "sk_test_mock", publishableKey: "pk", mock: true });
    await c.createSession({ walletAddress: WALLET });
    expect(c.listSessions().map((s) => s.mode)).toEqual(["simulated"]);
    expect(urls).toEqual([]);
  });

  it("a live test key: sandbox", async () => {
    stubFetch({ id: "cos_1", client_secret: "cs_1", status: "initialized" });
    const c = new StripeOnrampClient({ secretKey: "sk_test_abc", publishableKey: "pk_test_abc", mock: false });
    await c.createSession({ walletAddress: WALLET });
    expect(c.listSessions()[0]!.mode).toBe("sandbox");
  });

  it("a live production key: production", async () => {
    stubFetch({ id: "cos_2", client_secret: "cs_2", status: "initialized" });
    const c = new StripeOnrampClient({ secretKey: "sk_live_abc", publishableKey: "pk_live_abc", mock: false });
    await c.createSession({ walletAddress: WALLET });
    expect(c.listSessions()[0]!.mode).toBe("production");
  });
});

const SENDER = { name: "A", country: "NG", address: "x", dob: "1990-01-01", email: "a@example.invalid", idNumber: "1", idType: "passport" };
const WITHDRAW = {
  walletAddress: WALLET,
  amountUsd: "10",
  fiatCurrency: "NGN",
  country: "NG",
  channelId: "ch-1",
  destination: { type: "bank_transfer" as const, accountName: "A", accountNumber: "1", country: "NG" },
  sender: SENDER,
};
const COLLECT = {
  fiatAmount: "1000",
  fiatCurrency: "NGN",
  country: "NG",
  channelId: "ch-1",
  recipient: { name: "A", country: "NG", phone: "1", address: "x", dob: "1990-01-01", idNumber: "1", idType: "passport" },
  walletAddress: WALLET,
};

describe("Yellowcard sessions record their mode, from the URL the client calls", () => {
  const yc = (environment: "sandbox" | "production" | undefined, mock: boolean) =>
    new YellowcardClient({ apiKey: "k", secretKey: "s", environment, mock });

  it("mock: simulated, on both directions", async () => {
    const client = yc("production", true);
    expect(client.sessionMode).toBe("simulated");
    const off = new YellowcardOfframp(client);
    const on = new YellowcardOnramp(client);
    expect((await off.submitWithdrawal(WITHDRAW)).session.mode).toBe("simulated");
    expect((await on.submitCollection(COLLECT)).session.mode).toBe("simulated");
  });

  it("live, environment unset or sandbox: sandbox, and the sandbox host is called", async () => {
    for (const env of [undefined, "sandbox"] as const) {
      const urls = stubFetch({ id: "p1", rate: 1, settlementInfo: { walletAddress: WALLET, cryptoAmount: 10 } });
      const off = new YellowcardOfframp(yc(env, false));
      expect((await off.submitWithdrawal(WITHDRAW)).session.mode).toBe("sandbox");
      expect(urls[0]).toMatch(/^https:\/\/sandbox\.yellowcard\.engineering\//);
    }
  });

  it("live production: production, and the production host is called", async () => {
    const urls = stubFetch({ id: "c1", rate: 1, bankInfo: { name: "B", accountNumber: "1", accountName: "A" } });
    const on = new YellowcardOnramp(yc("production", false));
    expect((await on.submitCollection(COLLECT)).session.mode).toBe("production");
    expect(urls[0]).toMatch(/^https:\/\/api\.yellowcard\.engineering\//);
  });
});

describe("Wise payout sessions record their mode, from the URL the client calls", () => {
  const PAYOUT = {
    profileId: 1,
    sourceAmount: 10,
    recipient: { name: "A", currency: "EUR", type: "iban", details: {} },
    reference: "r",
  };
  const WISE_OK = { id: 1, targetAmount: 9, rate: 0.9, fee: 0.1, status: "processing" };

  it("mock: simulated", async () => {
    const svc = new WisePayoutService(new WiseClient({ apiToken: "t", environment: "production", mock: true }));
    expect((await svc.sendPayout(PAYOUT)).session.mode).toBe("simulated");
  });

  it("live sandbox: sandbox, on the sandbox host", async () => {
    const urls = stubFetch(WISE_OK);
    const svc = new WisePayoutService(new WiseClient({ apiToken: "t", environment: "sandbox", mock: false }));
    expect((await svc.sendPayout(PAYOUT)).session.mode).toBe("sandbox");
    expect(urls.every((u) => u.startsWith("https://api.sandbox.transferwise.tech/"))).toBe(true);
  });

  it("live production: production, on the production host", async () => {
    const urls = stubFetch(WISE_OK);
    const svc = new WisePayoutService(new WiseClient({ apiToken: "t", environment: "production", mock: false }));
    expect((await svc.sendPayout(PAYOUT)).session.mode).toBe("production");
    expect(urls.every((u) => u.startsWith("https://api.wise.com/"))).toBe(true);
  });
});

describe("NEGATIVE: the CDP onramp client never builds a checkout it cannot stand behind", () => {
  const live = { apiKeyId: "id", apiKeySecret: "s", walletSecret: "w", mock: false } as const;

  it("a testnet (base-sepolia) client refuses: the onramp sells on Base mainnet", async () => {
    const c = new CdpOnrampClient({ ...live, network: "base-sepolia", onrampAppId: "app-1" });
    await expect(c.createSession({ destinationAddress: WALLET })).rejects.toThrow(/Base mainnet/);
  });

  it("no app id (or a blank one) refuses; it used to build the URL with an empty appId", async () => {
    for (const onrampAppId of [undefined, "", "  "]) {
      const c = new CdpOnrampClient({ ...live, network: "base", onrampAppId });
      await expect(c.createSession({ destinationAddress: WALLET })).rejects.toThrow(/CDP_ONRAMP_APP_ID/);
    }
  });

  it("control: base with an app id builds the checkout for that app", async () => {
    const c = new CdpOnrampClient({ ...live, network: "base", onrampAppId: "app-1" });
    const s = await c.createSession({ destinationAddress: WALLET, presetAmountUSD: 5 });
    expect(s.onrampUrl).toMatch(/^https:\/\/pay\.coinbase\.com\/buy\/select-asset\?appId=app-1&/);
    expect(s.network).toBe("base");
  });
});
