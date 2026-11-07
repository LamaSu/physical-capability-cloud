import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../middleware/security-hardening.js", () => ({ checkCallerRate: () => true }));

let app: FastifyInstance;
const raw = "password=N71-SENTINEL";

beforeAll(async () => {
  vi.stubEnv("DISCORD_WEBHOOK_URL", "https://example.invalid/notification");
  const { supportMessageRoutes } = await import("../routes/support-messages.js");
  app = Fastify({ logger: false });
  await app.register(supportMessageRoutes);
  await app.ready();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
});

describe("N71 r9 support notification diagnostics", () => {
  it("contains a dependency exception before console output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError(raw)));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await app.inject({
      method: "POST", url: "/api/operator/support",
      payload: { kernelId: "support-test-1", message: "Test notification" },
    });
    expect(result.statusCode).toBe(200);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Discord webhook error:", "TypeError"));
    expect(JSON.stringify(error.mock.calls)).not.toContain(raw);
  });

  it("bounds an unexpected response status before console output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: raw }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await app.inject({
      method: "POST", url: "/api/operator/support",
      payload: { kernelId: "support-test-2", message: "Test notification" },
    });
    expect(result.statusCode).toBe(200);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Discord webhook failed: null"));
    expect(JSON.stringify(error.mock.calls)).not.toContain(raw);
  });
});
