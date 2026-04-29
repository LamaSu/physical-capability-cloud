import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConnectorError,
  createSalesforceSource,
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

describe("createSalesforceSource", () => {
  it("posts kind=salesforce", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          source_id: "src_sf1",
          kind: "salesforce",
          config_summary: { instance_url: "https://acme.my.salesforce.com", access_token: "<redacted>" },
          ready: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const out = await createSalesforceSource({
      instance_url: "https://acme.my.salesforce.com",
      access_token: "00D...secret",
      objects: ["Account", "Opportunity"],
    });
    expect(out.source_id).toBe("src_sf1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${RUNTIME}/sources`);
    const body = JSON.parse(init.body);
    expect(body.kind).toBe("salesforce");
    expect(body.config.objects).toEqual(["Account", "Opportunity"]);
  });

  it("surfaces the runtime's 501 vendor_sdk_not_wired", async () => {
    // Until the v0.1 -> Wave 4 vendor wiring lands, salesforce source
    // creation 501s. The shell must propagate that as a ConnectorError
    // with status=501 so the orchestrator can route to a different
    // strategy (or surface a clear "Salesforce coming Q3" to the user).
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          detail: { error: "vendor_sdk_not_wired", message: "salesforce v0.1" },
        }),
        { status: 501, headers: { "Content-Type": "application/json" } },
      ),
    );

    try {
      await createSalesforceSource({
        instance_url: "https://acme.my.salesforce.com",
        access_token: "x",
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConnectorError);
      const ce = e as ConnectorError;
      expect(ce.status).toBe(501);
    }
  });

  it("throws ConnectorError when runtime is unreachable", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(
      createSalesforceSource({ instance_url: "https://x", access_token: "y" }),
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
          name: "sf_etl",
          status: "completed",
          last_run_id: "run_2",
          last_completed_at: 1.0,
          rows_loaded: 10,
          error: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const status = await getPipelineStatus("pl_1");
    expect(status.status).toBe("completed");
    expect(status.rows_loaded).toBe(10);
  });
});
