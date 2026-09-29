/**
 * N46 (operator item 57, option a): the gateway pays on callers' behalf only
 * within hard caps (steward #3906: ship the caps and the breaker from master).
 *
 * In real settlement the gateway signer is the payer: committing a negotiated
 * session (commit, retry-settlement, submit-from-discovery, A2A pcc-submit)
 * makes it create and fund an escrow. Before this change, any authenticated key
 * could make the signer do that for any amount, with no cap, and the faucet and
 * relay signers had no throttle beyond a 1000 mUSDC per-call limit.
 *
 * Real settlement is exercised with viem's clients intercepted: every signer
 * write is RECORDED and then fails, so no test reaches a chain, and "the signer
 * was asked to pay" is observable. The file imports only modules that exist on
 * master before the fix. The guard's test reset is loaded dynamically, so every
 * [neg] case runs, and fails, against the old code.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { schema, eq } from "@pcc/store";

const signer = vi.hoisted(() => ({ writes: [] as string[] }));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      getTransactionCount: async () => 0,
      waitForTransactionReceipt: async () => {
        throw new Error("test: no chain");
      },
    }),
    createWalletClient: () => ({
      writeContract: async (req: { functionName?: string }) => {
        signer.writes.push(String(req.functionName));
        throw new Error("test: signer write intercepted");
      },
      sendTransaction: async () => {
        signer.writes.push("sendTransaction");
        throw new Error("test: signer write intercepted");
      },
    }),
  };
});

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest", metadataCid: "bafymeta" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafyenc", metadataCid: "bafyencmeta" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // Plain functions (not vi.fn) so no mock reset can change what they return.
  createEscrowV3: async () => {
    signer.writes.push("createEscrowV3");
    throw new Error("test: signer write intercepted");
  },
  resolveMockUSDCAddress: () => "0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb",
}));

vi.mock("../contracts/batch-settlement.js", () => ({
  isBatchEnabled: () => false,
  getSmartAccountAddress: () => null,
  submitSettlement: () => undefined,
  flushSettlements: async () => undefined,
  getQueueStatus: () => ({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: () => [],
  initBatchSettlement: async () => undefined,
  stopBatchSettlement: () => undefined,
}));

const { negotiationSessions } = schema;
const KERNEL = "kernel-biolab-01";
const CAP = "liquid-handler";

const ENV_KEYS = [
  "MOCK_SETTLEMENT",
  "PCC_GATEWAY_PRIVATE_KEY",
  "DEPLOYER_PRIVATE_KEY",
  "PCC_NETWORK",
  "PCC_GATEWAY_PAYS_ENABLED",
  "PCC_GATEWAY_PAYS_MAX_PER_ACTION_USD",
  "PCC_GATEWAY_PAYS_MAX_PER_PRINCIPAL_DAY_USD",
  "PCC_GATEWAY_PAYS_MAX_PER_KEY_DAY_USD",
  "PCC_GATEWAY_PAYS_MAX_GLOBAL_DAY_USD",
  "PCC_PGTR_FORWARDER_ADDRESS",
  "PCC_PGTR_RELAYER_KEY",
  "PCC_RELAY_MAX_PER_KEY_HOUR",
  "PCC_USE_V3_MODE_A",
] as const;
const savedEnv: Record<string, string | undefined> = {};

let app: FastifyInstance;
let getStore: typeof import("../db.js").getStore;
let provisionApiKey: typeof import("../auth/api-key-auth.js").provisionApiKey;
let seq = 0;
let ipSeq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

function keyFor(operatorId: string): string {
  return provisionApiKey({ operatorId, scopes: ["operator"] }).rawKey;
}

const call = (method: string, url: string, key: string, payload?: unknown) =>
  app.inject({
    method: method as never,
    url,
    remoteAddress: `10.46.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    headers: { authorization: `Bearer ${key}` },
    payload: payload as never,
  });

/** A session driven to "reviewing" (terms set), then priced at `amount` USD. */
async function reviewedSession(key: string, amount: string): Promise<string> {
  const created = await call("POST", "/api/negotiate/session", key, {
    userAgentId: uid("buyer"),
    kernelId: KERNEL,
    capabilityType: CAP,
  });
  expect(created.statusCode, created.body).toBe(200);
  const id = created.json().session.id as string;
  expect((await call("POST", `/api/negotiate/session/${id}/quote`, key)).statusCode).toBe(200);
  expect((await call("POST", `/api/negotiate/session/${id}/review`, key)).statusCode).toBe(200);
  const { db } = getStore();
  const row = db.select().from(negotiationSessions).where(eq(negotiationSessions.id, id)).get()!;
  const terms = row.contractTerms as { milestones: Array<Record<string, unknown>> };
  terms.milestones = terms.milestones.slice(0, 1).map((m) => ({ ...m, amount }));
  const quote = { ...(row.quote as Record<string, unknown>), totalPrice: amount };
  db.update(negotiationSessions)
    .set({ contractTerms: terms as never, quote: quote as never })
    .where(eq(negotiationSessions.id, id))
    .run();
  return id;
}

