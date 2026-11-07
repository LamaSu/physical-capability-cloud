import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as config from "../services/wallet-links/config.js";

const MSG = "PCC_PUBLIC_URL must be set to this deployment's https public origin when NODE_ENV=production";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  for (const name of ["PCC_PUBLIC_URL", "PCC_GATEWAY_URL", "RAILWAY_ENVIRONMENT_NAME", "PCC_DEPLOYMENT_ENV"]) {
    vi.stubEnv(name, "");
    delete process.env[name];
  }
});
afterEach(() => vi.unstubAllEnvs());

describe("public origin boot configuration", () => {
  it.each([
    undefined, "", "not a url", "http://capability.network", "https://capability.network/app",
    "https://capability.network/?x=1", "https://capability.network/#f", "https://u:p@capability.network",
    "https://Capability.network", "https://capability.network:443",
  ])("T19 production refuses %s", value => {
    if (value !== undefined) vi.stubEnv("PCC_PUBLIC_URL", value);
    expect(() => config.assertPublicOriginConfigured()).toThrow(MSG);
  });

  it("T19 production refuses a gateway URL alone", () => {
    vi.stubEnv("PCC_GATEWAY_URL", "https://capability.network");
    expect(() => config.assertPublicOriginConfigured()).toThrow(MSG);
  });

  it.each(["https://capability.network", "https://capability.network/", "https://gw.example.test:8443"])(
    "T20 production accepts %s", value => {
      vi.stubEnv("PCC_PUBLIC_URL", value);
      expect(() => config.assertPublicOriginConfigured()).not.toThrow();
    },
  );

  it.each(["RAILWAY_ENVIRONMENT_NAME", "PCC_DEPLOYMENT_ENV"])("T21 deployed staging via %s still refuses an unset public origin", name => {
    vi.stubEnv(name, "staging");
    expect(() => config.assertPublicOriginConfigured()).toThrow(MSG);
  });

  it.each(["development", "test", undefined])("T23 non-deployed %s permits unset and invalid origins", environment => {
    if (environment === undefined) delete process.env.NODE_ENV;
    else vi.stubEnv("NODE_ENV", environment);
    expect(() => config.assertPublicOriginConfigured()).not.toThrow();
    vi.stubEnv("PCC_PUBLIC_URL", "not a url");
    expect(() => config.assertPublicOriginConfigured()).not.toThrow();
  });
});
