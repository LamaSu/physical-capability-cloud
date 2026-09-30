/**
 * Gateway spend guard (N46; operator item 57, option a).
 *
 * The gateway MAY pay on users' behalf, but only within hard caps. The gateway
 * signer is the payer when a negotiated session becomes a job in real settlement
 * (createJobFromSession: commit, retry-settlement, submit-from-discovery and the
 * A2A pcc-submit skill), and it signs the testnet faucet's mints and the PGTR
 * relay's meta-transactions. Before this guard, any authenticated key could make
 * the signer fund escrow with no cap at all.
 *
 * Every gateway-paid action is admitted here BEFORE any signer call, and a
 * refusal is always whole (never a partial payment):
 *   - a kill switch, PCC_GATEWAY_PAYS_ENABLED. Unset, it is ON on a testnet
 *     (PCC_NETWORK base-sepolia, sepolia, *-testnet) and OFF anywhere else, so a
 *     mainnet deployment pays nothing until the operator turns it on;
 *   - a per-action cap (402), per-principal and per-API-key daily caps (429), and
 *     a GLOBAL daily cap that acts as a circuit breaker (503 plus an alert);
 *   - faucet and relay throttles (429).
 * A cap override that is not a valid number fails CLOSED (503 plus an alert),
 * as the operator ruled for N67.
 *
 * INTERIM: the counters are process-local. They reset on restart and are per
 * instance, which is weaker than the ledger table proposed in
 * returns/pcc-gateway-work/N46-gateway-pays-design-20260929.md. That DDL is
 * parked for the operator's schema approval. The counters are still strictly
 * better than no cap.
 *
 * Only the caps live here. WHO may trigger a gateway-paid action (the caller
 * bound to the session's buyer, the create-escrow and release routes' owners)
 * is the authority layer, and it ships with WP-A (#326).
 */
import { Sentry } from "../sentry.js";

export type GatewaySpendAction =
  | "commit"
  | "retry_settlement"
  | "submit_from_discovery"
  | "a2a_submit"
  | "unattributed";

/** Who asked for a gateway-paid action: the authenticated caller, when known. */
export interface GatewaySpender {
  action: GatewaySpendAction;
  /** The caller's identity (API-key operatorId or SIWE address). */
  principal?: string;
  /** The API key that asked, when the caller used one. */
  apiKeyId?: string;
}

export interface GatewaySpendInput {
  spender: GatewaySpender;
  /** The amount the gateway signer would pay, in integer micro-USD (6 decimals). */
  amountMicro: bigint;
}

export type GatewaySpendRefusal = {
  ok: false;
  status: 400 | 402 | 429 | 503;
  error: string;
  message: string;
};
export type GatewaySpendDecision = { ok: true } | GatewaySpendRefusal;

/**
 * The authenticated caller of a request that passed apiGate. apiGate sets
 * apiKeyId and operatorId for a key, and userId for a SIWE session.
 */
export function requestCaller(req: unknown): { principal?: string; apiKeyId?: string } {
  const r = req as { apiKeyId?: unknown; operatorId?: unknown; userId?: unknown };
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  return { principal: str(r.operatorId) ?? str(r.userId), apiKeyId: str(r.apiKeyId) };
}

/** The authenticated caller of a request, as the spender of `action`. */
export function spenderOfRequest(req: unknown, action: GatewaySpendAction): GatewaySpender {
  return { action, ...requestCaller(req) };
}

/** Thrown by a signer path when the guard refuses; the caller maps `status`. */
export class GatewaySpendRefusedError extends Error {
  readonly status: GatewaySpendRefusal["status"];
  readonly code: string;
  constructor(refusal: GatewaySpendRefusal) {
    // The prefix lets the settlement-failure classifier see that the refusal
    // came before any chain call (routes/negotiation.ts settlementFailureClass).
    super(`${GATEWAY_SPEND_REFUSED_PREFIX}${refusal.error}: ${refusal.message}`);
    this.name = "GatewaySpendRefusedError";
    this.status = refusal.status;
    this.code = refusal.error;
  }
}

export const GATEWAY_SPEND_REFUSED_PREFIX = "gateway_spend_refused:";

const MICRO = 1_000_000n;

// ── Network and configuration ────────────────────────────────────────────────

/** True when PCC_NETWORK names a testnet. An unknown network is NOT a testnet. */
export function isTestnetNetwork(network = process.env.PCC_NETWORK ?? "base-sepolia"): boolean {
  const n = network.trim().toLowerCase();
  return n === "localhost" || n.includes("sepolia") || n.includes("testnet");
}

