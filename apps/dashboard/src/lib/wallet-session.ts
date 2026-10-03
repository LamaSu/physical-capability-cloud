import { disconnect } from "wagmi/actions";
import { wagmiConfig, wagmiQueryClient } from "../providers/WalletProvider.js";

/**
 * End the wallet half of the signed-in identity (astra 19d, 19e).
 *
 * wagmi and the gateway's SIWE cookie live above the account boundary: they
 * outlast the signed-in shell. When the API account changed, the next
 * account's ConnectWallet used to find the previous wallet still connected,
 * and the gateway still holding its SIWE session. It copied both into the new
 * account's state, and the cookie went out with every request the next
 * account made.
 *
 * In order:
 * 1. Abort every SIWE sign-in in progress, so none sends its verification
 *    from here on.
 * 2. Disconnect every wagmi connector, and empty wagmi's cache.
 * 3. Wait until every verification already sent has settled. The gateway sets
 *    its cookie when a verification completes: one that completed after the
 *    logout would leave the previous account's cookie live (astra 19e).
 * 4. Ask the gateway to destroy the SIWE session cookie (POST
 *    /api/auth/logout, which needs no API key and answers {ok: true} whether
 *    or not a session existed). It sends no Authorization header: that route
 *    would also delete a session whose token matches the header.
 *
 * Resolves true only when the gateway answered {ok: true}. A 2xx alone could
 * come from a proxy or a fallback page while the cookie is still live (astra
 * 19e). On false, App keeps the next account's shell from mounting, since the
 * cookie may still be live (fail closed).
 */
export async function endWalletSession(): Promise<boolean> {
  for (const signIn of signIns) signIn.abort();
  signIns.clear();
  await withTimeout(disconnectAll(), WALLET_DISCONNECT_MS);
  wagmiQueryClient.clear();
  const drained = await withTimeout(Promise.allSettled([...verifications]), GATEWAY_LOGOUT_MS);
  if (!drained || verifications.size > 0) return false; // a verification could still set its cookie after the logout
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), GATEWAY_LOGOUT_MS);
  try {
    const res = await fetch("/api/auth/logout", { method: "POST", credentials: "include", signal: abort.signal });
    const body: unknown = await res.json().catch(() => null);
    return res.ok && typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** A wallet that never answers must not hold the account boundary; the cookie, checked next, is what grants authority. */
const WALLET_DISCONNECT_MS = 3_000;
/** The gateway gets this long to settle a verification already sent, and then to confirm the cookie is gone; after that the boundary fails closed and offers a retry. */
const GATEWAY_LOGOUT_MS = 8_000;

/** SIWE sign-ins in progress. endWalletSession() aborts them. */
const signIns = new Set<AbortController>();
/** Verifications sent and not yet answered. endWalletSession() waits for them before it logs out. */
const verifications = new Set<Promise<unknown>>();

/**
 * Starts a SIWE sign-in. Its signal aborts when the wallet session ends (the
 * account changed): the sign-in then sends nothing more, and writes nothing.
 * Call `finish()` once it is over, however it ended.
 */
export function beginSignIn(): { signal: AbortSignal; finish: () => void } {
  const controller = new AbortController();
  signIns.add(controller);
  return { signal: controller.signal, finish: () => signIns.delete(controller) };
}

/**
 * Sends a sign-in's verification (POST /api/auth/verify), which is where the
 * gateway sets its session cookie. Every verification goes through here, so
 * the wallet session's end can wait for it to settle before it logs out.
 * Sends nothing once the sign-in was aborted.
 */
export function verifySignIn(body: string, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const request = fetch("/api/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body,
    signal,
  });
  const settled = request.then(
    () => undefined,
    () => undefined,
  );
  verifications.add(settled);
  void settled.then(() => verifications.delete(settled));
  return request;
}

/**
 * Set from the task that changed the account's key until the gateway confirms
 * the previous wallet session ended (astra 19e). The next account's key is
 * already in localStorage when the teardown starts, so a page reloaded or
 * closed before the confirmation would come back as the next account with
 * the previous account's SIWE cookie still live. App reads this on load, and
 * finishes the teardown before it mounts anything.
 */
export function markWalletSessionEnding(): void {
  try {
    localStorage.setItem("pcc-wallet-session-ending", "1");
  } catch {
    // Without storage the next account's key isn't kept across a reload either.
  }
}

/** Whether a teardown was started and never confirmed. When storage can't be read, it may have been: end the session again (fail closed). */
export function walletSessionEnding(): boolean {
  try {
    return localStorage.getItem("pcc-wallet-session-ending") !== null;
  } catch {
    return true;
  }
}

/** The gateway confirmed the previous wallet session ended. */
export function clearWalletSessionEnding(): void {
  try {
    localStorage.removeItem("pcc-wallet-session-ending");
  } catch {
    // nothing kept, nothing to clear
  }
}

/**
 * Disconnect every wagmi connection. disconnect() ends only the current one,
 * then switches to the next, so this repeats while any remain. With nothing
 * connected, the first call is a no-op. On page load wagmi restores the last
 * page's connection; this waits for that first, so the restore can't bring
 * back what it disconnected.
 */
async function disconnectAll(): Promise<void> {
  await restored();
  for (let i = 0; i < 8; i++) {
    try {
      await disconnect(wagmiConfig);
    } catch {
      return; // the connector is already gone
    }
    if (wagmiConfig.state.connections.size === 0) return;
  }
}

/** Resolves once wagmi isn't restoring a previous page's connection. */
function restored(): Promise<void> {
  if (wagmiConfig.state.status !== "reconnecting") return Promise.resolve();
  return new Promise((resolve) => {
    const stop = wagmiConfig.subscribe(
      (state) => state.status,
      (status) => {
        if (status === "reconnecting") return;
        stop();
        resolve();
      },
    );
  });
}

/** Resolves true when `work` settled within `ms`, false when the time ran out first. */
function withTimeout(work: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    work.then(done, done);
  });
}
