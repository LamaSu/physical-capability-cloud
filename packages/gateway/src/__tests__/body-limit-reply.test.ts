import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance | undefined;

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("WORKFLOW_DB_PATH", ":memory:");
  vi.stubEnv("PCC_SEED_DATA", "false");
  vi.stubEnv("COOKIE_SECRET", "pcc_live_test");
  const { createGateway } = await import("../server.js");
  app = (await createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();
}, 180000);

afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
});

function payloadOfSize(bytes: number): string {
  const prefix = '{"input":"a printer for small parts ';
  const suffix = '"}';
  return prefix + "x".repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix;
}

it("G1 an over-limit body gets 413", async () => {
  const payload = payloadOfSize(1_048_577);
  expect(Buffer.byteLength(payload)).toBe(1_048_577);
  const response = await app!.inject({
    method: "POST",
    url: "/api/capabilities/templates/match",
    headers: { "content-type": "application/json" },
    payload,
  });
  expect(response.statusCode).toBe(413);
  expect(JSON.parse(response.body)).toEqual({
    error: "payload_too_large",
    message: "Request body is too large",
  });
});

it("G2 a body at the limit gets 200", async () => {
  const payload = payloadOfSize(1_048_576);
  expect(Buffer.byteLength(payload)).toBe(1_048_576);
  const response = await app!.inject({
    method: "POST",
    url: "/api/capabilities/templates/match",
    headers: { "content-type": "application/json" },
    payload,
  });
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body).matches).toEqual(expect.any(Array));
});

it("G3 an over-limit wallet body keeps its 400 reply", async () => {
  const payload = payloadOfSize(1_048_577);
  expect(Buffer.byteLength(payload)).toBe(1_048_577);
  const response = await app!.inject({
    method: "POST",
    url: "/api/wallets/link-requests",
    headers: { "content-type": "application/json" },
    payload,
  });
  expect(response.statusCode).toBe(400);
  expect(JSON.parse(response.body)).toEqual({ error: "invalid_request" });
});

it("G4 a Content-Length larger than the body keeps its 400 reply", async () => {
  const payload = payloadOfSize(100);
  expect(Buffer.byteLength(payload)).toBe(100);
  const response = await app!.inject({
    method: "POST",
    url: "/api/capabilities/templates/match",
    headers: { "content-type": "application/json", "content-length": "110" },
    payload,
  });
  expect(response.statusCode).toBe(400);
  expect(JSON.parse(response.body)).toEqual({
    error: "invalid_request",
    message: "Request body size did not match Content-Length header",
  });
});

it("G4 a Content-Length smaller than the body keeps its 400 reply", async () => {
  const payload = payloadOfSize(100);
  expect(Buffer.byteLength(payload)).toBe(100);
  const response = await app!.inject({
    method: "POST",
    url: "/api/capabilities/templates/match",
    headers: { "content-type": "application/json", "content-length": "90" },
    payload,
  });
  expect(response.statusCode).toBe(400);
  expect(JSON.parse(response.body)).toEqual({
    error: "invalid_request",
    message: "Request body size did not match Content-Length header",
  });
});
