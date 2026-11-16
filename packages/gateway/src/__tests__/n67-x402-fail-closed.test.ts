/**
 * N67 -- the aggregator's x402 money gate must FAIL CLOSED; it must never
 * switch itself off because of a configuration mistake.
 *
 * Operator decision (2026-09-29, item 80): "fail closed with a 503 and an alert".
 *
 * The hole (master 75fd440b): `getX402GateConfig()` returned `undefined`
 * (= gate DISABLED) in two different situations:
 *   1. PCC_X402_ENABLED is not "true"
 *        -> disabled by configuration. Correct.
 *   2. PCC_X402_ENABLED=true but PCC_AGGREGATOR_TREASURY missing / malformed /
 *      the zero address
 *        -> logged "gate disabled", and invoke.ts then served EVERY paid
 *           aggregator call for free. A money gate that turns itself off.
 * and `resolveChainConfig` mapped ANY unknown PCC_X402_CHAIN value to
 * base-sepolia, so a typo in a mainnet value silently priced and verified on
 * testnet.
 *
 * Harness: same shape as aggregator-x402.test.ts (Fastify + in-memory store +
 * the aggregator routes + a mocked fetch). The facilitator host is the reserved
 * `.test` TLD and the fetch mock THROWS for any other host, so nothing here can
 * reach a real facilitator or chain. All env values are synthetic; every
 * variable these tests touch is snapshotted before and restored after.
 *
 * What counts as "paid" (same predicate requirePayment() uses): the tool's
 * `pricing.perCallUsdc` parses to a finite number > 0. A tool with no
 * `pricing`, or a price of "0", is free and keeps working under a
 * misconfigured gate.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import {
  aggregatorRoutes,
  getAggregatorRegistry,
  getX402GateConfig,
  isX402GateMisconfigured,
  _resetAggregatorRegistryForTests,
} from "../routes/aggregator/index.js";
import { initStore, closeStore } from "../db.js";
import {
  type IndexedTool,
  type X402PaymentPayload,
  type X402PaymentRequirements,
  DigitalCaptureClass,
  TrustTier,
} from "@pcc/spec";
import {
  toAtomicUsdc,
  priceTagHmac,
  type PriceTagFields,
} from "@pcc/aggregator";

// ---------------------------------------------------------------------------
// Sentry mock: the gateway's alerting facility is Sentry (src/sentry.ts). Only
// captureMessage / isSentryEnabled are replaced; everything else stays real.
// ---------------------------------------------------------------------------

const sentryMock = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  enabled: vi.fn(() => true),
}));

vi.mock("../sentry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sentry.js")>();
  return {
    ...actual,
    Sentry: new Proxy(actual.Sentry, {
      get(target, prop, receiver) {
        if (prop === "captureMessage") return sentryMock.captureMessage;
        return Reflect.get(target, prop, receiver);
      },
    }),
    isSentryEnabled: () => sentryMock.enabled(),
  };
});

// ---------------------------------------------------------------------------
// Constants (all synthetic)
// ---------------------------------------------------------------------------

const SHA = "sha256:" + "a".repeat(64);
const HMAC = "deadbeef".repeat(8); // 64 hex chars
const TREASURY = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const ZERO_ADDRESS = "0x" + "0".repeat(40);

const SEPOLIA = {
  network: "eip155:84532",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};
const MAINNET = {
  network: "eip155:8453",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

/** The exact refusal the operator specified for a misconfigured gate. */
const REFUSAL_BODY = {
  error: "payment_gate_misconfigured",
  message:
    "paid aggregator calls are unavailable: the payment gate is misconfigured",
};

