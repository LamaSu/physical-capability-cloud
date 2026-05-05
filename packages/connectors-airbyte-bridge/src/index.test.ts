import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AirbyteError, getAirbyteJobStatus, triggerAirbyteJob } from "./index.js";

const AIRBYTE = "https://airbyte.example.com/api/v1";

beforeEach(() => {
  process.env.AIRBYTE_API_URL = AIRBYTE;
  process.env.AIRBYTE_API_KEY = "ab_test_key";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  delete process.env.AIRBYTE_API_URL;
  delete process.env.AIRBYTE_API_KEY;
  vi.unstubAllGlobals();
});

describe("triggerAirbyteJob", () => {
  it("posts connectionId and jobType=sync (default)", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jobId: "job-uuid-1",
          status: "running",
          jobType: "sync",
          connectionId: "conn-uuid-1",
          startTime: "2026-04-29T10:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const out = await triggerAirbyteJob("conn-uuid-1");
    expect(out.jobId).toBe("job-uuid-1");
    expect(out.status).toBe("running");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${AIRBYTE}/jobs`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer ab_test_key");
    const body = JSON.parse(init.body);
    expect(body).toEqual({ connectionId: "conn-uuid-1", jobType: "sync" });
  });

  it("throws AirbyteError 401 on auth failure", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message: "Bearer token rejected" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );

    try {
      await triggerAirbyteJob("conn-uuid-1");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AirbyteError);
      expect((e as AirbyteError).status).toBe(401);
      expect((e as AirbyteError).detail).toMatchObject({ message: "Bearer token rejected" });
    }
  });
});

describe("getAirbyteJobStatus", () => {
  it("GETs the job by id", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jobId: "job-uuid-1",
          status: "succeeded",
          jobType: "sync",
          connectionId: "conn-uuid-1",
          startTime: "2026-04-29T10:00:00Z",
          endTime: "2026-04-29T10:01:30Z",
          rowsSynced: 1234,
          bytesSynced: 56789,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const status = await getAirbyteJobStatus("job-uuid-1");
    expect(status.status).toBe("succeeded");
    expect(status.rowsSynced).toBe(1234);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${AIRBYTE}/jobs/job-uuid-1`);
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer ab_test_key");
  });

  it("throws AirbyteError 404 on missing job", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message: "job not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    );

    try {
      await getAirbyteJobStatus("missing-job");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AirbyteError);
      expect((e as AirbyteError).status).toBe(404);
    }
  });
});

describe("config errors", () => {
  it("throws airbyte_not_configured when AIRBYTE_API_URL is missing", async () => {
    delete process.env.AIRBYTE_API_URL;
    await expect(triggerAirbyteJob("c")).rejects.toMatchObject({
      name: "AirbyteError",
      status: null,
      message: expect.stringContaining("airbyte_not_configured"),
    });
  });

  it("throws airbyte_not_configured when AIRBYTE_API_KEY is missing", async () => {
    delete process.env.AIRBYTE_API_KEY;
    // URL exists, key missing -> the helper throws when building the auth header.
    await expect(triggerAirbyteJob("c")).rejects.toMatchObject({
      name: "AirbyteError",
      message: expect.stringContaining("airbyte_not_configured"),
    });
  });
});