interface SpendCaps {
  perActionMicro: bigint;
  perPrincipalDayMicro: bigint;
  perKeyDayMicro: bigint;
  globalDayMicro: bigint;
}

/** Proposed values from the N46 design; the operator may override each by env. */
const DEFAULT_CAPS_USD = {
  testnet: { perAction: 25, perPrincipalDay: 100, perKeyDay: 100, globalDay: 500 },
  mainnet: { perAction: 10, perPrincipalDay: 25, perKeyDay: 25, globalDay: 100 },
} as const;

const CAP_ENV = {
  perAction: "PCC_GATEWAY_PAYS_MAX_PER_ACTION_USD",
  perPrincipalDay: "PCC_GATEWAY_PAYS_MAX_PER_PRINCIPAL_DAY_USD",
  perKeyDay: "PCC_GATEWAY_PAYS_MAX_PER_KEY_DAY_USD",
  globalDay: "PCC_GATEWAY_PAYS_MAX_GLOBAL_DAY_USD",
} as const;

type Config =
  | { ok: true; enabled: boolean; caps: SpendCaps }
  | { ok: false; problem: string };

/** Parse a non-negative USD amount with at most 6 decimals into micro-USD. */
function usdToMicro(raw: string): bigint | null {
  const s = raw.trim();
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]!) * MICRO + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

function readConfig(): Config {
  const testnet = isTestnetNetwork();
  const flag = process.env.PCC_GATEWAY_PAYS_ENABLED;
  let enabled: boolean;
  // Default ONLY when the variable is absent. A present-but-blank value is a
  // misconfiguration, not "use the default" — a blank must never silently
  // restore spending (astra pack 103, HIGH).
  if (flag === undefined) enabled = testnet;
  else if (flag.trim() === "") return { ok: false, problem: "PCC_GATEWAY_PAYS_ENABLED is blank" };
  else if (/^(true|1|on)$/i.test(flag.trim())) enabled = true;
  else if (/^(false|0|off)$/i.test(flag.trim())) enabled = false;
  else return { ok: false, problem: "PCC_GATEWAY_PAYS_ENABLED is not true/false" };

  const defaults = testnet ? DEFAULT_CAPS_USD.testnet : DEFAULT_CAPS_USD.mainnet;
  const caps = {} as Record<keyof typeof CAP_ENV, bigint>;
  for (const key of Object.keys(CAP_ENV) as Array<keyof typeof CAP_ENV>) {
    const raw = process.env[CAP_ENV[key]];
    if (raw === undefined) {
      caps[key] = BigInt(defaults[key]) * MICRO;
      continue;
    }
    if (raw.trim() === "") return { ok: false, problem: `${CAP_ENV[key]} is blank` };
    const v = usdToMicro(raw);
    if (v === null) return { ok: false, problem: `${CAP_ENV[key]} is not a non-negative USD amount` };
    caps[key] = v;
  }
  return {
    ok: true,
    enabled,
    caps: {
      perActionMicro: caps.perAction,
      perPrincipalDayMicro: caps.perPrincipalDay,
      perKeyDayMicro: caps.perKeyDay,
      globalDayMicro: caps.globalDay,
    },
  };
}

// ── Alerts (once per process per condition per UTC day) ─────────────────────

const alerted = new Set<string>();

function alertOnce(key: string, message: string): void {
  const k = `${utcDay()}:${key}`;
  if (alerted.has(k)) return;
  alerted.add(k);
  console.error(`[gateway-spend-guard] ALERT: ${message}`);
  try {
    Sentry.captureMessage(`gateway-spend-guard: ${message}`, "error");
  } catch {
    // Alerting must never turn a refusal into a crash.
  }
}

// ── Process-local ledger ─────────────────────────────────────────────────────

interface SpendEntry {
  day: string;
  principal: string;
  keyId: string;
  action: GatewaySpendAction;
  amountMicro: bigint;
}

let now: () => number = () => Date.now();
let entries: SpendEntry[] = [];
// F4 (astra pack 103): the process-local ledger is pruned to the current UTC
// day, so a backward clock step would silently drop a prior day's admissions and
// replenish the allowance. Refuse any admission once the observed day has gone
// backwards from the furthest day already seen in this process.
let maxDaySeen = "";
function dayRegressed(day: string): boolean {
  if (day < maxDaySeen) return true;
  if (day > maxDaySeen) maxDaySeen = day;
  return false;
}
const CLOCK_REGRESSED: GatewaySpendRefusal = {
  ok: false,
  status: 503,
  error: "gateway_pays_clock_regressed",
  message: "Gateway-paid actions are paused: the server clock moved backward across a UTC day; the daily caps cannot be trusted.",
};