const statusOf = (id: string) =>
  getStore().db.select().from(negotiationSessions).where(eq(negotiationSessions.id, id)).get()?.status;

const commit = (id: string, key: string) => call("POST", `/api/negotiate/session/${id}/commit`, key);

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.PCC_DB_PATH = ":memory:";
  const db = await import("../db.js");
  db.initStore({ seed: true });
  getStore = db.getStore;
  ({ provisionApiKey } = await import("../auth/api-key-auth.js"));
  const { apiGate } = await import("../middleware/api-gate.js");
  const { paidJobFlowRoutes } = await import("../routes/paid-job-flow.js");
  const { negotiationRoutes } = await import("../routes/negotiation.js");
  const { a2aTasksRoutes } = await import("../routes/a2a-tasks.js");
  const { fiatRampRoutes } = await import("../routes/fiat-ramp.js");
  const { pgtrRelayRoutes } = await import("../routes/pgtr-relay.js");
  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  await app.register(a2aTasksRoutes);
  await app.register(fiatRampRoutes);
  await app.register(pgtrRelayRoutes);
  await app.ready();
});

beforeEach(async () => {
  signer.writes.length = 0;
  for (const k of ENV_KEYS) delete process.env[k];
  // Real settlement, a throwaway gateway key; every signer write is intercepted.
  process.env.MOCK_SETTLEMENT = "false";
  process.env.PCC_GATEWAY_PRIVATE_KEY = `0x${"11".repeat(32)}`;
  // The guard's test reset exists only after the fix; before it, there is no
  // guard. The path is built at runtime so the file also loads on the old code.
  const guardPath = ["..", "services", "gateway-spend-guard.js"].join("/");
  const guard = (await import(/* @vite-ignore */ guardPath).catch(() => null)) as
    | { __resetGatewaySpendGuardForTests?: () => void }
    | null;
  guard?.__resetGatewaySpendGuardForTests?.();
});

const spies: Array<{ mockRestore: () => void }> = [];
const quietConsoleError = () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  spies.push(spy);
  return spy;
};

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await app?.close();
  const { closeStore } = await import("../db.js");
  closeStore();
});

