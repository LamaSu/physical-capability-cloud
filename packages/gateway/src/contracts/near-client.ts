/**
 * NEAR Protocol — 1Click Chain Abstraction Client
 *
 * Uses the Defuse 1Click REST API to get cross-chain payment quotes and
 * submit payment intents. No SDK dependency — plain fetch() only.
 *
 * API reference: https://1click.chaindefuser.com/v0/
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ONE_CLICK_BASE = "https://1click.chaindefuser.com/v0";

// NEAR testnet RPC endpoint (used for status reporting)
export const NEAR_TESTNET_RPC = "https://rpc.testnet.near.org";

// Network identifier
export const NEAR_NETWORK = process.env.NEAR_NETWORK ?? "testnet";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OneClickQuoteRequest {
  /** Source chain (e.g. "near", "eth", "base") */
  fromChain: string;
  /** Source asset (e.g. "USDC", "NEAR") */
  fromAsset: string;
  /** Destination chain */
  toChain: string;
  /** Destination asset */
  toAsset: string;
  /** Amount in source asset smallest denomination */
  amount: string;
  /** Optional recipient address on destination chain */
  recipient?: string;
}

export interface OneClickQuoteResponse {
  quoteId: string;
  fromChain: string;
  fromAsset: string;
  toChain: string;
  toAsset: string;
  fromAmount: string;
  toAmount: string;
  estimatedFee: string;
  slippage: string;
  route: string[];
  validUntil: string;
  solver?: string;
}

export interface OneClickIntentRequest {
  /** Quote ID from a prior /quote call */
  quoteId: string;
  /** PCC workflow or escrow ID this payment is for */
  workflowId: string;
  /** Optional: override recipient */
  recipient?: string;
}

export interface OneClickIntentResponse {
  intentId: string;
  quoteId: string;
  status: "pending" | "submitted" | "settled" | "failed";
  txHash?: string;
  explorerUrl?: string;
  createdAt: string;
}