function utcDay(ms = now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function normalizePrincipal(p: string | undefined): string {
  const s = (p ?? "").normalize("NFKC").trim().toLowerCase();
  return s || "unknown";
}

function sumToday(filter: (e: SpendEntry) => boolean): bigint {
  const day = utcDay();
  let total = 0n;
  for (const e of entries) if (e.day === day && filter(e)) total += e.amountMicro;
  return total;
}

function pruneOldEntries(): void {
  const day = utcDay();
  if (entries.some((e) => e.day !== day)) entries = entries.filter((e) => e.day === day);
}

const usd = (micro: bigint): string => {
  const whole = micro / MICRO;
  const frac = (micro % MICRO).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `$${whole}.${frac}` : `$${whole}`;
};

/**
 * Would the gateway pay `amountMicro` for this spender now? No side effects.
 * Routes call it BEFORE changing any state, so a refusal leaves nothing behind.
 */
export function checkGatewaySpend(input: GatewaySpendInput): GatewaySpendDecision {
  const cfg = readConfig();
  if (!cfg.ok) {
    alertOnce(`misconfigured:${cfg.problem}`, `gateway-paid actions refused: ${cfg.problem}`);
    return {
      ok: false,
      status: 503,
      error: "gateway_pays_misconfigured",
      message: "Gateway-paid actions are unavailable: the spend guard's configuration is invalid.",
    };
  }
  if (!cfg.enabled) {
    return {
      ok: false,
      status: 503,
      error: "gateway_pays_disabled",
      message: "The gateway does not pay on callers' behalf here (PCC_GATEWAY_PAYS_ENABLED is off).",
    };
  }
  const amount = input.amountMicro;
  if (amount < 0n) {
    return { ok: false, status: 400, error: "gateway_pay_invalid_amount", message: "The amount to fund is negative." };
  }
  const { caps } = cfg;
  if (amount > caps.perActionMicro) {
    return {
      ok: false,
      status: 402,
      error: "gateway_pay_over_action_cap",
      message: `The gateway pays at most ${usd(caps.perActionMicro)} per action; this one needs ${usd(amount)}. Fund it yourself.`,
    };
  }
  pruneOldEntries();
  const principal = normalizePrincipal(input.spender.principal);
  if (sumToday((e) => e.principal === principal) + amount > caps.perPrincipalDayMicro) {
    return {
      ok: false,
      status: 429,
      error: "gateway_pay_principal_daily_cap",
      message: `This caller's gateway-paid total for today would pass ${usd(caps.perPrincipalDayMicro)} (UTC day).`,
    };
  }
  const keyId = input.spender.apiKeyId ? `key:${input.spender.apiKeyId}` : `principal:${principal}`;
  if (sumToday((e) => e.keyId === keyId) + amount > caps.perKeyDayMicro) {
    return {
      ok: false,
      status: 429,
      error: "gateway_pay_key_daily_cap",
      message: `This API key's gateway-paid total for today would pass ${usd(caps.perKeyDayMicro)} (UTC day).`,
    };
  }
  if (sumToday(() => true) + amount > caps.globalDayMicro) {
    alertOnce(
      "breaker",
      `the global daily cap (${usd(caps.globalDayMicro)}) is reached; gateway-paid actions are refused until the next UTC day`,
    );
    return {
      ok: false,
      status: 503,
      error: "gateway_pays_daily_breaker",
      message: "Gateway-paid actions are paused for today: the global daily cap is reached.",
    };
  }
  return { ok: true };
}

/**
 * Admit a gateway-paid action: check it and, when allowed, count it at once.
 * Call it immediately BEFORE the first signer write. An admitted amount stays
 * counted even if the signer path later fails, because a failure can follow a
 * write that moved funds; the guard never under-counts.
 */
/**
 * The "may the gateway pay at all right now?" gate: the kill switch, a valid
 * config, and a non-regressed clock — WITHOUT counting anything against the
 * daily caps. Deferred-funding paths (the standalone /fund route, the settlement
 * crank) use this so a disabled or misconfigured gateway never signs a funding,
 * without double-counting an amount already admitted at escrow creation. The
 * per-amount daily debit for deferred funding needs the reservation ledger
 * (parked for the operator's schema approval).
 */
export function gatewayPaymentsGate(): GatewaySpendDecision {
  const cfg = readConfig();
  if (!cfg.ok) {
    alertOnce(`misconfigured:${cfg.problem}`, `gateway-paid actions refused: ${cfg.problem}`);
    return { ok: false, status: 503, error: "gateway_pays_misconfigured", message: "Gateway-paid actions are unavailable: the spend guard's configuration is invalid." };
  }
  if (!cfg.enabled) {
    return { ok: false, status: 503, error: "gateway_pays_disabled", message: "The gateway does not pay on callers' behalf here (PCC_GATEWAY_PAYS_ENABLED is off)." };
  }
  if (dayRegressed(utcDay(now()))) return CLOCK_REGRESSED;
  return { ok: true };
}

export function admitGatewaySpend(input: GatewaySpendInput): GatewaySpendDecision {
  if (dayRegressed(utcDay(now()))) return CLOCK_REGRESSED;
  const decision = checkGatewaySpend(input);
  if (!decision.ok) return decision;
  const principal = normalizePrincipal(input.spender.principal);
  entries.push({
    day: utcDay(),
    principal,
    keyId: input.spender.apiKeyId ? `key:${input.spender.apiKeyId}` : `principal:${principal}`,
    action: input.spender.action,
    amountMicro: input.amountMicro,
  });
  return decision;
}

// ── Faucet and relay throttles ───────────────────────────────────────────────

const FAUCET_DEFAULTS = { maxPerCall: 100, perWalletDay: 500, perKeyHour: 5 } as const;
const RELAY_DEFAULTS = { perKeyHour: 20, globalDay: 200 } as const;

function intEnv(name: string, fallback: number): number | null {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw.trim() === "") return null; // present-but-blank is a misconfiguration, not the default
  return /^\d{1,9}$/.test(raw.trim()) ? Number(raw.trim()) : null;
}

