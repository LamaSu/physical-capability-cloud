import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// IMPORTANT: env must be set before the module imports — pcc-discovery.ts
// reads env at module load. We use vi.resetModules + dynamic import to apply.

const ORIGINAL_ENV = { ...process.env };

function setEnv(overrides: Record<string, string | undefined>) {
  process.env = { ...ORIGINAL_ENV, ...overrides };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

const sampleProfile = {
  enterprise_id: "ent-abc123def",
  name: "Oakland Titanium Mills",
  url: "https://example.com",
  city: "Oakland",
  capabilities: ["Ti-6Al-4V machining", "Inconel 718 turning", "5-axis mill-turn"],
  certifications: ["AS9100 Rev D"],
  agent_url: "https://guild.ai/agents/abc123",
  contact_email: "ops@example.com",
};

describe("publishOperator", () => {
  it("T1.8 — returns a deterministic mock ONLY when MOCK_PCC_DISCOVERY=true (explicit opt-in)", async () => {
    setEnv({ MOCK_PCC_DISCOVERY: "true", PCC_BASE_URL: "https://capability.network" });
    const { publishOperator } = await import("../pcc-discovery.js");
    const out = await publishOperator(sampleProfile);
    expect(out.registration_id).toContain("pcc-mock-reg-");
    expect(out.registration_id).toContain("ent-abc1");
    expect(out.discovery_url).toContain("/operators/");
    expect(out.dht_announced).toBe(true);
  });

  it("T1.8 — does NOT mock when MOCK_PCC_DISCOVERY is unset (default to real path)", async () => {
    setEnv({ MOCK_PCC_DISCOVERY: undefined, PCC_BASE_URL: "https://capability.network" });
    // Stub fetch so we can prove the real path was taken without hitting the
    // live network. If MOCK was still on by default, fetch would not be
    // reached.
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok", registration: { id: "real-path-reg" } }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { publishOperator } = await import("../pcc-discovery.js");
    const out = await publishOperator(sampleProfile);
    expect(fetchSpy).toHaveBeenCalled();
    expect(out.registration_id).toBe("real-path-reg");
    expect(out.registration_id).not.toContain("pcc-mock-reg-");
  });

  it("registers via /api/onboard/register when MOCK_PCC_DISCOVERY=false", async () => {
    setEnv({
      MOCK_PCC_DISCOVERY: "false",
      PCC_API_KEY: "",
      PCC_BASE_URL: "https://capability.network",
    });
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok", registration: { id: "reg-12345" } }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { publishOperator } = await import("../pcc-discovery.js");
    const out = await publishOperator(sampleProfile);

    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://capability.network/api/onboard/register");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    expect(body.name).toBe("Oakland Titanium Mills");
    expect(body.capabilities).toHaveLength(3);
    expect(body.capabilities[0]).toEqual({ id: "cap-0", type: "custom", name: "Ti-6Al-4V machining" });
    expect(body.operator.certifications).toEqual(["AS9100 Rev D"]);

    expect(out.registration_id).toBe("reg-12345");
    expect(out.discovery_url).toBe("https://capability.network/operators/reg-12345");
    expect(out.dht_announced).toBe(false);
    expect(out.dht_error).toContain("PCC_API_KEY not set");
  });

  it("also announces to DHT when PCC_API_KEY is set", async () => {
    setEnv({
      MOCK_PCC_DISCOVERY: "false",
      PCC_API_KEY: "pcc_live_test_key",
      PCC_BASE_URL: "https://capability.network",
    });

    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("/api/onboard/register")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "ok", registration: { id: "reg-xyz" } }),
          text: async () => "",
        };
      }
      if (url.includes("/api/dht/announce")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ announced: true }),
          text: async () => "",
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { publishOperator } = await import("../pcc-discovery.js");
    const out = await publishOperator(sampleProfile);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const dhtCall = fetchSpy.mock.calls.find(([u]: [string]) => u.includes("/api/dht/announce"));
    expect(dhtCall).toBeDefined();
    const [, dhtInit] = dhtCall!;
    expect(dhtInit.headers.Authorization).toBe("Bearer pcc_live_test_key");
    const dhtBody = JSON.parse(dhtInit.body);
    expect(dhtBody.kernelId).toBe("reg-xyz");
    expect(dhtBody.ttlSeconds).toBe(3600);
    expect(dhtBody.capabilities).toHaveLength(3);

    expect(out.dht_announced).toBe(true);
    expect(out.dht_error).toBeUndefined();
  });

  it("reports dht_error when DHT call fails but does not throw", async () => {
    setEnv({
      MOCK_PCC_DISCOVERY: "false",
      PCC_API_KEY: "pcc_live_test_key",
      PCC_BASE_URL: "https://capability.network",
    });
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("/api/onboard/register")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "ok", registration: { id: "reg-ok" } }),
          text: async () => "",
        };
      }
      if (url.includes("/api/dht/announce")) {
        return { ok: false, status: 401, json: async () => ({}), text: async () => "Unauthorized" };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { publishOperator } = await import("../pcc-discovery.js");
    const out = await publishOperator(sampleProfile);

    expect(out.registration_id).toBe("reg-ok");
    expect(out.dht_announced).toBe(false);
    expect(out.dht_error).toContain("HTTP 401");
  });

  it("throws when /api/onboard/register fails (registration is the canonical record)", async () => {
    setEnv({
      MOCK_PCC_DISCOVERY: "false",
      PCC_BASE_URL: "https://capability.network",
    });
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "Internal Server Error",
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { publishOperator } = await import("../pcc-discovery.js");
    await expect(publishOperator(sampleProfile)).rejects.toThrow(/PCC register failed: 500/);
  });
});

describe("searchCapabilities", () => {
  it("T1.8 — returns mock data ONLY when MOCK_PCC_DISCOVERY=true (explicit opt-in)", async () => {
    setEnv({ MOCK_PCC_DISCOVERY: "true" });
    const { searchCapabilities } = await import("../pcc-discovery.js");
    const out = await searchCapabilities("3d printing");
    expect(out.templates).toHaveLength(1);
    expect((out.templates[0] as { capabilityType: string }).capabilityType).toBe("fdm");
  });

  it("calls both /capabilities/templates and /capabilities/search in parallel", async () => {
    setEnv({ MOCK_PCC_DISCOVERY: "false", PCC_BASE_URL: "https://capability.network" });
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("/api/capabilities/templates")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ templates: [{ capabilityType: "fdm" }] }),
          text: async () => "",
        };
      }
      if (url.includes("/api/capabilities/search")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [{ id: "cap-1", name: "Match" }], total: 1 }),
          text: async () => "",
        };
      }
      throw new Error(`Unexpected: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { searchCapabilities } = await import("../pcc-discovery.js");
    const out = await searchCapabilities("titanium", { limit: 5 });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const calledUrls = fetchSpy.mock.calls.map(([u]: [string]) => u);
    expect(calledUrls.some((u) => u.includes("/api/capabilities/templates?query=titanium"))).toBe(true);
    expect(calledUrls.some((u) => u.includes("/api/capabilities/search?q=titanium&limit=5"))).toBe(true);
    expect(out.templates).toHaveLength(1);
    expect(out.items).toHaveLength(1);
  });

  it("propagates errors from the search endpoint", async () => {
    setEnv({ MOCK_PCC_DISCOVERY: "false", PCC_BASE_URL: "https://capability.network" });
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "down",
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const { searchCapabilities } = await import("../pcc-discovery.js");
    await expect(searchCapabilities("x")).rejects.toThrow(/PCC .*search failed: 503/);
  });
});
