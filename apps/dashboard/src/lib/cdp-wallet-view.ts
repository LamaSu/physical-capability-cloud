/**
 * How the funded-key onramp names and describes a CDP wallet (board N48).
 *
 * A live wallet has an address. A demo wallet (PCC_DEMO_ROUTES) has none: no key controls the
 * mock address, so the gateway answers `walletAddress: null` and names the wallet by
 * `demoWalletRef` instead. A request about a demo wallet therefore names it by that reference,
 * and nothing offers to pay into it.
 */
export interface CdpWallet {
  walletAddress: string | null;
  /** Set on a demo wallet only: "demo-wallet-<16 hex>". */
  demoWalletRef?: string | null;
  network: string;
  smartAccount: boolean;
  mock?: boolean;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** The body field that names this wallet in a request: its address, or for a demo wallet its reference. */
export function walletRequestRef(w: CdpWallet): { walletAddress: string } | { walletRef: string } | null {
  if (nonEmpty(w.walletAddress)) return { walletAddress: w.walletAddress };
  if (nonEmpty(w.demoWalletRef)) return { walletRef: w.demoWalletRef };
  return null;
}

/** Only a wallet with an address can be funded by a card checkout. A demo wallet cannot. */
export function canFundByCard(w: CdpWallet): boolean {
  return nonEmpty(w.walletAddress);
}

/** What the wallet card shows as the wallet's name. */
export function walletLabel(w: CdpWallet): string {
  if (nonEmpty(w.walletAddress)) return w.walletAddress;
  if (nonEmpty(w.demoWalletRef)) return `${w.demoWalletRef} (demo: no address)`;
  return "(no address)";
}