const HOUR_MS = 3_600_000;
let faucetDrips: Array<{ at: number; day: string; wallet: string; keyId: string; principalId: string; amount: number }> = [];
let relays: Array<{ at: number; day: string; keyId: string; principalId: string }> = [];

function callerKey(spender: { principal?: string; apiKeyId?: string }): string {
  return spender.apiKeyId ? `key:${spender.apiKeyId}` : `principal:${normalizePrincipal(spender.principal)}`;
}

/** The faucet's largest single drip (whole mUSDC). */
export function faucetMaxPerCall(): number | null {
  return intEnv("PCC_FAUCET_MAX_PER_CALL", FAUCET_DEFAULTS.maxPerCall);
}

/**
 * Admit one faucet drip of `amount` whole mUSDC to `wallet`. It is refused off a
 * testnet, over the per-call cap, past the per-wallet daily total, and past the
 * per-caller hourly call count. An admitted drip is counted at once.
 */
export function admitFaucetDrip(input: {
  wallet: string;
  amount: number;
  spender: { principal?: string; apiKeyId?: string };
}): GatewaySpendDecision {
  if (!isTestnetNetwork()) {
    return { ok: false, status: 503, error: "faucet_disabled", message: "The faucet runs only on a testnet deployment." };
  }
  // F1 (astra pack 103): the faucet signs with the gateway/deployer key, so the
  // payment kill switch and a malformed config must stop it too.
  const cfg = readConfig();
  if (!cfg.ok) { alertOnce(`misconfigured:${cfg.problem}`, `faucet refused: ${cfg.problem}`); return { ok: false, status: 503, error: "gateway_pays_misconfigured", message: "Gateway-paid actions are unavailable: the spend guard's configuration is invalid." }; }
  if (!cfg.enabled) return { ok: false, status: 503, error: "gateway_pays_disabled", message: "The gateway does not pay on callers' behalf here (PCC_GATEWAY_PAYS_ENABLED is off)." };
  if (dayRegressed(utcDay(now()))) return CLOCK_REGRESSED;
  const maxPerCall = faucetMaxPerCall();
  const perWalletDay = intEnv("PCC_FAUCET_MAX_PER_WALLET_DAY", FAUCET_DEFAULTS.perWalletDay);
  const perKeyHour = intEnv("PCC_FAUCET_MAX_CALLS_PER_KEY_HOUR", FAUCET_DEFAULTS.perKeyHour);
  if (maxPerCall === null || perWalletDay === null || perKeyHour === null) {
    alertOnce("faucet-misconfigured", "faucet refused: a PCC_FAUCET_* cap is not a whole number");
    return { ok: false, status: 503, error: "faucet_misconfigured", message: "The faucet's configuration is invalid." };
  }
  if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > maxPerCall) {
    return { ok: false, status: 400, error: "faucet_amount_out_of_range", message: `Amount must be a whole number from 1 to ${maxPerCall} mUSDC.` };
  }
  const t = now();
  const day = utcDay(t);
  faucetDrips = faucetDrips.filter((d) => d.day === day || t - d.at < HOUR_MS);
  const wallet = input.wallet.trim().toLowerCase();
  const walletToday = faucetDrips.filter((d) => d.day === day && d.wallet === wallet).reduce((s, d) => s + d.amount, 0);
  if (walletToday + input.amount > perWalletDay) {
    return { ok: false, status: 429, error: "faucet_wallet_daily_cap", message: `This wallet's faucet total for today would pass ${perWalletDay} mUSDC.` };
  }
  // F3 (astra pack 103): enforce the hourly count on BOTH the key and the
  // principal, so an operator cannot multiply the limit by minting keys.
  const keyId = callerKey(input.spender);
  const principalId = `principal:${normalizePrincipal(input.spender.principal)}`;
  const withinHour = (pred: (d: { keyId: string; principalId: string; at: number }) => boolean) =>
    faucetDrips.filter((d) => pred(d) && t - d.at < HOUR_MS).length;
  if (withinHour((d) => d.keyId === keyId) >= perKeyHour || withinHour((d) => d.principalId === principalId) >= perKeyHour) {
    return { ok: false, status: 429, error: "faucet_rate_limited", message: `At most ${perKeyHour} faucet calls per hour per caller.` };
  }
  faucetDrips.push({ at: t, day, wallet, keyId, principalId, amount: input.amount });
  return { ok: true };
}

