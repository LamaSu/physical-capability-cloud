/**
 * Which account this browser is on, as every tab sees it (astra 19f, 19g).
 *
 * The API key and the gateway's SIWE cookie belong to the browser, not to a
 * tab, and so does this: a token in localStorage that moves BEFORE a
 * different API key is stored, whichever tab stores it (auth-store login), so
 * a tab that sees the next key also sees the change pending. Two writes in
 * one task aren't atomic for another renderer: a tab can load, or hear of the
 * first, between them. A SIWE sign-in carries the generation it began under,
 * and it is refused once the generation has moved (lib/wallet-session.ts).
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

/**
 * Moves the generation on, before a different API key is stored. True only
 * when storage reads the new generation back. Otherwise the caller must not
 * store the next key (fail closed): another tab might not see the change
 * pending. The write may have landed all the same, since a write can land and
 * then throw (astra 19l). If it did, every tab now sees a change pending that
 * only a teardown confirms, so the caller must also run its account boundary.
 */
export function beginAccountChange(): boolean {
  const next = newToken();
  try {
    localStorage.setItem("pcc-account-generation", next);
  } catch {
    // Not proof that it didn't land: the read below decides.
  }
  try {
    return localStorage.getItem("pcc-account-generation") === next;
  } catch {
    return false;
  }
}

/**
 * Calls `onPending` when another tab moves the generation and the change is
 * pending. Its storage event comes before the key's, and can arrive alone for
 * a while; the tab then ends its wallet session before anything else (App).
 */
export function onAccountChangePending(onPending: () => void): void {
  if (typeof window === "undefined") return;
  window.addEventListener("storage", (event) => {
    if (event.key === "pcc-account-generation" && walletSessionEnding()) onPending();
  });
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
