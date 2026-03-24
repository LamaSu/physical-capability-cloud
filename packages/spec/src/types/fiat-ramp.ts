import type { Address, Amount, Id, Timestamp } from "./common.js";

/** Fiat ramp provider */
export type FiatRampProvider = "stripe" | "yellowcard" | "wise";

/** Direction of conversion */
export type RampDirection = "onramp" | "offramp";

/** Ramp session status */
export type RampSessionStatus =
  | "created"
  | "pending_payment"
  | "processing"
  | "completed"
  | "failed"
  | "expired";

/** A fiat ramp session (on-ramp or off-ramp) */
export interface FiatRampSession {
  id: Id;
  provider: FiatRampProvider;
  direction: RampDirection;
  status: RampSessionStatus;
  /** Fiat side */
  fiatCurrency: string;
  fiatAmount: Amount;
  /** Crypto side */
  cryptoCurrency: string;
  cryptoNetwork: string;
  cryptoAmount?: Amount;
  /** Wallet address for crypto delivery/source */
  walletAddress: Address;
  /** External provider session/reference ID */
  externalId?: string;
  /** Linked PCC escrow ID (if funding an escrow) */
  escrowId?: Id;
  /** Rate at time of quote */
  rate?: string;
  /** Fee breakdown */
  fees?: {
    providerFee?: Amount;
    networkFee?: Amount;
    platformFee?: Amount;
  };
  createdAt: Timestamp;
  updatedAt: Timestamp;
  completedAt?: Timestamp;
}

/** Withdrawal request for off-ramping */
export interface WithdrawalRequest {
  /** Operator's wallet address (source of USDC) */
  walletAddress: Address;
  /** Amount in USDC to withdraw */
  amount: Amount;
  /** Target fiat currency */
  fiatCurrency: string;
  /** Destination details (bank account, mobile money, etc.) */
  destination: WithdrawalDestination;
  /** Preferred provider (or auto-select) */
  provider?: FiatRampProvider;
}

/** Destination for fiat withdrawal */
export interface WithdrawalDestination {
  type: "bank_transfer" | "mobile_money" | "iban" | "spei" | "pix";
  /** Account holder name */
  accountName: string;
  /** Account number / IBAN / phone number */
  accountNumber: string;
  /** Bank name or mobile network */
  networkName?: string;
  /** Country code (ISO 3166-1 alpha-2) */
  country: string;
}
