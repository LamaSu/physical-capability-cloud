import { afterEach, describe, expect, it, vi } from "vitest";
import { walletRequest } from "../wallet/http.js";

afterEach(() => vi.restoreAllMocks());

describe("wallet HTTP transport", () => {
  it("refuses public HTTP before fetch even for a direct client call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await expect(walletRequest("http://pcc.example", "/x", "GET")).rejects.toThrow("insecure_gateway_origin");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it.each(["http://127.0.0.1:3200", "http://127.9.8.7", "http://[::1]:3200", "http://localhost:3200", "https://pcc.example"])("accepts secure or loopback origin %s", async (origin) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await expect(walletRequest(origin, "/x", "GET")).resolves.toEqual({});
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
