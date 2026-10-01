/**
 * Custody KEK guard for provisioning (N1, Gate A).
 *
 * A custodial wallet key is only ever created when it can be SEALED at rest
 * (packages/db custody-seal.ts, AES-256-GCM under PCC_CUSTODY_KEK +
 * PCC_CUSTODY_KEK_ID). With no valid KEK, provisioning FAILS CLOSED, in every
 * environment: it still issues the API key, but mints no custodial wallet,
 * stores no key, and says so in the response instead of silently degrading.
 *
 * Detecting that raises a ONE-TIME operator alert per process: a console.error
 * with the stable prefix "[custody] NO KEK:" plus a Sentry captureMessage when
 * Sentry is initialised. The alert names the env var and what is wrong with it
 * (static text) and never includes a value, least of all the KEK.
 */

import { resolveCustodyKek } from "@pcc/store";
import { Sentry, isSentryEnabled } from "../sentry.js";

/** Stable prefix of the alert line, for log greps and alert rules. */
export const CUSTODY_NO_KEK_PREFIX = "[custody] NO KEK:";

/** The provision response's explanation when no custodial wallet could be created. */
export const CUSTODIAL_WALLET_UNAVAILABLE = "unavailable: custody key not configured";

let alerted = false;

function raiseNoKekAlertOnce(problems: readonly string[]): void {
  if (alerted) return;
  alerted = true;
  const message =
    `${CUSTODY_NO_KEK_PREFIX} custodial wallet keys cannot be sealed, so provisioning issues ` +
    `API keys WITHOUT a custodial wallet until this is fixed (${problems.join("; ")})`;
  try {
    // eslint-disable-next-line no-console
    console.error(message);
  } catch {
    // Alerting never changes what provisioning does.
  }
  try {
    if (isSentryEnabled()) Sentry.captureMessage(message, "error");
  } catch {
    // Same: a broken alert channel must not break provisioning.
  }
}

/**
 * True when a valid custody KEK is configured. When it is not, raises the
 * one-time alert and returns false: the caller must not create or store a
 * custodial key. Re-reads the environment on every call. NEVER throws (the
 * provision route calls it where a throw would be mistaken for an on-chain
 * failure): anything unexpected counts as "not configured", i.e. fails closed.
 */
export function custodyKekConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  try {
    const resolved = resolveCustodyKek(env);
    if (resolved.ok) return true;
    raiseNoKekAlertOnce(resolved.problems);
    return false;
  } catch {
    return false;
  }
}

/** Test seam: re-arm the one-time alert. */
export function resetCustodyAlertForTest(): void {
  alerted = false;
}