describe("N46: gateway-paid escrow funding is capped before the signer is asked", () => {
  it("[neg] a commit above the per-action cap ($25 on a testnet) is refused with 402; the session is untouched and the signer is never asked", async () => {
    const key = keyFor(uid("buyer-over-action") + "@x.test");
    const id = await reviewedSession(key, "1000.00");
    const res = await commit(id, key);
    expect(res.statusCode, res.body).toBe(402);
    expect(res.json().error).toBe("gateway_pay_over_action_cap");
    expect(statusOf(id)).toBe("reviewing");
    expect(signer.writes).toEqual([]);
  });

  it("[neg] one caller's gateway-paid total per UTC day is capped ($100): the commit that would pass it gets 429 and never reaches the signer", async () => {
    const key = keyFor(uid("buyer-daily") + "@x.test");
    for (let i = 0; i < 4; i += 1) {
      const id = await reviewedSession(key, "25.00");
      const res = await commit(id, key);
      // Admitted: the signer is asked (and the intercepted write fails, so 502).
      expect(res.statusCode, res.body).toBe(502);
    }
    const writesBefore = signer.writes.length;
    const fifth = await reviewedSession(key, "25.00");
    const res = await commit(fifth, key);
    expect(res.statusCode, res.body).toBe(429);
    expect(res.json().error).toBe("gateway_pay_principal_daily_cap");
    expect(statusOf(fifth)).toBe("reviewing");
    expect(signer.writes.length).toBe(writesBefore);
  });

  it("[neg] one API key's total per UTC day is capped separately (PCC_GATEWAY_PAYS_MAX_PER_KEY_DAY_USD)", async () => {
    process.env.PCC_GATEWAY_PAYS_MAX_PER_KEY_DAY_USD = "40";
    const key = keyFor(uid("buyer-key-cap") + "@x.test");
    expect((await commit(await reviewedSession(key, "25.00"), key)).statusCode).toBe(502);
    const res = await commit(await reviewedSession(key, "25.00"), key);
    expect(res.statusCode, res.body).toBe(429);
    expect(res.json().error).toBe("gateway_pay_key_daily_cap");
  });

  it("[neg] the global daily cap is a circuit breaker: 503 for every caller, and one alert", async () => {
    process.env.PCC_GATEWAY_PAYS_MAX_GLOBAL_DAY_USD = "60";
    const alerts = quietConsoleError();
    for (const who of ["gb-a", "gb-b"]) {
      const key = keyFor(uid(who) + "@x.test");
      expect((await commit(await reviewedSession(key, "25.00"), key)).statusCode).toBe(502);
    }
    const writesBefore = signer.writes.length;
    for (const who of ["gb-c", "gb-d"]) {
      const key = keyFor(uid(who) + "@x.test");
      const id = await reviewedSession(key, "25.00");
      const res = await commit(id, key);
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json().error).toBe("gateway_pays_daily_breaker");
      expect(statusOf(id)).toBe("reviewing");
    }
    expect(signer.writes.length).toBe(writesBefore);
    const breakerAlerts = alerts.mock.calls.filter((c) => String(c[0]).includes("global daily cap"));
    expect(breakerAlerts).toHaveLength(1);
  });

  it("[neg] the kill switch: PCC_GATEWAY_PAYS_ENABLED=false refuses with 503, and so does a mainnet network with the switch unset", async () => {
    const key = keyFor(uid("buyer-kill") + "@x.test");
    process.env.PCC_GATEWAY_PAYS_ENABLED = "false";
    const off = await commit(await reviewedSession(key, "5.00"), key);
    expect(off.statusCode, off.body).toBe(503);
    expect(off.json().error).toBe("gateway_pays_disabled");
    delete process.env.PCC_GATEWAY_PAYS_ENABLED;
    const id = await reviewedSession(key, "5.00");
    process.env.PCC_NETWORK = "base";
    const mainnet = await commit(id, key);
    expect(mainnet.statusCode, mainnet.body).toBe(503);
    expect(mainnet.json().error).toBe("gateway_pays_disabled");
    expect(signer.writes).toEqual([]);
  });

  it("[neg] a cap override that is not a number fails CLOSED (503), never open", async () => {
    process.env.PCC_GATEWAY_PAYS_MAX_PER_ACTION_USD = "twenty";
    quietConsoleError();
    const key = keyFor(uid("buyer-misconf") + "@x.test");
    const res = await commit(await reviewedSession(key, "5.00"), key);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error).toBe("gateway_pays_misconfigured");
    expect(signer.writes).toEqual([]);
  });

  it("[neg] a retry-settlement re-mint is a new gateway-paid funding and is capped too", async () => {
    const key = keyFor(uid("buyer-retry") + "@x.test");
    const id = await reviewedSession(key, "1000.00");
    // A pre-flight failure (no gateway key) leaves a retryable settlement_failed
    // row. The caps are raised for this setup commit only; it fails before any
    // signer call, so nothing is counted.
    const raised = [
      "PCC_GATEWAY_PAYS_MAX_PER_ACTION_USD",
      "PCC_GATEWAY_PAYS_MAX_PER_PRINCIPAL_DAY_USD",
      "PCC_GATEWAY_PAYS_MAX_PER_KEY_DAY_USD",
      "PCC_GATEWAY_PAYS_MAX_GLOBAL_DAY_USD",
    ];
    delete process.env.PCC_GATEWAY_PRIVATE_KEY;
    for (const k of raised) process.env[k] = "5000";
    expect((await commit(id, key)).statusCode).toBe(502);
    expect(statusOf(id)).toBe("settlement_failed");
    process.env.PCC_GATEWAY_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    for (const k of raised) delete process.env[k];
    signer.writes.length = 0;
    const res = await call("POST", `/api/negotiate/session/${id}/retry-settlement`, key);
    expect(res.statusCode, res.body).toBe(402);
    expect(res.json().error).toBe("gateway_pay_over_action_cap");
    expect(statusOf(id)).toBe("settlement_failed");
    expect(signer.writes).toEqual([]);
  });

  it("[neg] submit-from-discovery is capped before a session exists", async () => {
    process.env.PCC_GATEWAY_PAYS_MAX_PER_ACTION_USD = "0.01";
    const key = keyFor(uid("buyer-fasttrack") + "@x.test");
    const userAgentId = uid("fasttrack-agent");
    const res = await call("POST", "/api/jobs/submit-from-discovery", key, {
      kernelId: KERNEL,
      capabilityType: CAP,
      userAgentId,
    });
    expect(res.statusCode, res.body).toBe(402);
    expect(res.json().error).toBe("gateway_pay_over_action_cap");
    const rows = getStore().db.select().from(negotiationSessions).where(eq(negotiationSessions.userAgentId, userAgentId)).all();
    expect(rows).toEqual([]);
    expect(signer.writes).toEqual([]);
  });

  it("[neg] the A2A pcc-submit skill is capped: a JSON-RPC error carrying 402, nothing committed, the signer never asked", async () => {
    process.env.PCC_GATEWAY_PAYS_MAX_PER_ACTION_USD = "0.01";
    const key = keyFor(uid("buyer-a2a") + "@x.test");
    const userAgentId = uid("a2a-agent");
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: uid("rpc"),
        method: "tasks/send",
        params: { skill: "pcc-submit", params: { userAgentId, kernelId: KERNEL, capabilityType: CAP } },
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result, res.body).toBeUndefined();
    expect(res.json().error?.data?.status).toBe(402);
    expect(res.json().error?.data?.error).toBe("gateway_pay_over_action_cap");
    const rows = getStore().db.select().from(negotiationSessions).where(eq(negotiationSessions.userAgentId, userAgentId)).all();
    for (const r of rows) expect(r.status).not.toBe("committed");
    expect(signer.writes).toEqual([]);
  });

  it("control: a commit within every cap reaches the signer (the guard does not block legitimate spending)", async () => {
    const key = keyFor(uid("buyer-ok") + "@x.test");
    const res = await commit(await reviewedSession(key, "10.00"), key);
    expect(res.statusCode, res.body).toBe(502); // the intercepted write fails
    expect(signer.writes.length).toBeGreaterThan(0);
  });
});

