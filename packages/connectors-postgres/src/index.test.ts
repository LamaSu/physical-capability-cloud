import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConnectorError,
  createPostgresSource,
  getPipelineStatus,
  runPipeline,
} from "./index.js";

const RUNTIME = "http://127.0.0.1:8766";

beforeEach(() => {
  // Force the default runtime URL for stable assertions.
  delete process.env.CONNECTORS_RUNTIME_URL;
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPostgresSource", () => {
  it("posts kind=postgres and returns the parsed body", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          source_id: "src_abc123",
          kind: "postgres",
          config_summary: { credentials: "<redacted>" },
          ready: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const out = await createPostgresSource({
      credentials: "postgresql://u:pw@host/db",
      table_names: ["users"],
    });
    expect(out.source_id).toBe("src_abc123");
    expect(out.ready).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${RUNTIME}/sources`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.kind).toBe("postgres");
    expect(body.config.credentials).toBe("postgresql://u:pw@host/db");
  });

  it("throws ConnectorError when runtime is unreachable", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(
      createPostgresSource({ credentials: "postgresql://u:pw@h/db" }),
    ).rejects.toMatchObject({
      name: "ConnectorError",
      status: null,
      message: expect.stringContaining("runtime_unreachable"),
    });
  });

  it("throws ConnectorError with status on non-2xx", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ detail: { error: "invalid_kind", message: "bad kind" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );

    try {
      await createPostgresSource({ credentials: "postgresql://u:pw@h/db" });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConnectorError);
      const ce = e as ConnectorError;
      expect(ce.status).toBe(400);
      expect(ce.detail).toMatchObject({ detail: { error: "invalid_kind" } });
    }
  });
});

describe("runPipeline / getPipelineStatus", () => {
  it("runPipeline POSTs run options", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ pipeline_id: "pl_x", run_id: "run_y", status: "running" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const out = await runPipeline("pl_x", { full_refresh: true });
    expect(out.run_id).toBe("run_y");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${RUNTIME}/pipelines/pl_x/run`);
    expect(JSON.parse(init.body)).toEqual({ full_refresh: true });
  });

  it("getPipelineStatus GETs and returns status snapshot", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          pipeline_id: "pl_x",
          name: "etl",
          status: "completed",
          last_run_id: "run_y",
          last_completed_at: 1.0,
          rows_loaded: 42,
          error: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const status = await getPipelineStatus("pl_x");
    expect(status.status).toBe("completed");
    expect(status.rows_loaded).toBe(42);
  });
});
