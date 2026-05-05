import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConnectorError,
  createSapSource,
  getPipelineStatus,
  runPipeline,
} from "./index.js";

const RUNTIME = "http://127.0.0.1:8766";

beforeEach(() => {
  delete process.env.CONNECTORS_RUNTIME_URL;
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSapSource", () => {
  it("posts kind=sap with credentials and entity_sets", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          source_id: "src_sap1",
          kind: "sap",
          config_summary: {
            base_url: "https://sap.acme.com/sap/opu/odata/sap/",
            username: "alice",
            password: "<redacted>",
          },
          ready: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const out = await createSapSource({
      base_url: "https://sap.acme.com/sap/opu/odata/sap/",
      username: "alice",
      password: "topsecret",
      entity_sets: ["MaterialSet", "VendorSet"],
    });
    expect(out.source_id).toBe("src_sap1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${RUNTIME}/sources`);
    const body = JSON.parse(init.body);
    expect(body.kind).toBe("sap");
    expect(body.config.password).toBe("topsecret");
    expect(body.config.entity_sets).toEqual(["MaterialSet", "VendorSet"]);
  });

  it("surfaces the runtime's 501 for vendor_sdk_not_wired", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ detail: { error: "vendor_sdk_not_wired" } }),
        { status: 501, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      createSapSource({ base_url: "https://x", username: "u", password: "p" }),
    ).rejects.toMatchObject({ status: 501, name: "ConnectorError" });
  });

  it("throws ConnectorError when runtime is unreachable", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(
      createSapSource({ base_url: "https://x", username: "u", password: "p" }),
    ).rejects.toMatchObject({ status: null, name: "ConnectorError" });
  });
});

describe("runPipeline / getPipelineStatus", () => {
  it("runPipeline POSTs run options", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ pipeline_id: "pl_1", run_id: "run_2", status: "running" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const out = await runPipeline("pl_1");
    expect(out.run_id).toBe("run_2");
  });

  it("getPipelineStatus returns the snapshot", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          pipeline_id: "pl_1",
          name: "sap_etl",
          status: "failed",
          last_run_id: "run_2",
          last_completed_at: 1.0,
          rows_loaded: 0,
          error: "auth_rejected",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const status = await getPipelineStatus("pl_1");
    expect(status.status).toBe("failed");
    expect(status.error).toBe("auth_rejected");
  });
});
