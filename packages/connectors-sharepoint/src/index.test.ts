import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConnectorError,
  createSharepointSource,
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

describe("createSharepointSource", () => {
  it("posts kind=sharepoint with site_url and libraries", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          source_id: "src_sp1",
          kind: "sharepoint",
          config_summary: { site_url: "https://acme.sharepoint.com/sites/finance", access_token: "<redacted>" },
          ready: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const out = await createSharepointSource({
      site_url: "https://acme.sharepoint.com/sites/finance",
      access_token: "EwBoA8...secret",
      libraries: ["Documents", "Reports"],
    });
    expect(out.source_id).toBe("src_sp1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${RUNTIME}/sources`);
    const body = JSON.parse(init.body);
    expect(body.kind).toBe("sharepoint");
    expect(body.config.libraries).toEqual(["Documents", "Reports"]);
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
      createSharepointSource({ site_url: "https://x", access_token: "y" }),
    ).rejects.toMatchObject({ status: 501, name: "ConnectorError" });
  });

  it("throws ConnectorError when runtime is unreachable", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(
      createSharepointSource({ site_url: "https://x", access_token: "y" }),
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

    const out = await runPipeline("pl_1", { full_refresh: false });
    expect(out.run_id).toBe("run_2");
  });

  it("getPipelineStatus returns the snapshot", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          pipeline_id: "pl_1",
          name: "sp_etl",
          status: "running",
          last_run_id: "run_2",
          last_completed_at: null,
          rows_loaded: null,
          error: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const status = await getPipelineStatus("pl_1");
    expect(status.status).toBe("running");
    expect(status.last_completed_at).toBeNull();
  });
});
