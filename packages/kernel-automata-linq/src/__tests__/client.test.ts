import { describe, it, expect, vi } from "vitest";
import { LinqClient, LinqAuthError } from "../client.js";

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("LinqClient", () => {
  it("sends Bearer apiKey", async () => {
    const fetchImpl = mockFetch(200, []);
    const client = new LinqClient({ apiKey: "k1", fetchImpl });
    await client.listWorkcells();
    const headers = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1]
      .headers;
    expect(headers.authorization).toBe("Bearer k1");
  });

  it("throws LinqAuthError on 401", async () => {
    const fetchImpl = mockFetch(401, { error: "bad key" });
    const client = new LinqClient({ apiKey: "k1", fetchImpl });
    await expect(client.listWorkcells()).rejects.toThrow(LinqAuthError);
  });

  it("listWorkcells returns parsed array", async () => {
    const fetchImpl = mockFetch(200, [
      { id: "wc-1", name: "Bench A", instrument_ids: ["i1"] },
    ]);
    const client = new LinqClient({ apiKey: "k1", fetchImpl });
    const wcs = await client.listWorkcells();
    expect(wcs).toHaveLength(1);
    expect(wcs[0].id).toBe("wc-1");
  });
});
