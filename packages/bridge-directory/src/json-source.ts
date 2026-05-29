/**
 * JSON source: fetch + parse + validate `bridges.json`.
 *
 * Phase 1 default backend for `@pcc/bridge-directory`. Hosted at
 * https://capability.network/bridges.json (Cloudflare CNAME -> Railway).
 */

import type { BridgeDirectory, GetDirectoryOptions } from "./types.js";
import { DEFAULT_JSON_URL } from "./types.js";
import { BridgeDirectorySchema, parseRegistries } from "./schema.js";

/**
 * Fetch and validate a bridge directory from a URL (or any string/Response
 * the supplied fetchImpl can return).
 *
 * Throws on:
 *   - HTTP error (non-2xx)
 *   - JSON parse failure
 *   - Zod validation failure (includes path info in the message)
 */
export async function fetchJsonDirectory(
  options: Pick<GetDirectoryOptions, "jsonUrl" | "fetchImpl"> = {},
): Promise<BridgeDirectory> {
  const url = options.jsonUrl ?? DEFAULT_JSON_URL;
  const f = options.fetchImpl ?? globalThis.fetch;
  if (typeof f !== "function") {
    throw new Error(
      "no fetch implementation available — pass options.fetchImpl",
    );
  }

  let res: Response;
  try {
    res = await f(url);
  } catch (e) {
    throw new Error(
      `bridge-directory: failed to fetch ${url} — ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `bridge-directory: ${url} returned HTTP ${res.status} ${res.statusText}`,
    );
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch (e) {
    throw new Error(
      `bridge-directory: ${url} did not return valid JSON — ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  return parseDirectoryJson(raw);
}

/** Validate an already-fetched JSON-like value. Pure (no I/O), so this is
 * what tests + CI call directly against bridges.json read off disk. */
export function parseDirectoryJson(raw: unknown): BridgeDirectory {
  const parsed = BridgeDirectorySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.errors
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `bridge-directory: schema validation failed\n${issues}`,
    );
  }

  // Coerce string-keyed registries to number-keyed runtime map. Zod
  // transforms can't do this on record() schemas cleanly, so we do it
  // explicitly here on the validated output.
  const out: BridgeDirectory = {
    ...parsed.data,
    bridges: parsed.data.bridges.map((b) => ({
      ...b,
      registries: parseRegistries(
        b.registries as Record<string, string> | undefined,
      ),
    })),
  };

  return out;
}
