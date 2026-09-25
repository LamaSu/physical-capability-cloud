import { useAuthStore } from "../stores/auth-store.js";
import { fetchWithKey } from "./gateway-base.js";

/**
 * fetch() as the signed-in user: the stored API key is attached only when
 * `target` resolves to the configured gateway, and anything else is refused
 * before a request is made (lib/gateway-base.ts). This is how dashboard code
 * sends the key. Building an Authorization header by hand is ratcheted out
 * (__tests__/no-direct-auth-headers.test.ts).
 */
export function authorizedFetch(target: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithKey(target, useAuthStore.getState().apiKey, init);
}