/** Sentinel: the env var must be truly unset (deleted), not set to a string. */
const UNSET = Symbol("unset");
type EnvVal = string | typeof UNSET;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePaidTool(perCallUsdc = "0.01"): IndexedTool {
  return {
    id: "paid-tool-1",
    cid: SHA,
    version: "1.0.0",
    source: {
      type: "mcp-directory",
      url: "https://mcp.example.com",
      fetchedAt: "2026-05-23T00:00:00.000Z",
    },
    ingestedAt: "2026-05-23T00:00:00.000Z",
    ingestionMethod: "mcp-list",
    upstreamUrl: "https://api.example.com/paid",
    skills: [],
    domains: [],
    features: [],
    inputSchema: { type: "object" },
    description: "a paid tool",
    actionClass: "read",
    assuranceCeiling: DigitalCaptureClass.DCC3,
    trustTier: TrustTier.AUTO_INDEXED,
    pricing: { perCallUsdc },
    knownVulns: [],
    lastFetchedAt: "2026-05-23T00:00:00.000Z",
    invocationCount: 0,
    driftAlerts: [],
    schemaHashHistory: [SHA],
    hostingPeers: [],
  };
}

/** A tool with no `pricing` at all. */
function makeFreeTool(): IndexedTool {
  const t = makePaidTool();
  t.id = "free-tool-1";
  delete t.pricing;
  return t;
}

/** A tool with an explicit zero price: free by the same predicate. */
function makeZeroPriceTool(): IndexedTool {
  const t = makePaidTool("0");
  t.id = "zero-price-tool-1";
  return t;
}

// ---------------------------------------------------------------------------
// Env management: snapshot -> clear -> (test sets synthetic values) -> restore
// ---------------------------------------------------------------------------

const GATE_ENV_KEYS = [
  "PCC_X402_ENABLED",
  "PCC_X402_CHAIN",
  "PCC_X402_FACILITATOR_URL",
  "PCC_AGGREGATOR_TREASURY",
  "PCC_X402_HMAC_KEY",
  "PCC_AGGREGATOR_HMAC_KEY",
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
  "PCC_DB_PATH",
] as const;

let savedEnv: Record<string, string | undefined> = {};

function snapshotAndClearEnv(): void {
  savedEnv = {};
  for (const k of GATE_ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of GATE_ENV_KEYS) delete process.env[k];
}