/**
 * Admit one PGTR relay (the relayer key pays its gas). Refused past the
 * per-caller hourly count and the global daily count. Counted at once.
 */
export function admitRelay(spender: { principal?: string; apiKeyId?: string }): GatewaySpendDecision {
  // F1 (astra pack 103): the relayer key signs, so the payment kill switch and a
  // malformed config must stop it too.
  const cfg = readConfig();
  if (!cfg.ok) { alertOnce(`misconfigured:${cfg.problem}`, `relay refused: ${cfg.problem}`); return { ok: false, status: 503, error: "gateway_pays_misconfigured", message: "Gateway-paid actions are unavailable: the spend guard's configuration is invalid." }; }
  if (!cfg.enabled) return { ok: false, status: 503, error: "gateway_pays_disabled", message: "The gateway does not pay on callers' behalf here (PCC_GATEWAY_PAYS_ENABLED is off)." };
  const perKeyHour = intEnv("PCC_RELAY_MAX_PER_KEY_HOUR", RELAY_DEFAULTS.perKeyHour);
  const globalDay = intEnv("PCC_RELAY_MAX_GLOBAL_DAY", RELAY_DEFAULTS.globalDay);
  if (perKeyHour === null || globalDay === null) {
    alertOnce("relay-misconfigured", "relay refused: a PCC_RELAY_* cap is not a whole number");
    return { ok: false, status: 503, error: "relay_misconfigured", message: "The relay's configuration is invalid." };
  }
  const t = now();
  const day = utcDay(t);
  if (dayRegressed(day)) return CLOCK_REGRESSED;
  relays = relays.filter((r) => r.day === day || t - r.at < HOUR_MS);
  if (relays.filter((r) => r.day === day).length >= globalDay) {
    alertOnce("relay-breaker", `the relay's global daily count (${globalDay}) is reached`);
    return { ok: false, status: 503, error: "relay_daily_breaker", message: "Relaying is paused for today: the global daily count is reached." };
  }
  const keyId = callerKey(spender);
  const principalId = `principal:${normalizePrincipal(spender.principal)}`;
  const relaysWithin = (pred: (r: { keyId: string; principalId: string; at: number }) => boolean) =>
    relays.filter((r) => pred(r) && t - r.at < HOUR_MS).length;
  if (relaysWithin((r) => r.keyId === keyId) >= perKeyHour || relaysWithin((r) => r.principalId === principalId) >= perKeyHour) {
    return { ok: false, status: 429, error: "relay_rate_limited", message: `At most ${perKeyHour} relays per hour per caller.` };
  }
  relays.push({ at: t, day, keyId, principalId });
  return { ok: true };
}

// ── Test hooks ───────────────────────────────────────────────────────────────

export function __resetGatewaySpendGuardForTests(clock?: () => number): void {
  entries = [];
  faucetDrips = [];
  relays = [];
  alerted.clear();
  maxDaySeen = "";
  now = clock ?? (() => Date.now());
}