export interface OneClickIntentStatus {
  intentId: string;
  status: "pending" | "submitted" | "settled" | "failed";
  txHash?: string;
  settlementTxHash?: string;
  fromChain: string;
  toChain: string;
  fromAmount: string;
  toAmount: string;
  explorerUrl?: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Mock data (used when NEAR_MOCK=true or no real env configured)
// ---------------------------------------------------------------------------

function isMockMode(): boolean {
  return process.env.NEAR_MOCK === "true" || process.env.NODE_ENV === "test";
}

function mockQuote(req: OneClickQuoteRequest): OneClickQuoteResponse {
  const quoteId = `quote-near-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Simulate a small fee + slight slippage
  const fromAmt = BigInt(req.amount);
  const fee = fromAmt / 100n; // 1%
  const toAmt = fromAmt - fee;
  return {
    quoteId,
    fromChain: req.fromChain,
    fromAsset: req.fromAsset,
    toChain: req.toChain,
    toAsset: req.toAsset,
    fromAmount: req.amount,
    toAmount: toAmt.toString(),
    estimatedFee: fee.toString(),
    slippage: "0.5",
    route: [req.fromChain, "near", req.toChain],
    validUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    solver: "mock-solver",
  };
}

// In-memory intent store for mock mode
const mockIntentStore = new Map<string, OneClickIntentStatus>();

function mockSubmitIntent(req: OneClickIntentRequest, quote: OneClickQuoteResponse): OneClickIntentResponse {
  const intentId = `intent-near-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const txHash = `0x${Buffer.from(intentId).toString("hex").slice(0, 64)}`;
  const status: OneClickIntentStatus = {
    intentId,
    status: "submitted",
    txHash,
    fromChain: quote.fromChain,
    toChain: quote.toChain,
    fromAmount: quote.fromAmount,
    toAmount: quote.toAmount,
    explorerUrl: `https://testnet.nearblocks.io/txns/${txHash}`,
    updatedAt: new Date().toISOString(),
  };
  mockIntentStore.set(intentId, status);
  return {
    intentId,
    quoteId: req.quoteId,
    status: "submitted",
    txHash,
    explorerUrl: status.explorerUrl,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Quote cache (keyed by quoteId) — needed so mockSubmitIntent can look up quote
// ---------------------------------------------------------------------------

const quoteCache = new Map<string, OneClickQuoteResponse>();

// ---------------------------------------------------------------------------
// Public API helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a cross-chain payment quote from the 1Click solver network.
 * Falls back to mock data in test/mock mode.
 */
export async function fetchOneClickQuote(
  req: OneClickQuoteRequest,
): Promise<OneClickQuoteResponse> {
  if (isMockMode()) {
    const quote = mockQuote(req);
    quoteCache.set(quote.quoteId, quote);
    return quote;
  }

  const res = await fetch(`${ONE_CLICK_BASE}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      depositType: "NEAR_ACCOUNT",
      near: { chain: req.fromChain, token: req.fromAsset },
      refundTo: req.recipient ?? "",
      refundType: "NEAR_ACCOUNT",
      receiverType: "NEAR_ACCOUNT",
      recipient: req.recipient ?? "",
      integrations: [req.toChain],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`1Click /quote failed ${res.status}: ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;

  // Map 1Click API response shape to our internal type
  const quote: OneClickQuoteResponse = {
    quoteId: (data.quoteHash as string) ?? `q-${Date.now()}`,
    fromChain: req.fromChain,
    fromAsset: req.fromAsset,
    toChain: req.toChain,
    toAsset: req.toAsset,
    fromAmount: req.amount,
    toAmount: String(data.amountOut ?? "0"),
    estimatedFee: String(data.fee ?? "0"),
    slippage: String(data.slippageTolerance ?? "0"),
    route: Array.isArray(data.route) ? (data.route as string[]) : [],
    validUntil: (data.deadline as string) ?? new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    solver: (data.solver as string) ?? undefined,
  };

  quoteCache.set(quote.quoteId, quote);
  return quote;
}

/**
 * Submit a cross-chain payment intent via 1Click.
 * Falls back to mock in test/mock mode.
 */
export async function submitOneClickIntent(
  req: OneClickIntentRequest,
): Promise<OneClickIntentResponse> {
  // Retrieve the cached quote to embed chain info
  const quote = quoteCache.get(req.quoteId);

  if (isMockMode()) {
    if (!quote) {
      // Create a minimal synthetic quote for mock intent submission without a prior quote
      const syntheticQuote: OneClickQuoteResponse = {
        quoteId: req.quoteId,
        fromChain: "near",
        fromAsset: "USDC",
        toChain: "base",
        toAsset: "USDC",
        fromAmount: "0",
        toAmount: "0",
        estimatedFee: "0",
        slippage: "0",
        route: ["near", "base"],
        validUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };
      quoteCache.set(req.quoteId, syntheticQuote);
      return mockSubmitIntent(req, syntheticQuote);
    }
    return mockSubmitIntent(req, quote);
  }

  if (!quote) {
    throw new Error(`Quote ${req.quoteId} not found — fetch a quote first`);
  }

  const res = await fetch(`${ONE_CLICK_BASE}/intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteHash: req.quoteId,
      refundTo: req.recipient ?? "",
      recipient: req.recipient ?? "",
      metadata: { workflowId: req.workflowId },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`1Click /intent failed ${res.status}: ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;

  const intentId = String(data.intentHash ?? data.id ?? `intent-${Date.now()}`);
  const txHash = data.txHash as string | undefined;

  const status: OneClickIntentStatus = {
    intentId,
    status: (data.status as OneClickIntentStatus["status"]) ?? "pending",
    txHash,
    fromChain: quote.fromChain,
    toChain: quote.toChain,
    fromAmount: quote.fromAmount,
    toAmount: quote.toAmount,
    explorerUrl: txHash
      ? `https://testnet.nearblocks.io/txns/${txHash}`
      : undefined,
    updatedAt: new Date().toISOString(),
  };
  mockIntentStore.set(intentId, status);

  return {
    intentId,
    quoteId: req.quoteId,
    status: status.status,
    txHash,
    explorerUrl: status.explorerUrl,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Get the current status of a submitted intent.
 * Falls back to mock store in test/mock mode.
 */
export async function getOneClickIntentStatus(
  intentId: string,
): Promise<OneClickIntentStatus> {
  if (isMockMode()) {
    const stored = mockIntentStore.get(intentId);
    if (!stored) {
      throw new Error(`Intent ${intentId} not found`);
    }
    return stored;
  }

  const res = await fetch(`${ONE_CLICK_BASE}/intent/${encodeURIComponent(intentId)}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`1Click /intent/${intentId} failed ${res.status}: ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return {
    intentId,
    status: (data.status as OneClickIntentStatus["status"]) ?? "pending",
    txHash: data.txHash as string | undefined,
    settlementTxHash: data.settlementTxHash as string | undefined,
    fromChain: String(data.fromChain ?? "near"),
    toChain: String(data.toChain ?? "unknown"),
    fromAmount: String(data.fromAmount ?? "0"),
    toAmount: String(data.toAmount ?? "0"),
    explorerUrl: data.explorerUrl as string | undefined,
    updatedAt: String(data.updatedAt ?? new Date().toISOString()),
  };
}

/** Reset mock state between tests */
export function resetNearMockState(): void {
  mockIntentStore.clear();
  quoteCache.clear();
}
