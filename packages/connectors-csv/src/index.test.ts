import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConnectorError,
  createCsvSource,
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

describe("createCsvSource", () => {
  it("posts kind=csv with bucket_url and default glob", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          source_id: "src_csv1",
          kind: "csv",
          config_summary: { bucket_url: "/data/exports" },
          ready: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const out = await createCsvSource({ bucket_url: "/data/exports" });
    expect(out.source_id).toBe("src_csv1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${RUNTIME}/sources`);
    const body = JSON.parse(init.body);
    expect(body.kind).toBe("csv");
    expect(body.config.bucket_url).toBe("/data/exports");
  });

  it("posts kind=csv with custom file_glob", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          source_id: "src_csv2",
          kind: "csv",
          config_summary: { bucket_url: "/data", file_glob: "monthly_*.csv" },
          ready: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const out = await createCsvSource({
      bucket_url: "/data",
      file_glob: "monthly_*.csv",
    });
    expect(out.source_id).toBe("src_csv2");

    const body = JSON.parse((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.config.file_glob).toBe("monthly_*.csv");
  });

  it("throws ConnectorError when runtime is unreachable", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(
      createCsvSource({ bucket_url: "/x" }),
    ).rejects.toMatchObject({ status: null, name: "ConnectorError" });
  });

  it("propagates 400 invalid_kind from runtime", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ detail: { error: "invalid_kind" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );

    try {
      await createCsvSource({ bucket_url: "/x" });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConnectorError);
      expect((e as ConnectorError).status).toBe(400);
    }
  });
});

describe("runPipeline / getPipelineStatus", () => {
  it("getPipelineStatus returns the snapshot", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          pipeline_id: "pl_1",
          name: "csv_etl",
          status: "completed",
          last_run_id: "run_2",
          last_completed_at: 1.0,
          rows_loaded: 1234,
          error: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const status = await getPipelineStatus("pl_1");
    expect(status.status).toBe("completed");
    expect(status.rows_loaded).toBe(1234);
  });

  it("runPipeline POSTs run options including table_name", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ pipeline_id: "pl_1", run_id: "run_2", status: "running" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await runPipeline("pl_1", { table_name: "monthly_imports" });
    const body = JSON.parse((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.table_name).toBe("monthly_imports");
  });
});
