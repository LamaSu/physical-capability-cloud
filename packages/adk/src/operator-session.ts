/**
 * Origin-bound, headless SIWE sign-in for an operator host.
 *
 * This helper has no chain client or custody of a wallet. The host supplies a
 * scoped EIP-191 signer, and receives only the API key issued by its gateway.
 */

export type OperatorSessionErrorCode =
  | "bad_config" | "bad_base_url" | "bad_address" | "bad_chain_id" | "bad_signer"
  | "bad_fetch" | "bad_clock" | "bad_timing" | "bad_fields"
  | "network" | "timeout" | "malformed_response" | "unavailable" | "rate_limited"
  | "unexpected_status" | "sign_in_refused" | "session_refused" | "too_many_keys"
  | "address_mismatch" | "signer_failed";

/** Fixed-code error. Never retains a cause, input, response, or secret. */
export class OperatorSessionError extends Error {
  readonly code: OperatorSessionErrorCode;
  readonly status: number | null;

  constructor(code: OperatorSessionErrorCode, status: number | null = null) {
    super(code);
    this.name = "OperatorSessionError";
    this.code = code;
    this.status = status;
  }
}

export interface OperatorSignInFields {
  readonly domain: string;
  readonly address: string;
  readonly statement: string;
  readonly uri: string;
  readonly version: "1";
  readonly chainId: number;
  readonly nonce: string;
  readonly issuedAt: string;
}

/** Sign the *exact* message as EIP-191 personal_sign, without normalizing it. */
export type OperatorMessageSigner = (message: string, fields: OperatorSignInFields) => Promise<string>;

