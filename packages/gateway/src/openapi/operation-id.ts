/**
 * Deterministic `operationId` generation for the gateway's OpenAPI 3.x spec.
 *
 * The gateway serves `/openapi.json` via `@fastify/swagger` (see
 * `../server.ts`), which historically left every operation's `operationId`
 * unset — every one of the ~700+ registered routes rendered with an empty
 * id. That blocks agent-native tooling (ChatGPT GPT Actions import,
 * OpenAPI-driven SDK generators, etc.) which require a stable, unique
 * `operationId` per operation.
 *
 * Rather than hand-annotate every route, `createOperationIdTransform()`
 * plugs into `@fastify/swagger`'s `transform` hook (called once per
 * registered route while the spec is built) and derives an id from the
 * route's HTTP method + URL pattern. It covers every current AND future
 * route automatically — no per-route opt-in required.
 */
import type { FastifySchema, RouteOptions } from "fastify";

/**
 * `@fastify/swagger` augments Fastify's `FastifySchema` with an optional
 * `operationId: string` field (see its `index.d.ts`). We restate that
 * locally so this module type-checks on its own, independent of whether
 * that ambient augmentation happens to be loaded elsewhere first.
 */
type SchemaWithOperationId = FastifySchema & { operationId?: string };

interface OperationIdTransformArgs {
  schema: SchemaWithOperationId;
  url: string;
  route: RouteOptions;
}

interface OperationIdTransformResult {
  schema: SchemaWithOperationId;
  url: string;
}

export type OperationIdTransform = (args: OperationIdTransformArgs) => OperationIdTransformResult;

/**
 * Derives a stable, readable OpenAPI `operationId` from an HTTP method and a
 * Fastify route URL pattern (e.g. "/api/capabilities/:id").
 *
 * Rules:
 *   - lower-cased `<method>_<path>` slug, path segments joined by "_"
 *   - named params (":id", ":jobId") -> "by_<name>"
 *   - wildcard params ("*", "*rest") -> "wildcard"
 *   - any other non-alphanumeric run collapses to a single "_"
 *   - the bare root path ("/") -> "<method>_root"
 *
 * Examples:
 *   deriveOperationId("GET",  "/api/capabilities/types") -> "get_api_capabilities_types"
 *   deriveOperationId("GET",  "/api/capabilities/:id")   -> "get_api_capabilities_by_id"
 *   deriveOperationId("POST", "/")                       -> "post_root"
 */
export function deriveOperationId(method: string | readonly string[], url: string): string {
  const methodSlug = Array.isArray(method)
    ? method.map((m) => String(m).toLowerCase()).join("_")
    : String(method).toLowerCase();

  const path = url
    // Fastify named params (":id", ":jobId") -> "by_<name>"
    .replace(/:([A-Za-z0-9_]+)/g, "by_$1")
    // Fastify wildcard params ("*" or a named "*rest") -> "wildcard"
    .replace(/\*[A-Za-z0-9_]*/g, "wildcard");

  const pathSlug = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return pathSlug ? `${methodSlug}_${pathSlug}` : `${methodSlug}_root`;
}

/**
 * Creates a fresh `@fastify/swagger` `transform` function that stamps a
 * stable, unique `operationId` onto every operation in the resulting
 * OpenAPI document — including routes that declare no explicit Fastify
 * `schema` at all, which is most of this gateway's routes.
 *
 * - A route that already declares an explicit, non-empty
 *   `schema.operationId` keeps it (still run through the same dedup map,
 *   so an explicit id can't silently collide with a derived one either).
 * - Everything else gets `deriveOperationId(method, url)`.
 * - Collisions (two operations deriving/declaring the same id) are
 *   resolved with a numeric suffix: "foo", "foo_2", "foo_3", ...
 *
 * Call this ONCE per `@fastify/swagger` registration (once in
 * `createGateway()`, once per test app that registers the plugin) — the
 * returned function closes over its own dedup map, so independent app
 * instances never interfere with each other's numbering.
 */
export function createOperationIdTransform(): OperationIdTransform {
  const seen = new Map<string, number>();

  function dedupe(id: string): string {
    const timesSeen = seen.get(id);
    if (timesSeen === undefined) {
      seen.set(id, 1);
      return id;
    }
    let suffix = timesSeen + 1;
    let candidate = `${id}_${suffix}`;
    while (seen.has(candidate)) {
      suffix += 1;
      candidate = `${id}_${suffix}`;
    }
    seen.set(id, suffix);
    seen.set(candidate, 1);
    return candidate;
  }

  return function operationIdTransform({ schema, url, route }) {
    const explicitId = schema?.operationId;
    const baseId = explicitId && explicitId.trim().length > 0 ? explicitId : deriveOperationId(route.method, url);

    return {
      schema: { ...schema, operationId: dedupe(baseId) },
      url,
    };
  };
}
