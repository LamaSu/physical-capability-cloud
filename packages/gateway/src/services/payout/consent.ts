import { createHash } from "node:crypto";

export const PAYOUT_CONSENT_VERSION = "kernel-payout-v1";
export const PAYOUT_CONSENT_TEMPLATE = `Record a payout wallet for your kernel
Kernel: {kernelId}. Chain: {chainName} (chain {chainId}).
Wallet: {wallet}. You proved you control this wallet when you signed in with it.
What this records: PCC notes this wallet as where payouts for this kernel should go. Recording it moves no funds and changes no escrow.
Payouts don't use this record yet. Each job's payout check shows the wallet that job's escrow actually pays.
Undo: revoke this record at any time. PCC then shows this kernel's payouts as unbound.
What PCC stores: the kernel, the chain, this wallet, how you proved it (a wallet sign-in), these terms (kernel-payout v1, sha256 {consentSha256}) and the time. No keys.
Record it. Cancel.`;
export const PAYOUT_CONSENT_SHA256 = createHash("sha256").update(PAYOUT_CONSENT_TEMPLATE, "utf8").digest("hex");

export const payoutConsent = Object.freeze({
  version: PAYOUT_CONSENT_VERSION,
  sha256: PAYOUT_CONSENT_SHA256,
  template: PAYOUT_CONSENT_TEMPLATE,
});