export interface OperatorSessionOptions {
  baseUrl: string;
  address: string;
  chainId: number;
  signMessage: OperatorMessageSigner;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface OperatorSessionKeeperOptions extends OperatorSessionOptions {
  renewBeforeMs?: number;
  onEvent?: (event: OperatorSessionEvent) => void;
}

/** apiKey is readable, but excluded from JSON, string and Node inspection. */
export interface OperatorSessionKey {
  readonly apiKey: string;
  readonly keyId: string;
  readonly expiresAtMs: number;
}

export type OperatorSessionEvent =
  | { readonly kind: "key_minted"; readonly keyId: string; readonly expiresAtMs: number }
  | {
      readonly kind: "mint_failed";
      readonly code: OperatorSessionErrorCode;
      readonly status: number | null;
      readonly retryInMs: number;
      readonly step?: "nonce" | "sign" | "verify" | "session_key";
    }
  | { readonly kind: "key_expired" }
  | { readonly kind: "stopped" };

export interface OperatorSessionKeeper {
  key(): OperatorSessionKey | null;
  ready(): Promise<OperatorSessionKey | null>;
  invalidate(keyId: string): void;
  stop(): Promise<void>;
}

const EXPIRY_MARGIN_MS = 60_000;
const MIN_MINT_SPACING_MS = 60_000;
const PENDING_SESSION_MAX_AGE_MS = 600_000;
const MAX_REPLY_BYTES = 65_536;
const RETRY_FIRST_MS = 5_000;
const RETRY_CAP_MS = 300_000;
const MAX_TIMER_MS = 2_147_483_647;
/** Fixed statement: hosts may pin this exact text in their signing closure. */
const STATEMENT = "Sign in to Physical Capability Cloud as an operator host.";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const NONCE_RE = /^[A-Za-z0-9]{8,128}$/;
const SIGNATURE_RE = /^0x(?:[0-9a-fA-F]{2}){64,2048}$/;
const KEY_RE = /^pcc_(live|test)_[A-Za-z0-9_-]{16,256}$/;
const ISSUED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const TIMEOUT = Symbol("operator-session-timeout");
const TOO_LARGE = Symbol("operator-session-too-large");

type Step = "nonce" | "sign" | "verify" | "session_key";

interface Config {
  readonly urlPrefix: string;
  readonly domain: string;
  readonly uri: string;
  readonly address: string;
  readonly chainId: number;
  readonly signMessage: OperatorMessageSigner;
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
  readonly timeoutMs: number;
  readonly renewBeforeMs: number;
  readonly onEvent?: (event: OperatorSessionEvent) => void;
}

interface Session {
  readonly token: string;
  readonly verifiedAtMs: number;
}

interface MintResult {
  readonly key: OperatorSessionKey;
  readonly session: Session;
}

class AttemptProblem {
  constructor(readonly step: Step, readonly error: OperatorSessionError) {}
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validBaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || /\s/.test(value)) return false;
  if (!/^https?:\/\/[^/\\?#]/i.test(value) || value.includes("\\")) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@/.test(value)) return false;
  if (value.includes("?") || value.includes("#")) return false;
  try {
    const url = new URL(value);
    return !!url.hostname && !url.username && !url.password && (
      url.protocol === "https:" || (url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname.toLowerCase()))
    );
  } catch {
    return false;
  }
}

/** Snapshot every caller-controlled option exactly once, before any request. */
function configFor(options: OperatorSessionOptions | OperatorSessionKeeperOptions): Config {
  let props: Record<string, unknown>;
  try {
    if (!isObject(options)) throw new OperatorSessionError("bad_config");
    props = options;
  } catch {
    throw new OperatorSessionError("bad_config");
  }
  let baseUrl: unknown;
  let address: unknown;
  let chainId: unknown;
  let signMessage: unknown;
  let fetchImpl: unknown;
  let now: unknown;
  let timeoutMs: unknown;
  let renewBeforeMs: unknown;
  let onEvent: unknown;
  try {
    ({ baseUrl, address, chainId, signMessage, fetchImpl, now, timeoutMs, renewBeforeMs, onEvent } = props);
  } catch {
    throw new OperatorSessionError("bad_config");
  }
  if (!validBaseUrl(baseUrl)) throw new OperatorSessionError("bad_base_url");
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) throw new OperatorSessionError("bad_address");
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new OperatorSessionError("bad_chain_id");
  }
  if (typeof signMessage !== "function") throw new OperatorSessionError("bad_signer");
  if (fetchImpl !== undefined && typeof fetchImpl !== "function") throw new OperatorSessionError("bad_fetch");
  if (now !== undefined && typeof now !== "function") throw new OperatorSessionError("bad_clock");
  if (onEvent !== undefined && typeof onEvent !== "function") throw new OperatorSessionError("bad_config");
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_MS)) {
    throw new OperatorSessionError("bad_timing");
  }
  if (renewBeforeMs !== undefined && (typeof renewBeforeMs !== "number" ||
    !Number.isInteger(renewBeforeMs) || renewBeforeMs < 120_000 || renewBeforeMs > 21_600_000)) {
    throw new OperatorSessionError("bad_timing");
  }
  const actualFetch = fetchImpl === undefined ? globalThis.fetch : fetchImpl;
  if (typeof actualFetch !== "function") throw new OperatorSessionError("bad_fetch");
  const url = new URL(baseUrl);
  return {
    urlPrefix: url.origin + url.pathname.replace(/\/+$/, ""),
    domain: url.host,
    uri: url.origin,
    address,
    chainId,
    signMessage: signMessage as OperatorMessageSigner,
    fetchImpl: actualFetch as typeof fetch,
    now: (now ?? Date.now) as () => number,
    timeoutMs: (timeoutMs ?? 15_000) as number,
    renewBeforeMs: (renewBeforeMs ?? 1_800_000) as number,
    onEvent: onEvent as Config["onEvent"],
  };
}

