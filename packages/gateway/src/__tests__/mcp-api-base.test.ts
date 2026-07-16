import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PCC_PRODUCTION_ORIGIN,
  deploymentEnvName,
  resolveMcpApiBase,
  mcpApiBaseOrigin,
  mcpApiBaseUnavailableMessage,
} from "../mcp/mcp-api-base.js";

// Environment-isolation resolution for the /mcp proxy data plane
// (PCC_API_BASE_URL). SECURITY: the proxy forwards the caller's bearer to this
// origin and can WRITE there — it must be validated, environment-local, and
// fail-closed, with NO silent fallback to production.

const KEYS = ["NODE_ENV", "PCC_API_BASE_URL", "PCC_DEPLOYMENT_ENV", "RAILWAY_ENVIRONMENT_NAME", "PORT"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Put the process into a deployed environment with the given identity. */
function deploy(envName: "staging" | "production") {
  process.env.NODE_ENV = "production";
  process.env.RAILWAY_ENVIRONMENT_NAME = envName;
}

describe("resolveMcpApiBase — fail closed, no production fallback", () => {
  it("deployed + missing base → error (proxy disabled, NOT prod fallback)", () => {
    deploy("staging");
    const r = resolveMcpApiBase();
    expect("error" in r && r.error).toMatch(/not set/i);
    expect(mcpApiBaseOrigin()).toBeNull();
    expect(mcpApiBaseUnavailableMessage()).toMatch(/no silent fallback to production/i);
  });

  it("staging config pointing at PRODUCTION is REJECTED (environment isolation)", () => {
    deploy("staging");
    process.env.PCC_API_BASE_URL = PCC_PRODUCTION_ORIGIN;
    const r = resolveMcpApiBase();
    expect("error" in r && r.error).toMatch(/production origin.*staging.*isolation/i);
    expect(mcpApiBaseOrigin()).toBeNull();
  });

  it("production config = https://capability.network is ACCEPTED", () => {
    deploy("production");
    process.env.PCC_API_BASE_URL = PCC_PRODUCTION_ORIGIN;
    const r = resolveMcpApiBase();
    expect("origin" in r && r.origin).toBe(PCC_PRODUCTION_ORIGIN);
  });

  it("staging config = the staging origin is ACCEPTED", () => {
    deploy("staging");
    process.env.PCC_API_BASE_URL = "https://pcc-gateway-staging.up.railway.app";
    const r = resolveMcpApiBase();
    expect("origin" in r && r.origin).toBe("https://pcc-gateway-staging.up.railway.app");
  });
});

describe("origin normalization + validation", () => {
  it("trailing slash is normalized away", () => {
    deploy("staging");
    process.env.PCC_API_BASE_URL = "https://pcc-gateway-staging.up.railway.app/";
    expect(mcpApiBaseOrigin()).toBe("https://pcc-gateway-staging.up.railway.app");
  });
  it("non-https in a deployed environment is rejected", () => {
    deploy("staging");
    process.env.PCC_API_BASE_URL = "http://pcc-gateway-staging.up.railway.app";
    expect(mcpApiBaseUnavailableMessage()).toMatch(/https/i);
  });
  it("credentials in the URL are rejected", () => {
    deploy("staging");
    process.env.PCC_API_BASE_URL = "https://user:pass@pcc-gateway-staging.up.railway.app";
    expect(mcpApiBaseUnavailableMessage()).toMatch(/credential/i);
  });
  it("a query string or fragment is rejected", () => {
    deploy("staging");
    process.env.PCC_API_BASE_URL = "https://pcc-gateway-staging.up.railway.app?x=1";
    expect(mcpApiBaseUnavailableMessage()).toMatch(/query|fragment/i);
  });
  it("a path is rejected (must be a bare origin)", () => {
    deploy("staging");
    process.env.PCC_API_BASE_URL = "https://pcc-gateway-staging.up.railway.app/api";
    expect(mcpApiBaseUnavailableMessage()).toMatch(/bare origin|no path/i);
  });
  it("a non-URL value is rejected", () => {
    deploy("staging");
    process.env.PCC_API_BASE_URL = "not a url";
    expect(mcpApiBaseUnavailableMessage()).toMatch(/not a valid url/i);
  });
});

describe("off-deploy (local/test) convenience", () => {
  it("no NODE_ENV=production + no base → localhost default (http allowed)", () => {
    process.env.PORT = "3200";
    const r = resolveMcpApiBase();
    expect("origin" in r && r.origin).toBe("http://127.0.0.1:3200");
  });
  it("an explicit base wins off-deploy (http allowed)", () => {
    process.env.PCC_API_BASE_URL = "http://localhost:4000";
    expect(mcpApiBaseOrigin()).toBe("http://localhost:4000");
  });
});

describe("deploymentEnvName", () => {
  it("explicit PCC_DEPLOYMENT_ENV wins over Railway's", () => {
    process.env.PCC_DEPLOYMENT_ENV = "Staging";
    process.env.RAILWAY_ENVIRONMENT_NAME = "production";
    expect(deploymentEnvName()).toBe("staging");
  });
  it("falls back to RAILWAY_ENVIRONMENT_NAME", () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = "Production";
    expect(deploymentEnvName()).toBe("production");
  });
  it("null when neither is set", () => {
    expect(deploymentEnvName()).toBeNull();
  });
});
