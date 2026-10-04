import { disconnect } from "wagmi/actions";
import { wagmiConfig, wagmiQueryClient } from "../providers/WalletProvider.js";
import { accountGeneration, confirmWalletSessionEnded } from "./account-generation.js";
import { authorizedFetch } from "./authorized-fetch.js";

/**
 * End the wallet half of the signed-in identity (astra 19d, 19e, 19f).
 *
 * wagmi and the gateway's SIWE cookie live above the account boundary: they
 * outlast the signed-in shell. When the API account changed, the next
 * account's ConnectWallet used to find the previous wallet still connected,
 * and the gateway still holding its SIWE session. It copied both into the new
 * account's state, and the cookie went out with every request the next
 * account made.
 *
 * The cookie belongs to the browser, so every tab's verifications and logouts
 * take turns under one Web Lock (WALLET_LOCK). In order:
 * 1. Abort this tab's SIWE sign-ins, so none of them sends anything more.
 * 2. Disconnect every wagmi connector, and empty wagmi's cache.
 * 3. Take the lock. Every verification holds it from its last account check
 *    until the gateway has answered, so once this tab has it no verification
 *    is in flight in any tab, and any later one finds the account changed and
 *    sends nothing.
 * 4. Ask the gateway to destroy the SIWE session cookie (POST
 *    /api/auth/logout, which needs no API key and answers {ok: true} whether
 *    or not a session existed). It sends no Authorization header: that route
 *    would also delete a session whose token matches the header.
 * 5. On {ok: true}, record the account generation it read under the lock as
 *    ended (lib/account-generation.ts). A page that loads before then
 *    finishes the teardown first.
 *
 * Resolves true only when the gateway answered {ok: true}. A 2xx alone could
 * come from a proxy or a fallback page while the cookie is still live. On
 * false (no confirmation, or another tab held the lock too long), App keeps
 * the next account's shell from mounting and offers a retry (fail closed).
 */
export async function endWalletSession(): Promise<boolean> {
  for (const signIn of signIns) signIn.abort();
  signIns.clear();
  await withTimeout(disconnectAll(), WALLET_DISCONNECT_MS);
  wagmiQueryClient.clear();
  const teardown = async () => {
    const generation = accountGeneration(); // what this logout covers
    const ended = await logOut();
    if (ended && generation !== null) confirmWalletSessionEnded(generation);
    return ended;
  };
  // Without Web Locks no sign-in can have started in this browser (verifySignIn needs them), so there's nothing to wait for.
  if (!webLocks()) return teardown();
  try {
    return await withWalletLock(teardown);
  } catch {
    return false; // the lock didn't come within LOCK_WAIT_MS
  }
}

/** A wallet that never answers must not hold the account boundary; the cookie, checked next, is what grants authority. */
const WALLET_DISCONNECT_MS = 3_000;
/** The gateway gets this long to confirm the cookie is gone; after that the boundary fails closed and offers a retry. */
const GATEWAY_LOGOUT_MS = 8_000;
/** A verification the gateway hasn't answered in this long is given up, so it can't hold every tab's teardown. */
const VERIFY_MS = 10_000;
/** How long a teardown or a sign-in waits for another tab's turn under the lock. */
const LOCK_WAIT_MS = 15_000;
/** The browser-wide lock that orders every tab's verifications and logouts. */
const WALLET_LOCK = "pcc-wallet-session";

/** This tab's SIWE sign-ins in progress. endWalletSession() aborts them. */
const signIns = new Set<AbortController>();

/**
 * Starts a SIWE sign-in. Its signal aborts when this tab's wallet session ends
 * (the account changed here). It carries the account generation it began
 * under, and verifySignIn() refuses it once the generation has moved in any
 * tab. Call `finish()` once it is over, however it ended.
 */
export function beginSignIn(): { signal: AbortSignal; generation: string | null; finish: () => void } {
  const controller = new AbortController();
  signIns.add(controller);
  return { signal: controller.signal, generation: accountGeneration(), finish: () => signIns.delete(controller) };
}

/** Whether the account this sign-in began under is still the browser's. */
export function signInCurrent(signIn: { signal: AbortSignal; generation: string | null }): boolean {
  return !signIn.signal.aborted && signIn.generation !== null && accountGeneration() === signIn.generation;
}

/**
 * Sends a sign-in's verification (POST /api/auth/verify), which is where the
 * gateway sets its session cookie. Every verification goes through here.
 * - It holds the wallet-session lock from its last check of the account
 *   until the gateway has answered, so no tab's logout can come between them:
 *   a teardown waiting for the lock logs out after this verification, and
 *   the next account mounts only after that.
 * - It sends nothing once the sign-in was aborted, or the account generation
 *   has moved since it began, in any tab.
 * - The caller adopts the answer only if signInCurrent() still holds after it
 *   has read it.
 * - It needs Web Locks: without them, verifications in two tabs couldn't be
 *   ordered against each other's logouts. Every current browser has them.
 */
export async function verifySignIn(
  body: string,
  signIn: { signal: AbortSignal; generation: string | null },
): Promise<Response> {
  if (signIn.signal.aborted) throw signIn.signal.reason;
  if (!webLocks()) throw new Error("This browser can't sign in with a wallet safely: it has no Web Locks.");
  return withWalletLock(async () => {
    if (!signInCurrent(signIn)) throw accountChanged();
    const send = new AbortController();
    const onAbort = () => send.abort(signIn.signal.reason);
    signIn.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => send.abort(new DOMException("The gateway didn't answer the sign-in", "TimeoutError")), VERIFY_MS);
    try {
      // With the API key, so the gateway binds the session it mints to this
      // account's key and honors its cookie only beside that key (N103).
      return await authorizedFetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body,
        signal: send.signal,
      });
    } finally {
      clearTimeout(timer);
      signIn.signal.removeEventListener("abort", onAbort);
    }
  });
}

function accountChanged(): Error {
  return new Error("The account changed while signing in. Sign in again.");
}

/** POST /api/auth/logout. True only on the gateway's {ok: true}. */
async function logOut(): Promise<boolean> {
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

interface WebLocks {
  request<T>(name: string, options: { signal?: AbortSignal }, callback: () => Promise<T>): Promise<T>;
}

function webLocks(): WebLocks | null {
  const locks = typeof navigator !== "undefined" ? (navigator as unknown as { locks?: WebLocks }).locks : undefined;
  return locks && typeof locks.request === "function" ? locks : null;
}

/** Runs `work` holding WALLET_LOCK. Rejects if the lock isn't granted within LOCK_WAIT_MS. */
function withWalletLock<T>(work: () => Promise<T>): Promise<T> {
  const wait = new AbortController();
  const timer = setTimeout(() => wait.abort(new DOMException("Another tab held the wallet session too long", "TimeoutError")), LOCK_WAIT_MS);
  return webLocks()!.request(WALLET_LOCK, { signal: wait.signal }, () => {
    clearTimeout(timer);
    return work();
  });
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