/** Pure EIP-4361 builder. No default fields, clock, or external state. */
export function buildOperatorSignInMessage(fields: OperatorSignInFields): string {
  let domain: unknown;
  let address: unknown;
  let statement: unknown;
  let uri: unknown;
  let version: unknown;
  let chainId: unknown;
  let nonce: unknown;
  let issuedAt: unknown;
  try {
    if (!isObject(fields)) throw new Error();
    ({ domain, address, statement, uri, version, chainId, nonce, issuedAt } = fields);
    if (typeof domain !== "string" || !/^[\x21-\x7e]{1,255}$/.test(domain) || /[/?#@]/.test(domain) ||
      typeof address !== "string" || !ADDRESS_RE.test(address) ||
      typeof statement !== "string" || !/^[\x20-\x7e]{1,512}$/.test(statement) ||
      typeof uri !== "string" || !/^[\x21-\x7e]{1,2048}$/.test(uri) ||
      version !== "1" ||
      typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0 ||
      typeof nonce !== "string" || !NONCE_RE.test(nonce) ||
      typeof issuedAt !== "string" || !ISSUED_AT_RE.test(issuedAt) || !Number.isFinite(Date.parse(issuedAt))) {
      throw new Error();
    }
  } catch {
    throw new OperatorSessionError("bad_fields");
  }
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    statement,
    "",
    `URI: ${uri}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

function clockNow(config: Config): number {
  try {
    const reading = config.now();
    if (typeof reading === "number" && Number.isFinite(reading) && Number.isFinite(new Date(reading).getTime())) {
      return reading;
    }
  } catch { /* discard clock exceptions */ }
  throw new OperatorSessionError("bad_clock");
}

function maybeNow(config: Config): number | null {
  try { return clockNow(config); } catch { return null; }
}

/** A deadline race even when fetch, a reader or a signer ignores AbortSignal. */
function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(TIMEOUT); };
    if (signal.aborted) { reject(TIMEOUT); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}

function timerDelay(ms: number): number {
  return Number.isFinite(ms) ? Math.min(MAX_TIMER_MS, Math.max(0, Math.ceil(ms))) : 0;
}

/** Read no more than the cap; malformed UTF-8 is refused, not substituted. */
async function responseText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const cancel = () => { try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ } };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const item = await withinDeadline(reader.read(), signal);
      if (signal.aborted) throw TIMEOUT;
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_REPLY_BYTES) { cancel(); throw TOO_LARGE; }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    try { reader.releaseLock(); } catch { /* an abandoned reader is already canceled */ }
  }
}

interface Reply {
  readonly status: number;
  readonly json: unknown;
  readonly isJson: boolean;
}

async function request(config: Config, route: "nonce" | "verify" | "session-key" | "logout",
  method: "GET" | "POST", headers: Record<string, string>, body?: string): Promise<Reply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  unrefTimer(timer);
  let status: number | null = null;
  try {
    const response = await withinDeadline(
      Promise.resolve().then(() => config.fetchImpl(`${config.urlPrefix}/api/auth/${route}`, {
        method,
        redirect: "error",
        credentials: "omit", // never attach a browser's ambient session cookie
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      })),
      controller.signal,
    );
    status = response.status;
    const text = await responseText(response, controller.signal);
    if (controller.signal.aborted) throw TIMEOUT;
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    const isJson = contentType === "application/json" ||
      /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(contentType ?? "");
    let json: unknown = null;
    if (isJson) {
      try { json = JSON.parse(text); } catch { /* no parse error or response text escapes */ }
    }
    return { status, json, isJson };
  } catch (error) {
    if (controller.signal.aborted || error === TIMEOUT) throw new OperatorSessionError("timeout");
    throw new OperatorSessionError(status === null ? "network" : "malformed_response", status);
  } finally {
    clearTimeout(timer);
  }
}

function own(record: unknown, key: string): unknown {
  return isObject(record) && Object.hasOwn(record, key) ? record[key] : undefined;
}

function requireStatus(step: Exclude<Step, "sign">, reply: Reply): Record<string, unknown> {
  const success = step === "session_key" ? 201 : 200;
  if (reply.status !== success) {
    const status = reply.status;
    let code: OperatorSessionErrorCode = "unexpected_status";
    if (step === "verify" && (status === 400 || status === 401)) code = "sign_in_refused";
    else if (step === "session_key" && (status === 401 || status === 403)) code = "session_refused";
    else if (step === "session_key" && status === 429 && own(reply.json, "error") === "too_many_keys") {
      code = "too_many_keys";
    } else if (status === 429) code = "rate_limited";
    else if (status >= 500 && status <= 599) code = "unavailable";
    throw new OperatorSessionError(code, status);
  }
  if (!reply.isJson || !isObject(reply.json)) throw new OperatorSessionError("malformed_response", reply.status);
  return reply.json;
}

async function atStep<T>(step: Step, action: () => Promise<T> | T): Promise<T> {
  try { return await action(); }
  catch (error) {
    throw new AttemptProblem(step, error instanceof OperatorSessionError
      ? error : new OperatorSessionError(step === "sign" ? "signer_failed" : "malformed_response"));
  }
}

async function sign(config: Config, fields: OperatorSignInFields, message: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  unrefTimer(timer);
  try {
    const signature = await withinDeadline(
      Promise.resolve().then(() => config.signMessage(message, fields)), controller.signal,
    );
    if (typeof signature !== "string" || !SIGNATURE_RE.test(signature)) {
      throw new OperatorSessionError("signer_failed");
    }
    return signature;
  } catch {
    throw new OperatorSessionError("signer_failed");
  } finally {
    clearTimeout(timer);
  }
}

function makeKey(apiKey: string, keyId: string, expiresAtMs: number): OperatorSessionKey {
  const value = { apiKey, keyId, expiresAtMs };
  Object.defineProperties(value, {
    toJSON: { value: () => ({ keyId, expiresAtMs }) },
    toString: { value: () => `[OperatorSessionKey ${keyId}]` },
    [Symbol.for("nodejs.util.inspect.custom")]: { value: () => `[OperatorSessionKey ${keyId}]` },
  });
  return Object.freeze(value);
}

/** Complete a full sign-in, or resume only step 3 for a still-young session. */
async function attemptMint(config: Config, resume: Session | null,
  onSession?: (session: Session) => void): Promise<MintResult> {
  let session = resume;
  if (session) {
    const age = await atStep("sign", () => clockNow(config) - session!.verifiedAtMs);
    if (age < 0 || age >= PENDING_SESSION_MAX_AGE_MS) session = null;
  }
  if (!session) {
    const nonce = await atStep("nonce", async () => {
      const body = requireStatus("nonce", await request(config, "nonce", "GET", { Accept: "application/json" }));
      const value = own(body, "nonce");
      if (typeof value !== "string" || !NONCE_RE.test(value)) {
        throw new OperatorSessionError("malformed_response", 200);
      }
      return value;
    });
    const { message, signature } = await atStep("sign", async () => {
      const issuedAt = new Date(clockNow(config)).toISOString();
      const fields: OperatorSignInFields = Object.freeze({
        domain: config.domain,
        address: config.address,
        statement: STATEMENT,
        uri: config.uri,
        version: "1",
        chainId: config.chainId,
        nonce,
        issuedAt,
      });
      const message = buildOperatorSignInMessage(fields);
      const signature = await sign(config, fields, message);
      return { message, signature };
    });
    const token = await atStep("verify", async () => {
      const body = requireStatus("verify", await request(config, "verify", "POST", {
        "Content-Type": "application/json", Accept: "application/json",
      }, JSON.stringify({ message, signature })));
      const token = own(body, "token");
      if (typeof token !== "string" || !/^[\x21-\x7e]{1,512}$/.test(token)) {
        throw new OperatorSessionError("malformed_response", 200);
      }
      const address = own(body, "address");
      if (typeof address !== "string" || address.toLowerCase() !== config.address.toLowerCase()) {
        throw new OperatorSessionError("address_mismatch", 200);
      }
      return token;
    });
    const verifiedAtMs = await atStep("sign", () => clockNow(config));
    session = { token, verifiedAtMs };
    onSession?.(session);
  }
  const activeSession = session;
  const sentAtMs = await atStep("sign", () => clockNow(config));
  const key = await atStep("session_key", async () => {
    const body = requireStatus("session_key", await request(config, "session-key", "POST", {
      Authorization: `Bearer ${activeSession.token}`, Accept: "application/json",
    }));
    const apiKey = own(body, "api_key");
    const keyId = own(body, "key_id");
    const address = own(body, "operator_id");
    const expiresAt = own(body, "expires_at");
    const createdAt = own(body, "created_at");
    if (typeof address !== "string" || address.toLowerCase() !== config.address.toLowerCase()) {
      throw new OperatorSessionError("address_mismatch", 201);
    }
    if (typeof apiKey !== "string" || !KEY_RE.test(apiKey) ||
      typeof keyId !== "string" || keyId.length < 1 || keyId.length > 200 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(keyId) ||
      typeof expiresAt !== "string" || typeof createdAt !== "string") {
      throw new OperatorSessionError("malformed_response", 201);
    }
    const lifetimeMs = Date.parse(expiresAt) - Date.parse(createdAt);
    if (!Number.isFinite(lifetimeMs) || lifetimeMs <= EXPIRY_MARGIN_MS) {
      throw new OperatorSessionError("malformed_response", 201);
    }
    return makeKey(apiKey, keyId, sentAtMs + lifetimeMs);
  });
  return { key, session: activeSession };
}

/** Mint once. No session is kept: the returned key cannot be logged out by this function. */
export async function mintOperatorSessionKey(options: OperatorSessionOptions): Promise<OperatorSessionKey> {
  const config = configFor(options);
  try {
    return (await attemptMint(config, null)).key;
  } catch (error) {
    if (error instanceof AttemptProblem) throw error.error;
    throw new OperatorSessionError("network");
  }
}

/**
 * Keep a usable operator key in memory, renewing through a fresh SIWE session.
 * The caller, not this module, sends that key on its own authenticated requests.
 */
export function createOperatorSessionKeeper(options: OperatorSessionKeeperOptions): OperatorSessionKeeper {
  const config = configFor(options); // all validation is synchronous
  let stopped = false;
  let current: { readonly key: OperatorSessionKey; readonly session: Session; readonly mintedAtMs: number } | null = null;
  let pending: Session | null = null;
  // The last key may still authenticate at the gateway during our 60s safety margin.
  let expiredKeySession: Session | null = null;
  let inflight: Promise<void> | null = null;
  let mintTimer: ReturnType<typeof setTimeout> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSuccessfulMintAtMs: number | null = null;
  let nextRetryMs = RETRY_FIRST_MS;
  let stopPromise: Promise<void> | null = null;
  const waiting: Array<(key: OperatorSessionKey | null) => void> = [];
  const logouts = new Map<string, Promise<void>>();

  const event = (value: OperatorSessionEvent): void => {
    if (config.onEvent) {
      try { config.onEvent(Object.freeze(value)); } catch { /* host callback cannot stop the keeper */ }
    }
  };

  const clearMintTimer = () => {
    if (mintTimer !== null) { clearTimeout(mintTimer); mintTimer = null; }
  };
  const clearExpiryTimer = () => {
    if (expiryTimer !== null) { clearTimeout(expiryTimer); expiryTimer = null; }
  };

  const key = (): OperatorSessionKey | null => {
    if (stopped || !current) return null;
    const reading = maybeNow(config);
    return reading !== null && reading < current.key.expiresAtMs - EXPIRY_MARGIN_MS ? current.key : null;
  };

  const settleWaiting = (value: OperatorSessionKey | null) => {
    for (const resolve of waiting.splice(0)) resolve(value);
  };

  const logout = (session: Session | null): Promise<void> => {
    if (!session) return Promise.resolve();
    const previous = logouts.get(session.token);
    if (previous) return previous;
    const work = request(config, "logout", "POST", {
      Authorization: `Bearer ${session.token}`, Accept: "application/json",
    }).then(() => undefined, () => undefined);
    logouts.set(session.token, work);
    return work;
  };

  const expireIfDue = () => {
    if (!current) return;
    const reading = maybeNow(config);
    if (reading === null || reading < current.key.expiresAtMs - EXPIRY_MARGIN_MS) return;
    expiredKeySession = current.session;
    current = null;
    clearExpiryTimer();
    event({ kind: "key_expired" });
  };

  const armExpiry = () => {
    clearExpiryTimer();
    if (stopped || !current) return;
    const reading = maybeNow(config);
    if (reading === null) return;
    const until = current.key.expiresAtMs - EXPIRY_MARGIN_MS - reading;
    if (until <= 0) { expireIfDue(); return; }
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      if (!stopped) { expireIfDue(); armExpiry(); }
    }, timerDelay(until));
    unrefTimer(expiryTimer);
  };

  const armMint = (targetMs: number) => {
    clearMintTimer();
    if (stopped || inflight) return;
    const reading = maybeNow(config);
    // If the clock is temporarily unusable, retry checking it rather than minting early.
    const delay = reading === null ? RETRY_FIRST_MS : timerDelay(targetMs - reading);
    mintTimer = setTimeout(() => {
      mintTimer = null;
      if (stopped || inflight) return;
      const awake = maybeNow(config);
      if (awake === null) { startMint(); return; }
      if (awake < targetMs) { armMint(targetMs); return; }
      startMint();
    }, delay);
    unrefTimer(mintTimer);
  };

  const startMint = () => {
    if (stopped || inflight) return;
    clearMintTimer();
    // Setting the single-flight lock happens before the first async continuation.
    const work = (async () => {
      try {
        const result = await attemptMint(config, pending, session => { pending = session; });
        if (stopped) { await logout(result.session); return; }
        const mintedAtMs = clockNow(config);
        pending = null;
        expiredKeySession = null; // normal renewal intentionally leaves older keys alone
        current = Object.freeze({ key: result.key, session: result.session, mintedAtMs });
        lastSuccessfulMintAtMs = mintedAtMs;
        minimumNextMintAtMs = null;
        nextRetryMs = RETRY_FIRST_MS;
        event({ kind: "key_minted", keyId: result.key.keyId, expiresAtMs: result.key.expiresAtMs });
        if (stopped || current?.key !== result.key) return;
        const available = key();
        if (available) settleWaiting(available);
        armExpiry();
        // Scheduled after the flight unlocks in finally, below.
      } catch (problem) {
        if (stopped) { await logout(pending); return; }
        const failed = problem instanceof AttemptProblem ? problem :
          new AttemptProblem("sign", problem instanceof OperatorSessionError
            ? problem : new OperatorSessionError("bad_clock"));
        if (failed.error.code === "session_refused") pending = null;
        expireIfDue();
        const delay = nextRetryMs;
        nextRetryMs = Math.min(RETRY_CAP_MS, nextRetryMs * 2);
        event({ kind: "mint_failed", code: failed.error.code, status: failed.error.status,
          retryInMs: delay, step: failed.step });
        if (!stopped) {
          const reading = maybeNow(config);
          scheduledAfterFlight = reading === null ? null : reading + delay;
        }
      }
    })();
    // Continuations above cannot access the timer until work is assigned.
    inflight = work;
    void work.then(() => {
      if (inflight === work) inflight = null;
      if (stopped) return;
      const target = scheduledAfterFlight;
      scheduledAfterFlight = null;
      if (target !== null) armMint(Math.max(target, minimumNextMintAtMs ?? target));
      else if (current) {
        armMint(Math.max(current.key.expiresAtMs - config.renewBeforeMs,
          current.mintedAtMs + MIN_MINT_SPACING_MS));
      } else {
        const now = maybeNow(config);
        const target = (now ?? Date.now()) + RETRY_FIRST_MS;
        armMint(Math.max(target, minimumNextMintAtMs ?? target));
      }
    });
  };

  let scheduledAfterFlight: number | null = null;
  let minimumNextMintAtMs: number | null = null;

  const ready = (): Promise<OperatorSessionKey | null> => {
    if (stopped) return Promise.resolve(null);
    const available = key();
    if (available) return Promise.resolve(available);
    return new Promise(resolve => { waiting.push(resolve); });
  };

  const invalidate = (keyId: string): void => {
    if (stopped || typeof keyId !== "string" || !current || current.key.keyId !== keyId) return;
    const session = current.session;
    current = null;
    clearExpiryTimer();
    clearMintTimer();
    void logout(session);
    const reading = maybeNow(config);
    const minimum = lastSuccessfulMintAtMs === null ? 0 : lastSuccessfulMintAtMs + MIN_MINT_SPACING_MS;
    minimumNextMintAtMs = minimum;
    if (inflight) return;
    armMint(Math.max(reading ?? 0, minimum));
  };

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopped = true;
    clearMintTimer();
    clearExpiryTimer();
    const activeSession = current?.session ?? null;
    const unfinishedSession = pending;
    const expiringSession = expiredKeySession;
    current = null;
    pending = null;
    expiredKeySession = null;
    settleWaiting(null);
    stopPromise = (async () => {
      await Promise.all([logout(activeSession), logout(unfinishedSession), logout(expiringSession)]);
      if (inflight) await inflight;
      await Promise.all([...logouts.values()]);
    })().catch(() => undefined);
    event({ kind: "stopped" });
    return stopPromise;
  };

  // Start immediately; there is no stored credential or background persistence.
  startMint();
  return Object.freeze({ key, ready, invalidate, stop });
}
