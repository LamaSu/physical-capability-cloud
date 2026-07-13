/**
 * Unit tests for the OpenAPI operationId generator (../openapi/operation-id.ts).
 *
 * These test the pure `deriveOperationId` naming convention and the
 * `createOperationIdTransform` factory's dedup/collision behavior directly,
 * independent of any real route registration. See openapi-spec.test.ts for
 * the integration-level coverage against real, registered gateway routes.
 */

import { describe, it, expect } from "vitest";
import type { RouteOptions } from "fastify";
import { deriveOperationId, createOperationIdTransform } from "../openapi/operation-id.js";

/** Minimal fake RouteOptions — the transform only reads `.method`. */
function fakeRoute(method: string | string[]): RouteOptions {
  return { method, url: "/unused", handler: () => undefined } as unknown as RouteOptions;
}

describe("deriveOperationId", () => {
  it("derives the documented convention for a plain route", () => {
    expect(deriveOperationId("GET", "/api/capabilities/types")).toBe("get_api_capabilities_types");
  });

  it("derives the documented :param -> by_<param> convention", () => {
    expect(deriveOperationId("GET", "/api/capabilities/:id")).toBe("get_api_capabilities_by_id");
  });

  it("derives a slug for nested :params", () => {
    expect(deriveOperationId("PATCH", "/api/jobs/:jobId/status")).toBe("patch_api_jobs_by_jobid_status");
  });

  it("lowercases the method regardless of input casing", () => {
    expect(deriveOperationId("get", "/foo")).toBe("get_foo");
    expect(deriveOperationId("GeT", "/foo")).toBe("get_foo");
  });

  it("falls back to '<method>_root' for the bare root path", () => {
    expect(deriveOperationId("GET", "/")).toBe("get_root");
  });

  it("joins an array of methods when a route is registered for multiple verbs", () => {
    expect(deriveOperationId(["GET", "POST"], "/foo")).toBe("get_post_foo");
  });

  it("collapses wildcard segments to 'wildcard'", () => {
    expect(deriveOperationId("GET", "/static/*")).toBe("get_static_wildcard");
  });

  it("never produces an empty string", () => {
    expect(deriveOperationId("GET", "/").length).toBeGreaterThan(0);
    expect(deriveOperationId("GET", "").length).toBeGreaterThan(0);
  });

  it("is deterministic — same input always produces the same id", () => {
    const a = deriveOperationId("POST", "/api/build/contract");
    const b = deriveOperationId("POST", "/api/build/contract");
    expect(a).toBe(b);
  });
});

describe("createOperationIdTransform", () => {
  it("stamps a derived operationId onto a schema-less route", () => {
    const transform = createOperationIdTransform();
    const result = transform({ schema: {}, url: "/api/capabilities/types", route: fakeRoute("GET") });
    expect(result.schema.operationId).toBe("get_api_capabilities_types");
    expect(result.url).toBe("/api/capabilities/types");
  });

  it("preserves the original schema fields alongside the new operationId", () => {
    const transform = createOperationIdTransform();
    const result = transform({
      schema: { tags: ["discovery"], summary: "List types" },
      url: "/api/capabilities/types",
      route: fakeRoute("GET"),
    });
    expect(result.schema.tags).toEqual(["discovery"]);
    expect(result.schema.summary).toBe("List types");
    expect(result.schema.operationId).toBe("get_api_capabilities_types");
  });

  it("respects an explicit non-empty operationId a route already declares", () => {
    const transform = createOperationIdTransform();
    const result = transform({
      schema: { operationId: "listCapabilityTypes" },
      url: "/api/capabilities/types",
      route: fakeRoute("GET"),
    });
    expect(result.schema.operationId).toBe("listCapabilityTypes");
  });

  it("derives an id when the declared operationId is an empty/whitespace string", () => {
    const transform = createOperationIdTransform();
    const result = transform({
      schema: { operationId: "   " },
      url: "/api/capabilities/types",
      route: fakeRoute("GET"),
    });
    expect(result.schema.operationId).toBe("get_api_capabilities_types");
  });

  it("dedupes two routes that derive the same base id with a numeric suffix", () => {
    const transform = createOperationIdTransform();
    const first = transform({ schema: {}, url: "/api/foo", route: fakeRoute("GET") });
    const second = transform({ schema: {}, url: "/api/foo", route: fakeRoute("GET") });
    const third = transform({ schema: {}, url: "/api/foo", route: fakeRoute("GET") });

    expect(first.schema.operationId).toBe("get_api_foo");
    expect(second.schema.operationId).toBe("get_api_foo_2");
    expect(third.schema.operationId).toBe("get_api_foo_3");

    const ids = [first, second, third].map((r) => r.schema.operationId);
    expect(new Set(ids).size).toBe(3);
  });

  it("dedupes an explicit operationId that collides with a derived one", () => {
    const transform = createOperationIdTransform();
    const derived = transform({ schema: {}, url: "/api/foo", route: fakeRoute("GET") });
    const explicit = transform({
      schema: { operationId: "get_api_foo" },
      url: "/api/something-else",
      route: fakeRoute("POST"),
    });

    expect(derived.schema.operationId).toBe("get_api_foo");
    expect(explicit.schema.operationId).toBe("get_api_foo_2");
  });

  it("never produces an empty operationId across a batch of varied routes", () => {
    const transform = createOperationIdTransform();
    const urls: Array<[string, string]> = [
      ["GET", "/"],
      ["GET", "/api/kernels"],
      ["GET", "/api/kernels/:kernelId"],
      ["GET", "/api/kernels/:kernelId/devices"],
      ["POST", "/api/kernels"],
      ["GET", "/api/jobs/:jobId"],
      ["PATCH", "/api/jobs/:jobId/status"],
    ];
    const ids = urls.map(([method, url]) => transform({ schema: {}, url, route: fakeRoute(method) }).schema.operationId);
    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect((id as string).length).toBeGreaterThan(0);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps independent dedup state across separate factory instances", () => {
    const transformA = createOperationIdTransform();
    const transformB = createOperationIdTransform();

    const a1 = transformA({ schema: {}, url: "/api/foo", route: fakeRoute("GET") });
    const b1 = transformB({ schema: {}, url: "/api/foo", route: fakeRoute("GET") });

    // Both are the FIRST registration of "/api/foo" in their own transform's
    // dedup map, so neither should get a "_2" suffix from the other's state.
    expect(a1.schema.operationId).toBe("get_api_foo");
    expect(b1.schema.operationId).toBe("get_api_foo");
  });
});
