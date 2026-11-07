import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gatewayPrincipal } from "../principal.js";

/** A stand-in for the gateway's GET /api/agent/me. */
const seen: Array<{ method: string | undefined; url: string | undefined; auth: string | undefined; keys: string[] }> = [];
let base = "";
let server: http.Server;

const ME = (operator: unknown, extra: Record<string, unknown> = {}) => ({ ok: true, identity: { operator, key_id: "key-1", scopes: ["*"] }, ...extra });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    seen.push({ method: req.method, url: req.url, auth, keys: Object.keys(req.headers).sort() });
    const send = (status: number, body: unknown, type = "application/json") => {
      res.statusCode = status;
      res.setHeader("content-type", type);
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    switch (auth) {
      case "Bearer pcc_live_OperatorOneKeyA":
      case "Bearer pcc_live_OperatorOneKeyB":
        return send(200, ME("operator-1"));
      case "Bearer pcc_live_OperatorTwoKey1":
        return send(200, ME("operator-2"));
      case "Bearer pcc_live_Slow00000000":
        return; // never answers
      case "Bearer pcc_live_ServerError01":
        return send(500, { ok: false });
      case "Bearer pcc_live_Status401Body1":
        return send(401, ME("operator-9")); // a refusal that still looks like an identity
      case "Bearer pcc_live_Status500Body1":
        return send(500, ME("operator-9"));
      case "Bearer pcc_live_HtmlAnswer001":
        return send(200, "<html>sign in</html>", "text/html");
      case "Bearer pcc_live_NotOkFlag0001":
        return send(200, { ok: false, identity: { operator: "operator-9" } });
      case "Bearer pcc_live_NoIdentity001":
        return send(200, { ok: true });
      case "Bearer pcc_live_EmptyOperator":
        return send(200, ME(""));
      case "Bearer pcc_live_NumericOper01":
        return send(200, ME(7));
      case "Bearer pcc_live_HugeOperator01":
        return send(200, ME("o".repeat(5_000)));
      case "Bearer pcc_live_NullBody00001":
        return send(200, "null");
      default:
        return send(401, { ok: false, error_kind: "no_token", message: "Send Authorization: Bearer pcc_live_<key>" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("who a credential belongs to (Q4-A)", () => {
  it("Q4-A: the operator id is the gateway's identity.operator: two keys of one operator are one principal, another operator is another", async () => {
    const who = gatewayPrincipal(base);
    const a = await who("pcc_live_OperatorOneKeyA");
    const b = await who("pcc_live_OperatorOneKeyB");
    const other = await who("pcc_live_OperatorTwoKey1");
    expect(a).toEqual({ operatorId: "operator-1" });
    expect(b).toEqual(a);
    expect(other).toEqual({ operatorId: "operator-2" });
  });

  it("Q4-A: it asks GET /api/agent/me, with the credential as a Bearer and nothing else", async () => {
    seen.length = 0;
    await gatewayPrincipal(base)("pcc_live_OperatorOneKeyA");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/api/agent/me", auth: "Bearer pcc_live_OperatorOneKeyA" });
    expect(seen[0]!.keys).not.toContain("cookie");
  });

  it.each([
    ["a key the gateway does not resolve (401)", "pcc_live_NotARealKey000"],
    ["a string the gateway never issued", "unissued-a"],
    ["a server error", "pcc_live_ServerError01"],
    ["a 401 whose body looks like an identity", "pcc_live_Status401Body1"],
    ["a 500 whose body looks like an identity", "pcc_live_Status500Body1"],
    ["an answer that is not JSON", "pcc_live_HtmlAnswer001"],
    ["an answer with ok false", "pcc_live_NotOkFlag0001"],
    ["an answer with no identity", "pcc_live_NoIdentity001"],
    ["an empty operator id", "pcc_live_EmptyOperator"],
    ["a non-string operator id", "pcc_live_NumericOper01"],
    ["an absurdly long operator id", "pcc_live_HugeOperator01"],
    ["a JSON null", "pcc_live_NullBody00001"],
  ])("Q4-A: %s is no principal", async (_name, credential) => {
    expect(await gatewayPrincipal(base)(credential)).toBeNull();
  });

  it("Q4-A: a gateway that does not answer in time is no principal", async () => {
    const started = Date.now();
    expect(await gatewayPrincipal(base, { timeoutMs: 100 })("pcc_live_Slow00000000")).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("Q4-A: a gateway that cannot be reached is no principal, and no error escapes", async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const dead = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(await gatewayPrincipal(dead)("pcc_live_OperatorOneKeyA")).toBeNull();
  });

  it("Q4-A: the resolver never throws, whatever the transport does", async () => {
    const throwing = gatewayPrincipal(base, { fetch: (async () => Promise.reject(new Error("boom pcc_live_X"))) as unknown as typeof fetch });
    expect(await throwing("pcc_live_OperatorOneKeyA")).toBeNull();
  });
});
