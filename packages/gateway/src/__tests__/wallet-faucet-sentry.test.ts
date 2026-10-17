import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const sentry = vi.hoisted(() => {
  process.env.SENTRY_DSN = "https://abc123@example.invalid/1";
  return {
    options: undefined as Parameters<typeof import("@sentry/node").init>[0],
  };
});

// Keep the SDK and its processors real; only its outbound transport is fake.
vi.mock("@sentry/node", async original => {
  const real = await original<typeof import("@sentry/node")>();
  return {
    ...real,
    init: (options: Parameters<typeof real.init>[0]) => {
      sentry.options = options;
      return real.init({
        ...options,
        transport: () => ({
          send: async () => ({ statusCode: 200 }),
          flush: async () => true,
        }),
      });
    },
  };
});

import { initSentry, Sentry } from "../sentry.js";
import { walletFaucetRoutes } from "../routes/wallet-faucet.js";

const MARKER = "faucet-span-marker";
const templates = ["/api/wallets/link-requests/:id/fund", "/api/wallets/:linkId/fund"];
let app: FastifyInstance;
const registered: string[] = [];

beforeAll(async () => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("NODE_ENV", "staging");
  vi.stubEnv("PCC_DEPLOYMENT_ENV", "");
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "");
  for (const name of ["PCC_NETWORK", "CDP_NETWORK", "PCC_X402_CHAIN", "CDP_API_KEY_ID", "CDP_API_KEY_NAME", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"]) {
    vi.stubEnv(name, "");
    delete process.env[name];
  }
  initSentry();
  app = Fastify({ logger: false });
  app.addHook("onRoute", route => {
    if (route.method === "POST" && route.url.endsWith("/fund")) registered.push(route.url);
  });
  await app.register(walletFaucetRoutes, {
    client: { requestFaucet: vi.fn(async () => { throw new Error("unexpected_faucet_call"); }) },
    env: { PCC_FAUCET_CDP_API_KEY_ID: "dummy-faucet-id", PCC_FAUCET_CDP_API_KEY_SECRET: "dummy-faucet-secret" },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await Sentry.close();
  vi.unstubAllEnvs();
});

describe("wallet faucet Sentry route templates", () => {
  it("T19 keeps exactly the registered fund templates and drops every request value", () => {
    expect(registered.sort()).toEqual([...templates].sort());
    for (const route of registered) {
      const span = {
        description: MARKER,
        data: {
          "http.route": route,
          "url.full": `https://capability.network/api/wallets/${MARKER}/fund`,
          "http.target": `/api/wallets/${MARKER}/fund`,
          "http.request.header.authorization": MARKER,
        },
      };
      const scrubbed = sentry.options!.beforeSendSpan!(span as never);
      expect(scrubbed).toEqual({ description: route, data: {} });
      expect(JSON.stringify(scrubbed)).not.toContain(MARKER);
    }
  });

  it("T20 redacts a near-match fund template", () => {
    expect(sentry.options!.beforeSendSpan!({
      description: MARKER,
      data: { "http.route": "/api/wallets/:linkId/fund/extra", "url.full": MARKER },
    } as never)).toEqual({ description: "/api/wallets/<redacted>", data: {} });
  });
});
