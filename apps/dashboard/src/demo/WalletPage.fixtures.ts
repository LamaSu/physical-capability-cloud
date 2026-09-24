/**
 * WalletPage demo fixtures: sample values, not live PCC state.
 *
 * Rendered only in demo mode (lib/demo-mode.ts), under a DemoBanner. No
 * gateway route serves any of this for the viewer's account:
 *   - GET /api/wallet/balance and POST /api/credits/purchase are not
 *     registered anywhere in packages/gateway;
 *   - GET /api/fiat-ramp/sessions lists every session held in the gateway's
 *     memory, for all accounts;
 *   - the Yellowcard rates below are sample numbers (the gateway's own
 *     GET /api/fiat-ramp/yellowcard/rates returns a literal table unless
 *     YELLOWCARD_API_KEY is set).
 * pages/WalletPage.tsx says this on screen when demo mode is off.
 */

export type DemoRampProvider = "stripe" | "yellowcard" | "wise";

export interface DemoRampSession {
  id: string;
  provider: DemoRampProvider;
  direction: "deposit" | "withdrawal";
  amountUsd: string;
  amountLocal?: string;
  localCurrency?: string;
  status: "pending" | "completed" | "failed";
  createdAt: number;
}

export interface DemoCreditUsageEntry {
  id: string;
  description: string;
  credits: number;
  createdAt: number;
}

export interface DemoCountry {
  code: string;
  label: string;
  currency: string;
  /** Sample local-currency units per 1 USD. Not a quote. */
  rate: number;
  channels: string[];
}

/** The four KPI values. Amounts are plain decimals so AmountDisplay can parse them. */
export const DEMO_WALLET_SUMMARY = {
  walletBalance: "1234.56",
  pendingDeposits: 2,
  totalFunded: "6420.00",
  creditBalance: 14_150,
};

export const DEMO_RAMP_SESSIONS: DemoRampSession[] = [
  {
    id: "fr_001",
    provider: "stripe",
    direction: "deposit",
    amountUsd: "500.00",
    status: "completed",
    createdAt: Date.now() - 3_600_000,
  },
  {
    id: "fr_002",
    provider: "yellowcard",
    direction: "deposit",
    amountUsd: "200.00",
    amountLocal: "323,460",
    localCurrency: "NGN",
    status: "completed",
    createdAt: Date.now() - 7_200_000,
  },
  {
    id: "fr_003",
    provider: "yellowcard",
    direction: "withdrawal",
    amountUsd: "150.00",
    amountLocal: "242,595",
    localCurrency: "NGN",
    status: "pending",
    createdAt: Date.now() - 1_800_000,
  },
  {
    id: "fr_004",
    provider: "stripe",
    direction: "deposit",
    amountUsd: "1000.00",
    status: "completed",
    createdAt: Date.now() - 86_400_000,
  },
  {
    id: "fr_005",
    provider: "wise",
    direction: "withdrawal",
    amountUsd: "300.00",
    status: "completed",
    createdAt: Date.now() - 172_800_000,
  },
  {
    id: "fr_006",
    provider: "yellowcard",
    direction: "deposit",
    amountUsd: "75.00",
    amountLocal: "121,297",
    localCurrency: "NGN",
    status: "failed",
    createdAt: Date.now() - 259_200_000,
  },
];

export const DEMO_CREDIT_USAGE: DemoCreditUsageEntry[] = [
  { id: "cu_001", description: "Agent job submission — kernel-03", credits: -250, createdAt: Date.now() - 1_200_000 },
  { id: "cu_002", description: "API credits purchased", credits: 10_000, createdAt: Date.now() - 3_600_000 },
  { id: "cu_003", description: "Evidence verification — bundle_xyz", credits: -100, createdAt: Date.now() - 7_200_000 },
  { id: "cu_004", description: "Protocol run — FDM v1.2", credits: -500, createdAt: Date.now() - 14_400_000 },
  { id: "cu_005", description: "API credits purchased", credits: 5_000, createdAt: Date.now() - 86_400_000 },
];

export const DEMO_COUNTRIES: DemoCountry[] = [
  { code: "NG", label: "Nigeria", currency: "NGN", rate: 1617.3, channels: ["Bank Transfer", "Mobile Money"] },
  { code: "KE", label: "Kenya", currency: "KES", rate: 129.5, channels: ["Bank Transfer", "M-PESA"] },
  { code: "ZA", label: "South Africa", currency: "ZAR", rate: 18.6, channels: ["Bank Transfer", "EFT"] },
  { code: "GH", label: "Ghana", currency: "GHS", rate: 15.7, channels: ["Bank Transfer", "Mobile Money"] },
  { code: "BR", label: "Brazil", currency: "BRL", rate: 5.02, channels: ["Bank Transfer", "PIX"] },
  { code: "MX", label: "Mexico", currency: "MXN", rate: 17.1, channels: ["Bank Transfer", "SPEI"] },
  { code: "IN", label: "India", currency: "INR", rate: 83.4, channels: ["Bank Transfer", "UPI"] },
  { code: "PH", label: "Philippines", currency: "PHP", rate: 55.9, channels: ["Bank Transfer", "GCash"] },
];

/** Sample withdrawal fee shown in the demo summary. Not a PCC or Yellowcard fee. */
export const DEMO_WITHDRAW_FEE_PERCENT = 0.015;

/**
 * A placeholder address for the demo's "settlement contract" line. The
 * prototype used 0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985, which is the
 * ERC-4337 SimpleAccountFactory v0.7 (packages/bundler/src/smart-account.ts),
 * not a PCC settlement contract, so it is not shown even as a sample.
 */
export const DEMO_SETTLEMENT_ADDRESS = "0x0000000000000000000000000000000000000000";
