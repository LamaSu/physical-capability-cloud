import type { CdpConfig } from "./types.js";

/**
 * Real CDP mode needs the COMPLETE credential tuple: apiKeyId, apiKeySecret and
 * walletSecret, each a non-blank string. The clients used to go real on apiKeyId
 * alone, so a half-configured deployment called the SDK with missing secrets
 * (WP-A round 5, sol #2963). All three CDP clients use this one rule, so they can
 * never disagree about whether they are real.
 */
export function cdpCredentialsComplete(cfg: CdpConfig): boolean {
  return [cfg.apiKeyId, cfg.apiKeySecret, cfg.walletSecret].every(
    (v) => typeof v === "string" && v.trim().length > 0,
  );
}
