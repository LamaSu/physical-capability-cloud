import { readApiKeyForAuthorizedFetch } from "../stores/auth-store.js";
import { fetchWithKey, installKeyEgressGuard } from "./gateway-base.js";

/**
 * fetch() as the signed-in user: the stored API key is attached only when
 * `target` resolves to the configured gateway, and anything else is refused
 * before a request is made (lib/gateway-base.ts). This module is the only
 * reader of the stored key; every other module sends it through here
 * (__tests__/no-direct-auth-headers.test.ts).
 */
export function authorizedFetch(target: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithKey(target, readApiKeyForAuthorizedFetch(), init);
}

/** Install the defence-in-depth egress guard with the stored key (main.tsx, at startup). */
export function installGatewayKeyGuard(): () => void {
  return installKeyEgressGuard(readApiKeyForAuthorizedFetch);
}