function restoreEnv(): void {
  for (const k of GATE_ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function setEnv(key: string, value: EnvVal): void {
  if (value === UNSET) delete process.env[key];
  else process.env[key] = value;
}

/**
 * Configure the gate env. Defaults describe a VALID testnet gate; pass an
 * override (or UNSET) to break exactly one thing.
 */
function gateEnv(
  o: { enabled?: EnvVal; chain?: EnvVal; treasury?: EnvVal } = {},
): void {
  setEnv("PCC_X402_ENABLED", o.enabled ?? "true");
  setEnv("PCC_X402_CHAIN", o.chain ?? "base-sepolia");
  setEnv("PCC_AGGREGATOR_TREASURY", o.treasury ?? TREASURY);
  process.env.PCC_X402_FACILITATOR_URL = "https://fac.test";
  process.env.PCC_X402_HMAC_KEY = HMAC;
}

// ---------------------------------------------------------------------------
// fetch mock: records every call, answers facilitator + upstream, and THROWS
// for any host we do not expect so no test can reach a real network.
// ---------------------------------------------------------------------------

const ALLOWED_HOSTS = new Set(["fac.test", "api.example.com"]);

function installFetchMock() {
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const host = new URL(url).host;
      if (!ALLOWED_HOSTS.has(host)) {
        throw new Error(`N67 test: unexpected outbound fetch to ${url}`);
      }
      if (url.endsWith("/verify")) {
        return new Response(JSON.stringify({ isValid: true, payer: PAYER }), {
          status: 200,
        });
      }
      if (url.endsWith("/settle")) {
        return new Response(
          JSON.stringify({
            success: true,
            transaction: "0x" + "ab".repeat(32),
            network: SEPOLIA.network,
            payer: PAYER,
          }),
          { status: 200 },
        );
      }
      // Upstream tool call.
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  );
  return spy;
}

/** Every URL the gateway tried to fetch (upstream + facilitator). */
function outboundUrls(spy: ReturnType<typeof installFetchMock>): string[] {
  return spy.mock.calls.map((c) => String(c[0]));
}

// ---------------------------------------------------------------------------
// Payment-signature builder (copied from aggregator-x402.test.ts)
// ---------------------------------------------------------------------------

function buildPaymentSignature(
  toolId: string,
  atomic: string,
  options: { network?: string; payTo?: string; asset?: string } = {},
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const validUntil = (nowSec + 300).toString();
  const network = options.network ?? SEPOLIA.network;
  const payTo = options.payTo ?? TREASURY;
  const tagFields: PriceTagFields = {
    toolId,
    amount: atomic,
    network,
    payTo,
    validUntil,
  };
  const tag = priceTagHmac(tagFields, HMAC);
  const reqs: X402PaymentRequirements = {
    scheme: "exact",
    network,
    amount: atomic,
    asset: options.asset ?? SEPOLIA.usdc,
    payTo,
    maxTimeoutSeconds: 300,
    extra: { priceTag: tag, validUntil, toolId },
  };
  const payload: X402PaymentPayload = {
    x402Version: 2,
    accepted: reqs,
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from: PAYER,
        to: payTo,
        value: atomic,
        validAfter: (nowSec - 60).toString(),
        validBefore: (nowSec + 240).toString(),
        nonce: "0x" + "fa".repeat(32),
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

// ---------------------------------------------------------------------------
// App helpers
// ---------------------------------------------------------------------------

const openApps: FastifyInstance[] = [];

async function boot(
  tools: IndexedTool[] = [makePaidTool()],
  opts: { logger?: FastifyBaseLogger } = {},
) {
  const reg = getAggregatorRegistry();
  for (const t of tools) reg.upsert(t);
  const fetchSpy = installFetchMock();
  const app = opts.logger ? Fastify({ logger: opts.logger }) : Fastify();
  openApps.push(app);
  await app.register(aggregatorRoutes);
  return { app, fetchSpy };
}

/**
 * A pino-shaped logger that records every `.error()` call, so a test can assert
 * on the structured log line without parsing stdout.
 */
function makeCapturingLogger() {
  const errors: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const logger = {
    level: "info",
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
    error: (obj: unknown, msg?: string) => {
      errors.push({ obj: obj as Record<string, unknown>, msg: msg ?? "" });
    },
    child: () => logger,
  };
  return { logger: logger as unknown as FastifyBaseLogger, errors };
}

/** console.error calls that are the one-per-process misconfiguration alert. */
function consoleAlerts(spy: MockInstance): unknown[][] {
  return spy.mock.calls.filter((c) =>
    String(c[0]).startsWith("[x402] MISCONFIGURED:"),
  );
}

function invoke(
  app: FastifyInstance,
  toolId = "paid-tool-1",
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/aggregator/invoke/${toolId}`,
    headers,
    payload: { args: {} },
  });
}

async function receiptsFor(app: FastifyInstance, toolId: string) {
  const res = await app.inject({
    method: "GET",
    url: `/api/aggregator/receipts/by-tool/${toolId}`,
  });
  return (res.json() as { receipts: unknown[] }).receipts;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("N67: aggregator x402 gate fails closed on misconfiguration", () => {
  /** Silences + records console.error (the alert's stderr line) for every test. */
  let errorSpy: MockInstance;

  beforeEach(() => {
    snapshotAndClearEnv();
    process.env.PCC_DB_PATH = ":memory:";
    sentryMock.captureMessage.mockReset();
    sentryMock.enabled.mockReset();
    sentryMock.enabled.mockReturnValue(true);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    _resetAggregatorRegistryForTests();
    initStore({ seed: false });
  });
  afterEach(async () => {
    for (const app of openApps.splice(0)) await app.close();
    closeStore();
    vi.restoreAllMocks();
    _resetAggregatorRegistryForTests();
    restoreEnv();
  });

  // -------------------------------------------------------------------------
  describe("PCC_X402_ENABLED=true with an unusable PCC_AGGREGATOR_TREASURY", () => {
    const BAD_TREASURIES: Array<{ label: string; value: EnvVal }> = [
      { label: "unset", value: UNSET },
      { label: "empty string", value: "" },
      { label: "whitespace only", value: "   " },
      { label: "malformed (0x123)", value: "0x123" },
      { label: "non-hex characters", value: "0x" + "zz".repeat(20) },
      { label: "missing 0x prefix", value: "1".repeat(40) },
      { label: "too long (42 hex chars)", value: "0x" + "11".repeat(21) },
      { label: "key-shaped (64 hex chars)", value: "0x" + "ab".repeat(32) },
      { label: "zero address", value: ZERO_ADDRESS },
    ];

    it.each(BAD_TREASURIES)(
      "treasury $label: paid tool -> 503 payment_gate_misconfigured, NO upstream call, NO settlement",
      async ({ label, value }) => {
        gateEnv({ treasury: value });
        const { app, fetchSpy } = await boot();

        const res = await invoke(app);

        // How the hole presents today: 200 = the paid call was served FREE
        // (gate switched itself off); 402 = a challenge naming a bad payee.
        const served =
          res.statusCode === 200
            ? "served FREE (the gate switched itself off)"
            : res.statusCode === 402
              ? `answered with a 402 challenge for payTo=${
                  (res.json() as { accepts?: Array<{ payTo?: string }> })
                    .accepts?.[0]?.payTo
                }`
              : `answered ${res.statusCode}`;
        expect(
          res.statusCode,
          `treasury ${label}: a paid tool must be refused with 503, but it was ${served}`,
        ).toBe(503);
        expect(res.json()).toEqual(REFUSAL_BODY);
        expect(
          res.headers["payment-required"],
          "a refusal is not a 402 payment challenge",
        ).toBeUndefined();
        expect(
          outboundUrls(fetchSpy),
          "no upstream call, no /verify, no /settle",
        ).toEqual([]);
        expect(
          await receiptsFor(app, "paid-tool-1"),
          "no receipt may be signed or persisted for a refused call",
        ).toEqual([]);
      },
    );

    it("a caller-supplied PAYMENT-SIGNATURE does not change the answer: 503, no /verify, no /settle, no upstream", async () => {
      gateEnv({ treasury: UNSET });
      const { app, fetchSpy } = await boot();
      const header = buildPaymentSignature(
        "paid-tool-1",
        toAtomicUsdc("0.01"),
      );

      const res = await invoke(app, "paid-tool-1", {
        "payment-signature": header,
      });

      expect(
        res.statusCode,
        `a paid call carrying a PAYMENT-SIGNATURE must still be refused when the treasury is unset (got ${res.statusCode})`,
      ).toBe(503);
      expect(res.json()).toEqual(REFUSAL_BODY);
      expect(outboundUrls(fetchSpy)).toEqual([]);
    });

    it.each([
      { label: "no pricing at all", tool: makeFreeTool() },
      { label: 'explicit price "0"', tool: makeZeroPriceTool() },
    ])(
      "FREE tool ($label) is still served while the gate is misconfigured (only paid calls are refused)",
      async ({ tool }) => {
        gateEnv({ treasury: UNSET });
        const { app, fetchSpy } = await boot([tool]);

        const res = await invoke(app, tool.id);

        expect(res.statusCode).toBe(200);
        expect(res.json().payment).toBeUndefined();
        const urls = outboundUrls(fetchSpy);
        expect(urls).toHaveLength(1);
        expect(urls[0]).toContain("api.example.com");
      },
    );
  });

  // -------------------------------------------------------------------------
  describe("PCC_X402_CHAIN set to an unknown value (valid treasury)", () => {
    const UNKNOWN_CHAINS: Array<{ label: string; value: string }> = [
      { label: "base-mainet (typo)", value: "base-mainet" },
      { label: "mainnet (missing prefix)", value: "mainnet" },
      { label: "base_mainnet (underscore)", value: "base_mainnet" },
      { label: "eip155:8453 (CAIP-2 instead of a name)", value: "eip155:8453" },
      { label: "ethereum", value: "ethereum" },
      { label: "empty string (set, but empty)", value: "" },
      { label: 'the literal string "undefined"', value: "undefined" },
      // Guard: a prototype key must not resolve through an object lookup.
      { label: "constructor (prototype key)", value: "constructor" },
    ];

    it.each(UNKNOWN_CHAINS)(
      "chain $label -> 503 payment_gate_misconfigured, never silently priced on testnet",
      async ({ label, value }) => {
        gateEnv({ chain: value });
        const { app, fetchSpy } = await boot();

        const res = await invoke(app);

        expect(
          res.statusCode,
          `chain ${label} must fail closed (got ${res.statusCode}${
            res.statusCode === 402
              ? `, a 402 challenge on ${
                  (res.json() as { accepts?: Array<{ network?: string }> })
                    .accepts?.[0]?.network
                }: silently fell back to testnet`
              : ""
          })`,
        ).toBe(503);
        expect(res.json()).toEqual(REFUSAL_BODY);
        expect(outboundUrls(fetchSpy)).toEqual([]);
        expect(await receiptsFor(app, "paid-tool-1")).toEqual([]);
      },
    );
  });

  // -------------------------------------------------------------------------
  describe("PCC_X402_CHAIN: the documented default and the known values keep working", () => {
    it("UNSET keeps the documented default (base-sepolia): 402 challenge on eip155:84532", async () => {
      gateEnv({ chain: UNSET });
      const { app } = await boot();

      const res = await invoke(app);

      expect(res.statusCode).toBe(402);
      const body = res.json();
      expect(body.accepts[0].network).toBe(SEPOLIA.network);
      expect(body.accepts[0].asset).toBe(SEPOLIA.usdc);
      expect(body.accepts[0].payTo).toBe(TREASURY);
    });

    it.each([
      { value: "base-sepolia", ...SEPOLIA },
      { value: "base-mainnet", ...MAINNET },
      { value: "base", ...MAINNET },
      { value: "Base-Mainnet", ...MAINNET },
      { value: "BASE-SEPOLIA", ...SEPOLIA },
    ])(
      "chain $value -> 402 challenge on $network",
      async ({ value, network, usdc }) => {
        gateEnv({ chain: value });
        const { app } = await boot();

        const res = await invoke(app);

        expect(res.statusCode).toBe(402);
        const body = res.json();
        expect(body.accepts[0].network).toBe(network);
        expect(body.accepts[0].asset).toBe(usdc);
        expect(body.accepts[0].payTo).toBe(TREASURY);
      },
    );
  });

  // -------------------------------------------------------------------------
  describe("controls: a gate that is OFF by configuration stays off", () => {
    it.each([
      { label: "unset", enabled: UNSET as EnvVal },
      { label: '"false"', enabled: "false" as EnvVal },
    ])(
      "PCC_X402_ENABLED $label -> paid tool served free, upstream called once, no facilitator call",
      async ({ enabled }) => {
        gateEnv({ enabled });
        const { app, fetchSpy } = await boot();

        const res = await invoke(app);

        expect(res.statusCode).toBe(200);
        expect(res.json().payment).toBeUndefined();
        const urls = outboundUrls(fetchSpy);
        expect(urls).toHaveLength(1);
        expect(urls[0]).toContain("api.example.com");
      },
    );

    it("PCC_X402_ENABLED unset ignores a malformed treasury and a typo'd chain: disabled means disabled, not misconfigured", async () => {
      gateEnv({
        enabled: UNSET,
        treasury: "0x123",
        chain: "base-mainet",
      });
      const { app } = await boot();

      const res = await invoke(app);

      expect(res.statusCode).toBe(200);
      expect(res.json().payment).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("controls: a valid configuration gives the normal paid flow", () => {
    it("PCC_X402_ENABLED=TRUE (any case) + valid config -> 402 challenge with the configured payee", async () => {
      gateEnv({ enabled: "TRUE" });
      const { app, fetchSpy } = await boot();

      const res = await invoke(app);

      expect(res.statusCode).toBe(402);
      expect(res.headers["payment-required"]).toBeTruthy();
      const body = res.json();
      expect(body.x402Version).toBe(2);
      expect(body.accepts[0].amount).toBe(toAtomicUsdc("0.01"));
      expect(body.accepts[0].payTo).toBe(TREASURY);
      expect(body.accepts[0].extra.priceTag).toMatch(/^[0-9a-f]{64}$/);
      // A challenge never reaches the upstream or the facilitator.
      expect(outboundUrls(fetchSpy)).toEqual([]);
    });

    it("valid config + valid payment -> 200, /verify + upstream + /settle each called exactly once", async () => {
      gateEnv();
      const { app, fetchSpy } = await boot();
      const header = buildPaymentSignature(
        "paid-tool-1",
        toAtomicUsdc("0.01"),
      );

      const res = await invoke(app, "paid-tool-1", {
        "payment-signature": header,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.payment.pricePaidUsdc).toBe("0.01");
      expect(body.payment.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      const urls = outboundUrls(fetchSpy);
      expect(urls.filter((u) => u.endsWith("/verify"))).toHaveLength(1);
      expect(urls.filter((u) => u.endsWith("/settle"))).toHaveLength(1);
      expect(urls.filter((u) => u.includes("api.example.com"))).toHaveLength(
        1,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("tri-state gate config", () => {
    it("getX402GateConfig() is undefined ONLY when PCC_X402_ENABLED is not 'true'", () => {
      // Not enabled (unset) -> undefined, whatever else is (mis)configured.
      gateEnv({ enabled: UNSET, treasury: "0x123", chain: "base-mainet" });
      expect(getX402GateConfig()).toBeUndefined();

      // Not enabled ("false") -> undefined.
      _resetAggregatorRegistryForTests();
      gateEnv({ enabled: "false" });
      expect(getX402GateConfig()).toBeUndefined();

      // Enabled + valid -> a usable, enabled gate config.
      _resetAggregatorRegistryForTests();
      gateEnv();
      const ok = getX402GateConfig();
      expect(ok).toBeDefined();
      expect(ok).toMatchObject({
        enabled: true,
        payTo: TREASURY,
        network: SEPOLIA.network,
      });

      // Enabled + unusable treasury -> must NOT look like "disabled", and must
      // not be mistakable for a usable gate config.
      _resetAggregatorRegistryForTests();
      gateEnv({ treasury: UNSET });
      const bad = getX402GateConfig();
      expect(
        bad,
        "an enabled gate with an unusable treasury must not collapse to undefined (= disabled)",
      ).not.toBeUndefined();
      expect(bad).not.toHaveProperty("payTo");
      expect(bad).not.toHaveProperty("enabled", true);

      // Enabled + unknown chain -> same.
      _resetAggregatorRegistryForTests();
      gateEnv({ chain: "base-mainet" });
      const badChain = getX402GateConfig();
      expect(
        badChain,
        "an enabled gate with an unknown chain must not collapse to undefined",
      ).not.toBeUndefined();
      expect(badChain).not.toHaveProperty("network");
    });

    it("a misconfigured result is not cached forever: fixing the env takes effect on the next request, no reset needed", async () => {
      gateEnv({ treasury: UNSET });
      const { app } = await boot();

      const refused = await invoke(app);
      expect(
        refused.statusCode,
        `step 1: a paid call with the treasury unset must be refused (got ${refused.statusCode})`,
      ).toBe(503);

      // Operator fixes the treasury.
      process.env.PCC_AGGREGATOR_TREASURY = TREASURY;

      const fixed = await invoke(app);
      expect(
        fixed.statusCode,
        "a later fix must not be hidden by a cached misconfigured result",
      ).toBe(402);
      expect(fixed.json().accepts[0].payTo).toBe(TREASURY);
    });

    it("isX402GateMisconfigured() is true ONLY for the fail-closed state", () => {
      // disabled -> undefined -> not misconfigured
      gateEnv({ enabled: UNSET });
      expect(isX402GateMisconfigured(getX402GateConfig())).toBe(false);

      // usable -> not misconfigured
      _resetAggregatorRegistryForTests();
      gateEnv();
      expect(isX402GateMisconfigured(getX402GateConfig())).toBe(false);

      // enabled + unusable treasury -> misconfigured
      _resetAggregatorRegistryForTests();
      gateEnv({ treasury: "0x123" });
      const bad = getX402GateConfig();
      expect(isX402GateMisconfigured(bad)).toBe(true);
      expect(bad).toMatchObject({ misconfigured: true });
    });

    it("reports EVERY problem at once, naming the env var and the problem class", () => {
      gateEnv({ treasury: UNSET, chain: "base-mainet" });
      const state = getX402GateConfig();
      if (!isX402GateMisconfigured(state)) throw new Error("expected misconfigured");
      expect(state.reasons).toHaveLength(2);
      const text = state.reasons.join("\n");
      expect(text).toContain("PCC_AGGREGATOR_TREASURY is not set");
      expect(text).toContain('PCC_X402_CHAIN="base-mainet" is not a known chain');
      expect(text).toContain("base-mainnet");
    });

    it.each([
      { value: UNSET as EnvVal, problem: "is not set" },
      { value: "" as EnvVal, problem: "is empty or blank" },
      { value: "   " as EnvVal, problem: "is empty or blank" },
      { value: "0x123" as EnvVal, problem: "is not a valid address" },
      { value: ZERO_ADDRESS as EnvVal, problem: "is the zero address" },
    ])(
      "treasury reason text distinguishes the problem class ($problem)",
      ({ value, problem }) => {
        gateEnv({ treasury: value });
        const state = getX402GateConfig();
        if (!isX402GateMisconfigured(state)) throw new Error("expected misconfigured");
        expect(state.reasons.join("\n")).toContain(
          `PCC_AGGREGATOR_TREASURY ${problem}`,
        );
      },
    );

    it("only quotes a short, benign chain value; a long or odd one is omitted from the reason", () => {
      const long = "x".repeat(100);
      gateEnv({ chain: long });
      const state = getX402GateConfig();
      if (!isX402GateMisconfigured(state)) throw new Error("expected misconfigured");
      const text = state.reasons.join("\n");
      expect(text).toContain("value omitted");
      expect(text).not.toContain(long);
    });

    it("a valid treasury is returned verbatim as payTo, in either case", () => {
      const mixed = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
      gateEnv({ treasury: mixed });
      expect(getX402GateConfig()).toMatchObject({ enabled: true, payTo: mixed });
    });
  });

  // -------------------------------------------------------------------------
  describe("alert: ONE per process, never silent, never breaks the request", () => {
    it("raises exactly one alert however many calls are refused, and none for free calls", async () => {
      gateEnv({ treasury: UNSET });
      const { app } = await boot([makePaidTool(), makeFreeTool()]);

      await invoke(app);
      await invoke(app);
      await invoke(app);
      await invoke(app, "free-tool-1");

      expect(consoleAlerts(errorSpy)).toHaveLength(1);
      expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1);
      const [message, context] = sentryMock.captureMessage.mock.calls[0] as [
        string,
        { level: string; tags: Record<string, string>; extra: { reasons: string[] } },
      ];
      expect(message).toContain("[x402] MISCONFIGURED:");
      expect(message).toContain("PCC_AGGREGATOR_TREASURY is not set");
      expect(message).toContain("503 payment_gate_misconfigured");
      expect(context.level).toBe("fatal");
      expect(context.tags).toMatchObject({
        service: "pcc-gateway",
        component: "x402-gate",
      });
      expect(context.extra.reasons).toEqual([
        expect.stringContaining("PCC_AGGREGATOR_TREASURY is not set"),
      ]);
    });

    it("is raised at BOOT (route registration), before any request, and not repeated by requests", async () => {
      gateEnv({ chain: "base-mainet" });
      const { app } = await boot();

      // No request has been made yet.
      expect(consoleAlerts(errorSpy)).toHaveLength(1);
      expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1);

      await invoke(app);
      await invoke(app);

      expect(consoleAlerts(errorSpy)).toHaveLength(1);
      expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1);
    });

    it("still alerts on stderr when Sentry is not active (no DSN): a money gate must not fail closed silently", async () => {
      sentryMock.enabled.mockReturnValue(false);
      gateEnv({ treasury: UNSET });
      const { app } = await boot();

      const res = await invoke(app);

      expect(res.statusCode).toBe(503);
      expect(sentryMock.captureMessage).not.toHaveBeenCalled();
      expect(consoleAlerts(errorSpy)).toHaveLength(1);
    });

    it("a failing alert channel never breaks request handling: the refusal is still a clean 503", async () => {
      sentryMock.captureMessage.mockImplementation(() => {
        throw new Error("sentry transport down");
      });
      gateEnv({ treasury: UNSET });
      const { app, fetchSpy } = await boot();

      const res = await invoke(app);

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual(REFUSAL_BODY);
      expect(outboundUrls(fetchSpy)).toEqual([]);
    });

    it("a gate that is OFF by configuration raises no alert, even with a bad treasury and chain", async () => {
      gateEnv({ enabled: UNSET, treasury: "0x123", chain: "base-mainet" });
      const { app } = await boot();

      await invoke(app);

      expect(consoleAlerts(errorSpy)).toHaveLength(0);
      expect(sentryMock.captureMessage).not.toHaveBeenCalled();
    });

    it("a valid gate raises no alert", async () => {
      gateEnv();
      const { app } = await boot();

      const res = await invoke(app);

      expect(res.statusCode).toBe(402);
      expect(consoleAlerts(errorSpy)).toHaveLength(0);
      expect(sentryMock.captureMessage).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("structured log: one error line per refused request", () => {
    it("logs code, toolId and reasons on EVERY refused paid call, prefixed [x402] MISCONFIGURED:", async () => {
      gateEnv({ treasury: ZERO_ADDRESS });
      const { logger, errors } = makeCapturingLogger();
      const { app } = await boot([makePaidTool()], { logger });

      await invoke(app);
      await invoke(app);
      await invoke(app);

      const refusals = errors.filter((e) => "toolId" in e.obj);
      expect(refusals).toHaveLength(3);
      for (const r of refusals) {
        expect(r.msg.startsWith("[x402] MISCONFIGURED:")).toBe(true);
        expect(r.obj).toMatchObject({
          code: "payment_gate_misconfigured",
          toolId: "paid-tool-1",
        });
        expect(JSON.stringify(r.obj.reasons)).toContain("zero address");
      }
    });

    it("also logs one structured line at boot, with no toolId", async () => {
      gateEnv({ treasury: UNSET });
      const { logger, errors } = makeCapturingLogger();
      await boot([makePaidTool()], { logger });

      const boots = errors.filter((e) => !("toolId" in e.obj));
      expect(boots).toHaveLength(1);
      expect(boots[0].obj).toMatchObject({ code: "payment_gate_misconfigured" });
      expect(boots[0].msg.startsWith("[x402] MISCONFIGURED:")).toBe(true);
    });

    it("does NOT log a refusal for a free tool served under a misconfigured gate", async () => {
      gateEnv({ treasury: UNSET });
      const { logger, errors } = makeCapturingLogger();
      const { app } = await boot([makeFreeTool()], { logger });

      const res = await invoke(app, "free-tool-1");

      expect(res.statusCode).toBe(200);
      expect(errors.filter((e) => "toolId" in e.obj)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("no raw value leaks: a key-shaped treasury is never echoed", () => {
    it("is absent from the response, the alert, the Sentry event and the log lines", async () => {
      // A pasted 32-byte private key is a realistic treasury typo. It is
      // synthetic here (repeating pattern), and must never be echoed anywhere.
      const keyShaped = "0x" + "ab".repeat(32);
      gateEnv({ treasury: keyShaped });
      const { logger, errors } = makeCapturingLogger();
      const { app } = await boot([makePaidTool()], { logger });

      const res = await invoke(app);

      expect(res.statusCode).toBe(503);
      const everything = JSON.stringify({
        body: res.body,
        headers: res.headers,
        console: errorSpy.mock.calls,
        sentry: sentryMock.captureMessage.mock.calls,
        logs: errors,
      });
      expect(everything).not.toContain("abababab");
      // ... but it must still be diagnosable.
      expect(everything).toContain("PCC_AGGREGATOR_TREASURY is not a valid address");
    });
  });
});
