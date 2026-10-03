/**
 * Which account this browser is on, as every tab sees it (astra 19f).
 *
 * The API key and the gateway's SIWE cookie belong to the browser, not to a
 * tab, and so does this: a token in localStorage that changes in the task
 * that stores a different API key, whichever tab stores it (auth-store login
 * and logout). A SIWE sign-in carries the generation it began under, and it is
 * refused once the generation has moved (lib/wallet-session.ts).
 *
 * A second token records the last generation for which a teardown confirmed
 * that the previous wallet session ended. Until the two agree, a teardown is
 * pending for the whole browser, and a page that loads then finishes it
 * before it mounts anything (App.tsx). Only a teardown holding the
 * wallet-session lock writes that record, and only for the generation it saw.
 * A later change leaves the two different, so no tab can mark another tab's
 * change finished.
 */

/** The account generation now ("" before the first change), or null when storage can't be read. */
export function accountGeneration(): string | null {
  try {
    return localStorage.getItem("pcc-account-generation") ?? "";
  } catch {
    return null;
  }
}

/** Moves the generation on. Called in the task that stores a different API key. */
export function beginAccountChange(): void {
  try {
    localStorage.setItem("pcc-account-generation", newToken());
  } catch {
    // Without storage the next key isn't kept past this page either (auth-store).
  }
}

/** Whether a teardown is pending: the generation moved past the last one confirmed. When storage can't be read, it may be (fail closed). */
export function walletSessionEnding(): boolean {
  try {
    return (localStorage.getItem("pcc-account-generation") ?? "") !== (localStorage.getItem("pcc-wallet-session-confirmed") ?? "");
  } catch {
    return true;
  }
}

/**
 * Records that the wallet session ended, as of `generation`. Only a teardown
 * holding the wallet-session lock calls this, after the gateway confirmed its
 * logout, with the generation it read before sending it.
 */
export function confirmWalletSessionEnded(generation: string): void {
  try {
    localStorage.setItem("pcc-wallet-session-confirmed", generation);
  } catch {
    // Unrecorded: the next page ends the session again.
  }
}

function newToken(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
