import { describe, it, expect, vi } from "vitest";
import { MadsciClient } from "../client.js";

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("MadsciClient", () => {
  it("listNodes hits GET /nodes and returns the parsed body", async () => {
    const fetchImpl = mockFetch(200, [
      { node_id: "n1", module_type: "RestNode", url: "http://x", actions: ["a"] },
    ]);
    const client = new MadsciClient({
      baseUrl: "http://localhost:8005",
      fetchImpl,
    });
    const nodes = await client.listNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].node_id).toBe("n1");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:8005/nodes",
      expect.any(Object),
    );
  });

  it("runWorkflow POSTs to /workflows/run", async () => {
    const fetchImpl = mockFetch(200, { run_id: "run-42" });
    const client = new MadsciClient({
      baseUrl: "http://localhost:8005",
      fetchImpl,
    });
    const out = await client.runWorkflow({
      schema: "madsci/v1",
      name: "wf",
      steps: [{ name: "s", action: { node: "n", action: "a" } }],
    });
    expect(out.run_id).toBe("run-42");
    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].method).toBe("POST");
  });

  it("adds Authorization header when token is set", async () => {
    const fetchImpl = mockFetch(200, []);
    const client = new MadsciClient({
      baseUrl: "http://localhost:8005",
      fetchImpl,
      token: "abc",
    });
    await client.listNodes();
    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].headers.authorization).toBe("Bearer abc");
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = mockFetch(503, { error: "down" });
    const client = new MadsciClient({
      baseUrl: "http://localhost:8005",
      fetchImpl,
    });
    await expect(client.listNodes()).rejects.toThrow(/503/);
  });
});
