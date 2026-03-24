/**
 * Stripe prepaid credits — alternative to x402 on-chain micropayments.
 *
 * Users deposit USD via Stripe checkout → get API credits.
 * Credits are deducted per API call instead of requiring a wallet.
 */

export interface StripeCreditConfig {
  secretKey: string;
  /** Credit conversion rate: 1 USD = N credits (default: 100) */
  creditsPerDollar?: number;
  mock?: boolean;
}

export interface CreditBalance {
  userId: string;
  credits: number;
  totalDeposited: number;
  totalSpent: number;
  lastDeposit?: string;
}

export class StripeCreditService {
  private config: Required<StripeCreditConfig>;
  private balances = new Map<string, CreditBalance>();

  constructor(config: StripeCreditConfig) {
    this.config = {
      ...config,
      creditsPerDollar: config.creditsPerDollar ?? 100,
      mock: config.mock ?? false,
    };
  }

  /** Create a Stripe checkout session for credit purchase */
  async createDepositSession(userId: string, amountUsd: number): Promise<{ sessionId: string; url: string }> {
    if (this.config.mock) {
      const id = `cs_mock_${Date.now()}`;
      // Auto-credit in mock mode
      this.addCredits(userId, amountUsd * this.config.creditsPerDollar, amountUsd);
      return { sessionId: id, url: `https://checkout.stripe.com/mock/${id}` };
    }

    const body = new URLSearchParams();
    body.set("mode", "payment");
    body.set("line_items[0][price_data][currency]", "usd");
    body.set("line_items[0][price_data][unit_amount]", String(Math.round(amountUsd * 100)));
    body.set("line_items[0][price_data][product_data][name]", "PCC API Credits");
    body.set("line_items[0][quantity]", "1");
    body.set("metadata[user_id]", userId);
    body.set("metadata[credits]", String(amountUsd * this.config.creditsPerDollar));
    body.set("success_url", "https://pcc.dev/credits/success");
    body.set("cancel_url", "https://pcc.dev/credits/cancel");

    const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${Buffer.from(this.config.secretKey + ":").toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`Stripe checkout error ${resp.status}: ${JSON.stringify(err)}`);
    }

    const data = await resp.json() as { id: string; url: string };
    return { sessionId: data.id, url: data.url };
  }

  /** Add credits after successful payment (called by webhook handler) */
  addCredits(userId: string, credits: number, depositUsd: number): CreditBalance {
    const existing = this.balances.get(userId) ?? {
      userId,
      credits: 0,
      totalDeposited: 0,
      totalSpent: 0,
    };

    existing.credits += credits;
    existing.totalDeposited += depositUsd;
    existing.lastDeposit = new Date().toISOString();

    this.balances.set(userId, existing);
    return existing;
  }

  /** Deduct credits for an API call. Returns true if sufficient balance. */
  deductCredits(userId: string, amount: number): boolean {
    const balance = this.balances.get(userId);
    if (!balance || balance.credits < amount) return false;

    balance.credits -= amount;
    balance.totalSpent += amount;
    this.balances.set(userId, balance);
    return true;
  }

  /** Check credit balance */
  getBalance(userId: string): CreditBalance | undefined {
    return this.balances.get(userId);
  }

  /** Handle Stripe checkout.session.completed webhook */
  handleCheckoutWebhook(data: Record<string, unknown>): CreditBalance | null {
    const metadata = data.metadata as Record<string, string> | undefined;
    if (!metadata?.user_id || !metadata?.credits) return null;

    const amountTotal = (data.amount_total as number) / 100;
    return this.addCredits(metadata.user_id, parseInt(metadata.credits), amountTotal);
  }
}
