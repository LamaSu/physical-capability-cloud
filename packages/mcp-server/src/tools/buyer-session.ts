import { createWalletClient, http, verifyMessage, type Address, type Hex } from "viem";
import { PCC_URL, currentBearer, setSessionBearerProvider, setRedactionSecretsProvider } from "../api.js";
import type { BuyerConfig } from "./buyer.js";

export const BUYER_SESSION_TEXTS = Object.freeze({
  S12: "Use this address as userAgentId when you open a negotiation.",
  S13: "The gateway didn't confirm the revocation; the session key still expires at {expiresAt}.",
  S14: "Sign in to Physical Capability Cloud as a buyer.",
  S21: "Sign-in failed at the {step} step{ (HTTP {status})}. No session was kept.",
});

export interface BuyerDependencies {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface BuyerSignInFields {
  domain: string;
  address: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
}

export function buildBuyerSignInMessage(fields: BuyerSignInFields): string {
  return [
    `${fields.domain} wants you to sign in with your Ethereum account:`,
    fields.address,
    "",
    BUYER_SESSION_TEXTS.S14,
    "",
    `URI: ${fields.uri}`,
    "Version: 1",
    `Chain ID: ${fields.chainId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
  ].join("\n");
}

type Step = "nonce" | "sign" | "verify" | "session_key";
interface Session { token: string; apiKey: string; expiresAtMs: number; expiresAt: string }
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Retain the environment reference, and read its current key only when redacting. */
export function buyerPrivateKeySecretsFromEnv(env: Record<string, string | undefined>): () => readonly string[] {
  return () => {
    const key = env.PCC_BUYER_PRIVATE_KEY?.trim();
    return key ? [key, ...(/^0x/i.test(key) ? [key.slice(2)] : [])] : [];
  };
}

export function createBuyerSession(config: BuyerConfig, deps: BuyerDependencies = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 15_000;
  let session: Session | undefined;
  let providerRegistered = false;
  const requests = new WeakMap<Response, { controller: AbortController; deadline: number }>();
  setRedactionSecretsProvider(() => [
    ...(config.privateKeySecrets?.() ?? []),
    ...(session ? [session.token, session.apiKey] : []),
  ]);

  // All transports, including viem's signer transport, use this fetch closure.
  const fetchFn: typeof fetch = async (input, init) => {
    const controller = new AbortController();
    const deadline = Date.now() + timeoutMs;
    const upstream = init?.signal;
    const abort = () => controller.abort();
    if (upstream?.aborted) abort();
    upstream?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        fetchImpl(input, { ...init, signal: controller.signal, redirect: "error", credentials: "omit" }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error()); }, timeoutMs);
        }),
      ]);
      requests.set(reply, { controller, deadline });
      return reply;
    } finally {
      clearTimeout(timer);
      upstream?.removeEventListener("abort", abort);
    }
  };
  async function readJson(reply: Response): Promise<unknown> {
    const timing = requests.get(reply)!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reply.json(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { timing.controller.abort(); reject(new Error()); }, Math.max(0, timing.deadline - Date.now()));
        }),
      ]);
    } finally {
      clearTimeout(timer);
      requests.delete(reply);
    }
  }
  async function request(path: string, init: RequestInit) {
    const reply = await fetchFn(`${config.gatewayUrl}${path}`, init);
    const expected = path === "/api/auth/session-key" ? 201 : 200;
    if (path === "/api/auth/logout" || reply.status !== expected) {
      requests.delete(reply);
      try { void reply.body?.cancel().catch(() => undefined); } catch { /* best effort */ }
    }
    return reply;
  }
  const key = () => session && now() < session.expiresAtMs ? session.apiKey : undefined;
  function forget() {
    session = undefined;
    if (providerRegistered) setSessionBearerProvider(undefined);
    providerRegistered = false;
  }
  async function logout(token: string): Promise<boolean> {
    try {
      const reply = await request("/api/auth/logout", {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
      });
      return reply.status === 200;
    } catch { return false; }
  }

  async function signIn() {
    if (session) {
      await logout(session.token);
      forget();
    }
    let step: Step = "nonce";
    let status: number | null = null;
    try {
      const nonceReply = await request("/api/auth/nonce", { method: "GET", headers: { Accept: "application/json" } });
      status = nonceReply.status;
      if (status !== 200) throw new Error();
      const nonce = await readJson(nonceReply);
      if (!object(nonce) || typeof nonce.nonce !== "string" || !/^[A-Za-z0-9]{8,128}$/.test(nonce.nonce)) throw new Error();

      step = "sign";
      status = null;
      const signer = config.signer!;
      const url = new URL(config.gatewayUrl);
      const address = signer.address;
      const message = buildBuyerSignInMessage({
        domain: url.host, address, uri: url.origin, chainId: config.chainId,
        nonce: nonce.nonce, issuedAt: new Date(now()).toISOString(),
      });
      const signature = signer.kind === "local"
        ? await signer.account.signMessage({ message })
        : await createWalletClient({
          account: address as Address,
          transport: http(signer.url, {
            fetchFn: async (input, init) => {
              const reply = await fetchFn(input, init);
              status = reply.status;
              const body = await readJson(reply);
              return new Response(JSON.stringify(body), { status: reply.status, headers: reply.headers });
            },
            retryCount: 0,
          }),
        }).signMessage({ message });
      if (!await verifyMessage({ address: address as Address, message, signature: signature as Hex })) throw new Error();

      step = "verify";
      status = null;
      const verifyReply = await request("/api/auth/verify", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ message, signature }),
      });
      status = verifyReply.status;
      if (status !== 200) throw new Error();
      const verified = await readJson(verifyReply);
      if (!object(verified) || typeof verified.token !== "string" || !/^[\x21-\x7e]{1,512}$/.test(verified.token)
        || typeof verified.address !== "string" || verified.address.toLowerCase() !== address.toLowerCase()) throw new Error();

      step = "session_key";
      status = null;
      const keyReply = await request("/api/auth/session-key", {
        method: "POST", headers: { Authorization: `Bearer ${verified.token}`, Accept: "application/json" },
      });
      status = keyReply.status;
      if (status !== 201) throw new Error();
      const minted = await readJson(keyReply);
      if (!object(minted) || typeof minted.api_key !== "string" || !/^pcc_(live|test)_[A-Za-z0-9_-]{16,256}$/.test(minted.api_key)
        || typeof minted.operator_id !== "string" || minted.operator_id.toLowerCase() !== address.toLowerCase()
        || typeof minted.expires_at !== "string" || !(Date.parse(minted.expires_at) > now())) throw new Error();
      session = { token: verified.token, apiKey: minted.api_key, expiresAtMs: Date.parse(minted.expires_at), expiresAt: minted.expires_at };
      if (config.gatewayUrl === PCC_URL) {
        setSessionBearerProvider(key);
        providerRegistered = true;
      }
      return { signedIn: true as const, address, chainId: config.chainId, expiresAt: minted.expires_at, next: BUYER_SESSION_TEXTS.S12 };
    } catch {
      forget();
      const message = BUYER_SESSION_TEXTS.S21.replace("{step}", step)
        .replace("{ (HTTP {status})}", status === null ? "" : ` (HTTP ${status})`);
      return { error: "BUYER_SIGN_IN_FAILED" as const, message, step, status };
    }
  }

  async function signOut() {
    if (!session) return undefined;
    const previous = session;
    const revoked = await logout(previous.token);
    forget();
    return { signedOut: true as const, revoked,
      ...(!revoked ? { note: BUYER_SESSION_TEXTS.S13.replace("{expiresAt}", previous.expiresAt) } : {}),
    };
  }

  // Credential mutations are ordered even if the host sends simultaneous calls.
  let pending: Promise<unknown> = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation, operation);
    pending = result.catch(() => undefined);
    return result;
  }
  return {
    signIn: () => serial(signIn), signOut: () => serial(signOut),
    bearer: () => key() ?? currentBearer(), request, readJson,
  };
}