describe("N46: the faucet and relay signers are throttled", () => {
  const wallet = () => `0x${(++seq).toString(16).padStart(40, "0")}`;

  it("[neg] a faucet drip above 100 mUSDC is refused (it was 1000)", async () => {
    const key = keyFor(uid("faucet-big") + "@x.test");
    const res = await call("POST", "/api/faucet/usdc", key, { walletAddress: wallet(), amount: 101 });
    expect(res.statusCode, res.body).toBe(400);
    expect(signer.writes).toEqual([]);
  });

  it("[neg] one wallet gets at most 500 mUSDC per UTC day", async () => {
    const to = wallet();
    for (let i = 0; i < 5; i += 1) {
      const key = keyFor(uid(`faucet-w${i}`) + "@x.test");
      expect((await call("POST", "/api/faucet/usdc", key, { walletAddress: to, amount: 100 })).statusCode).toBe(200);
    }
    const key = keyFor(uid("faucet-w5") + "@x.test");
    const res = await call("POST", "/api/faucet/usdc", key, { walletAddress: to, amount: 1 });
    expect(res.statusCode, res.body).toBe(429);
    expect(res.json().error).toBe("faucet_wallet_daily_cap");
  });

  it("[neg] one caller gets at most 5 faucet calls per hour", async () => {
    const key = keyFor(uid("faucet-rate") + "@x.test");
    for (let i = 0; i < 5; i += 1) {
      expect((await call("POST", "/api/faucet/usdc", key, { walletAddress: wallet(), amount: 1 })).statusCode).toBe(200);
    }
    const res = await call("POST", "/api/faucet/usdc", key, { walletAddress: wallet(), amount: 1 });
    expect(res.statusCode, res.body).toBe(429);
    expect(res.json().error).toBe("faucet_rate_limited");
  });

  it("[neg] the faucet is off on a mainnet deployment", async () => {
    process.env.PCC_NETWORK = "base";
    const key = keyFor(uid("faucet-mainnet") + "@x.test");
    const res = await call("POST", "/api/faucet/usdc", key, { walletAddress: wallet(), amount: 1 });
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error).toBe("faucet_disabled");
  });

  it("[neg] one caller's relays per hour are capped (PCC_RELAY_MAX_PER_KEY_HOUR); the refused relay never reaches the relayer key", async () => {
    process.env.PCC_PGTR_FORWARDER_ADDRESS = "0x000000000000000000000000000000000000f0f0";
    process.env.PCC_PGTR_RELAYER_KEY = `0x${"22".repeat(32)}`;
    process.env.PCC_RELAY_MAX_PER_KEY_HOUR = "2";
    const key = keyFor(uid("relay-rate") + "@x.test");
    const body = () => ({
      payer: "0x00000000000000000000000000000000000000aa",
      amount: "1",
      nonce: String(++seq),
      expiry: Math.floor(Date.now() / 1000) + 600,
      target: "0x00000000000000000000000000000000000000bb",
      selector: "0x12345678",
      callData: "0x",
      v: 27,
      r: `0x${"33".repeat(32)}`,
      s: `0x${"44".repeat(32)}`,
    });
    for (let i = 0; i < 2; i += 1) {
      const ok = await call("POST", "/api/pgtr/relay", key, body());
      expect(ok.statusCode, ok.body).not.toBe(429);
    }
    const writesBefore = signer.writes.length;
    const res = await call("POST", "/api/pgtr/relay", key, body());
    expect(res.statusCode, res.body).toBe(429);
    expect(res.json().error).toBe("relay_rate_limited");
    expect(signer.writes.length).toBe(writesBefore);
  });
});
