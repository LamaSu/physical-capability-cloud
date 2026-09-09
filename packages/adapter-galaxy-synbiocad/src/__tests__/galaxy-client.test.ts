import { describe, it, expect } from "vitest";

import { GalaxyRestClient } from "../index.js";

/** Build a `typeof fetch` stub that dispatches on `METHOD /path`. */
function stubFetch(
  handler: (method: string, path: string, body: unknown, url: URL) => { status?: number; json: unknown },
): typeof fetch {
  return (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const { status = 200, json } = handler(method, url.pathname, body, url);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("GalaxyRestClient", () => {
  it("reports health from /api/version", async () => {
    const client = new GalaxyRestClient({
      baseUrl: "https://galaxy.test",
      fetchImpl: stubFetch(() => ({ json: { version_major: "24.0" } })),
    });
    expect(await client.health()).toBe(true);
  });

  it("resolves a catalog short-id to the server's latest toolshed tool_id", async () => {
    const client = new GalaxyRestClient({
      baseUrl: "https://galaxy.test",
      fetchImpl: stubFetch((_method, path) => {
        if (path === "/api/tools")
          return {
            json: [
              { id: "toolshed.g2.bx.psu.edu/repos/tduigou/retropath2/retropath2/3.7.0+galaxy0" },
              { id: "toolshed.g2.bx.psu.edu/repos/tduigou/retropath2/retropath2/3.9.1+galaxy0" },
              { id: "__UNZIP_COLLECTION__" },
            ],
          };
        return { json: {} };
      }),
    });
    expect(await client.resolveServerToolId("retropath2")).toBe(
      "toolshed.g2.bx.psu.edu/repos/tduigou/retropath2/retropath2/3.9.1+galaxy0",
    );
    // unknown id falls back to itself (Galaxy then validates)
    expect(await client.resolveServerToolId("not_installed_here")).toBe("not_installed_here");
  });

  it("creates a history, encodes dotted params to '|', wraps datasets, maps outputs", async () => {
    let runBody: { tool_id?: string; history_id?: string; inputs?: Record<string, unknown> } = {};
    const client = new GalaxyRestClient({
      baseUrl: "https://galaxy.test",
      apiKey: "k",
      pollIntervalMs: 1,
      fetchImpl: stubFetch((method, path, body) => {
        if (method === "POST" && path === "/api/histories") return { json: { id: "hist-1" } };
        if (method === "POST" && path === "/api/tools") {
          runBody = body as typeof runBody;
          return {
            json: {
              outputs: [{ id: "ds-out", output_name: "Reaction_Network", extension: "csv" }],
              jobs: [{ id: "job-1" }],
            },
          };
        }
        if (method === "GET" && path === "/api/jobs/job-1") return { json: { state: "ok" } };
        return { json: {} };
      }),
    });

    const res = await client.runTool({
      toolId: "retropath2",
      params: { rulesfile: "ds-rules", source_inchi: "InChI=1S/CH4/h1H4", "adv.topx": 50 },
    });

    expect(res.state).toBe("ok");
    expect(res.historyId).toBe("hist-1");
    expect(res.outputs.Reaction_Network.datasetId).toBe("ds-out");
    expect(runBody.tool_id).toBe("retropath2");
    expect(runBody.history_id).toBe("hist-1");
    // dataset param wrapped; dotted section param flattened with "|"
    expect(runBody.inputs?.rulesfile).toEqual({ src: "hda", id: "ds-rules" });
    expect(runBody.inputs?.["adv|topx"]).toBe(50);
    expect(runBody.inputs?.source_inchi).toBe("InChI=1S/CH4/h1H4");
  });

  it("stages an inline dataset ref via /api/tools/fetch before running", async () => {
    const calls: string[] = [];
    const client = new GalaxyRestClient({
      baseUrl: "https://galaxy.test",
      apiKey: "k",
      pollIntervalMs: 1,
      fetchImpl: stubFetch((method, path, body) => {
        calls.push(`${method} ${path}`);
        if (path === "/api/histories") return { json: { id: "h" } };
        if (path === "/api/tools/fetch") return { json: { outputs: [{ id: "up-ds" }] } };
        if (path.startsWith("/api/histories/h/contents/")) return { json: { state: "ok" } };
        if (method === "POST" && path === "/api/tools") {
          expect((body as { inputs: Record<string, unknown> }).inputs.rulesfile).toEqual({
            src: "hda",
            id: "up-ds",
          });
          return { json: { outputs: [], jobs: [{ id: "j" }] } };
        }
        if (path === "/api/jobs/j") return { json: { state: "ok" } };
        return { json: {} };
      }),
    });

    const res = await client.runTool({
      toolId: "retropath2",
      params: { rulesfile: { src: "inline", content: "Name,InChI\n", ext: "csv" }, source_inchi: "x" },
    });

    expect(res.state).toBe("ok");
    expect(calls).toContain("POST /api/tools/fetch");
  });

  it("returns state 'error' when the job fails", async () => {
    const client = new GalaxyRestClient({
      baseUrl: "https://galaxy.test",
      pollIntervalMs: 1,
      fetchImpl: stubFetch((method, path) => {
        if (path === "/api/histories") return { json: { id: "h" } };
        if (path === "/api/tools") return { json: { outputs: [], jobs: [{ id: "j" }] } };
        if (path === "/api/jobs/j") return { json: { state: "error" } };
        return { json: {} };
      }),
    });
    const res = await client.runTool({
      toolId: "retropath2",
      params: { rulesfile: "ds", source_inchi: "x" },
    });
    expect(res.state).toBe("error");
  });
});
