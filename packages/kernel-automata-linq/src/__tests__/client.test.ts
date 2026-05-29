import { describe, it, expect, vi } from "vitest";
import { LinqClient, LinqAuthError } from "../client.js";

const BASE_OPTS = {
  apiDomain: "api.linq.automata.tech",
  auth0Domain: "automata-tech.eu.auth0.com",
  clientId: "cid-1",
  clientSecret: "csec-1",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Returns a fetch mock that responds based on URL:
 *  - any URL containing "/oauth/token" → token exchange
 *  - any other URL → API call (status/body provided)
 */
function makeFetch({
  tokenStatus = 200,
  tokenBody = {
    access_token: "tok-abc",
    expires_in: 3600,
    token_type: "Bearer",
  } as unknown,
  apiStatus = 200,
  apiBody = [] as unknown,
}: {
  tokenStatus?: number;
  tokenBody?: unknown;
  apiStatus?: number;
  apiBody?: unknown;
} = {}): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/oauth/token")) {
      return jsonResponse(tokenStatus, tokenBody);
    }
    return jsonResponse(apiStatus, apiBody);
  }) as unknown as typeof fetch;
}

describe("LinqClient auth", () => {
  it("exchanges client-credentials for an Auth0 token, then sends Bearer on API call", async () => {
    const fetchImpl = makeFetch({ apiBody: [] });
    const client = new LinqClient({ ...BASE_OPTS, fetchImpl });
    await client.get_workcells();

    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls).toHaveLength(2);

    // First call: Auth0 token exchange
    const [tokenUrl, tokenInit] = mock.mock.calls[0];
    expect(tokenUrl).toBe("https://automata-tech.eu.auth0.com/oauth/token");
    expect(tokenInit.method).toBe("POST");
    const tokenBody = JSON.parse(tokenInit.body);
    expect(tokenBody.grant_type).toBe("client_credentials");
    expect(tokenBody.client_id).toBe("cid-1");
    expect(tokenBody.client_secret).toBe("csec-1");
    expect(tokenBody.audience).toBe("https://api.linq.automata.tech/");

    // Second call: API with bearer
    const [apiUrl, apiInit] = mock.mock.calls[1];
    expect(apiUrl).toBe("https://api.linq.automata.tech/v1/workcells");
    expect(apiInit.headers.authorization).toBe("Bearer tok-abc");
  });

  it("caches the access token across calls within expiry", async () => {
    const fetchImpl = makeFetch({ apiBody: [] });
    const client = new LinqClient({ ...BASE_OPTS, fetchImpl });
    await client.get_workcells();
    await client.get_workcells();

    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const tokenCalls = mock.mock.calls.filter(([u]) =>
      String(u).includes("/oauth/token"),
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it("refreshes the token after expiry", async () => {
    const fetchImpl = makeFetch({
      tokenBody: {
        access_token: "tok-1",
        expires_in: 100,
        token_type: "Bearer",
      },
      apiBody: [],
    });
    let now = 1_000_000;
    const client = new LinqClient({
      ...BASE_OPTS,
      fetchImpl,
      now: () => now,
    });
    await client.get_workcells();
    // jump past expiry minus 60s buffer
    now += 100 * 1000;
    await client.get_workcells();

    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const tokenCalls = mock.mock.calls.filter(([u]) =>
      String(u).includes("/oauth/token"),
    );
    expect(tokenCalls).toHaveLength(2);
  });

  it("throws LinqAuthError(stage=token-exchange) on Auth0 failure", async () => {
    const fetchImpl = makeFetch({
      tokenStatus: 401,
      tokenBody: { error: "invalid_client" },
    });
    const client = new LinqClient({ ...BASE_OPTS, fetchImpl });
    await expect(client.get_workcells()).rejects.toMatchObject({
      name: "LinqAuthError",
      stage: "token-exchange",
    });
  });

  it("throws LinqAuthError(stage=api-call) on API 401", async () => {
    const fetchImpl = makeFetch({
      apiStatus: 401,
      apiBody: { error: "key revoked" },
    });
    const client = new LinqClient({ ...BASE_OPTS, fetchImpl });
    await expect(client.get_workcells()).rejects.toMatchObject({
      name: "LinqAuthError",
      stage: "api-call",
    });
  });
});

describe("LinqClient verb methods", () => {
  it("get_workcells parses array", async () => {
    const fetchImpl = makeFetch({
      apiBody: [{ id: "wc-1", name: "Bench A", instrument_ids: ["i1"] }],
    });
    const client = new LinqClient({ ...BASE_OPTS, fetchImpl });
    const wcs = await client.get_workcells();
    expect(wcs).toHaveLength(1);
    expect(wcs[0].id).toBe("wc-1");
  });

  it("get_workflows targets the workcell-scoped path when workcellId given", async () => {
    const fetchImpl = makeFetch({ apiBody: [] });
    const client = new LinqClient({ ...BASE_OPTS, fetchImpl });
    await client.get_workflows("wc-1");
    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const apiCall = mock.mock.calls.find(([u]) =>
      String(u).includes("/v1/workcells/wc-1/workflows"),
    );
    expect(apiCall).toBeDefined();
  });

  it("get_workflows hits the global path when no workcellId", async () => {
    const fetchImpl = makeFetch({ apiBody: [] });
    const client = new LinqClient({ ...BASE_OPTS, fetchImpl });
    await client.get_workflows();
    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const apiCall = mock.mock.calls.find(([u]) =>
      String(u).endsWith("/v1/workflows"),
    );
    expect(apiCall).toBeDefined();
  });

  it("start_workflow POSTs and parses LinqRun", async () => {
    const fetchImpl = makeFetch({
      apiBody: {
        id: "run-1",
        workflow_id: "wf-1",
        status: "queued",
      },
    });
    const client = new LinqClient({ ...BASE_OPTS, fetchImpl });
    const run = await client.start_workflow("wf-1");
    expect(run.id).toBe("run-1");
    expect(run.status).toBe("queued");

    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const apiCall = mock.mock.calls.find(([u]) =>
      String(u).includes("/v1/workflows/wf-1/start"),
    );
    expect(apiCall).toBeDefined();
    expect(apiCall![1].method).toBe("POST");
  });

  it("respond_to_error POSTs the response payload", async () => {
    const fetchImpl = makeFetch({
      apiBody: {
        id: "run-1",
        workflow_id: "wf-1",
        status: "running",
      },
    });
    const client = new LinqClient({ ...BASE_OPTS, fetchImpl });
    await client.respond_to_error("run-1", { action: "retry" });
    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const apiCall = mock.mock.calls.find(([u]) =>
      String(u).includes("/v1/runs/run-1/error-response"),
    );
    expect(apiCall).toBeDefined();
    expect(apiCall![1].method).toBe("POST");
    expect(JSON.parse(apiCall![1].body)).toEqual({ action: "retry" });
  });

  it("get_labwares parses LinqLabware array", async () => {
    const fetchImpl = makeFetch({
      apiBody: [{ id: "lw-1", type: "96-well-plate", position: "A1" }],
    });
    const client = new LinqClient({ ...BASE_OPTS, fetchImpl });
    const lws = await client.get_labwares();
    expect(lws).toHaveLength(1);
    expect(lws[0].id).toBe("lw-1");
  });

  it("get_run parses LinqRun", async () => {
    const fetchImpl = makeFetch({
      apiBody: {
        id: "run-1",
        workflow_id: "wf-1",
        status: "completed",
      },
    });
    const client = new LinqClient({ ...BASE_OPTS, fetchImpl });
    const run = await client.get_run("run-1");
    expect(run.status).toBe("completed");
  });
});
