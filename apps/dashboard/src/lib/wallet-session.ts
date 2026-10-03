import { disconnect } from "wagmi/actions";
import { wagmiConfig, wagmiQueryClient } from "../providers/WalletProvider.js";

/**
 * End the wallet half of the signed-in identity (astra 19d, CRITICAL).
 *
 * wagmi and the gateway's SIWE cookie live above the account boundary: they
 * outlast the signed-in shell. When the API account changed, the next
 * account's ConnectWallet used to find the previous wallet still connected,
 * and the gateway still holding its SIWE session. It copied both into the new
 * account's state, and the cookie went out with every request the next
 * account made.
 *
 * This disconnects every wagmi connector and empties wagmi's cache. Then it
 * asks the gateway to destroy the SIWE session cookie (POST /api/auth/logout,
 * which needs no API key and answers {ok: true} whether or not a session
 * existed). It sends no Authorization header: that route would also delete a
 * session whose token matches the header.
 *
 * Resolves true only when the gateway confirmed the cookie is gone. On false,
 * App keeps the next account's shell from mounting, since the cookie may
 * still be live (fail closed).
 */
export async function endWalletSession(): Promise<boolean> {
  await withTimeout(disconnectAll(), WALLET_DISCONNECT_MS);
  wagmiQueryClient.clear();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), GATEWAY_LOGOUT_MS);
  try {
    const res = await fetch("/api/auth/logout", { method: "POST", credentials: "include", signal: abort.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** A wallet that never answers must not hold the account boundary; the cookie, checked next, is what grants authority. */
const WALLET_DISCONNECT_MS = 3_000;
/** The gateway gets this long to confirm the cookie is gone; after that the boundary fails closed and offers a retry. */
const GATEWAY_LOGOUT_MS = 8_000;

/**
 * Disconnect every wagmi connection. disconnect() ends only the current one,
 * then switches to the next, so this repeats while any remain. With nothing
 * connected, the first call is a no-op.
 */
async function disconnectAll(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    try {
      await disconnect(wagmiConfig);
    } catch {
      return; // the connector is already gone
    }
    if (wagmiConfig.state.connections.size === 0) return;
  }
}

function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    work.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
