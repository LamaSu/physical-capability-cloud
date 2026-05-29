/**
 * did:web resolver — DNS-based DIDs.
 *
 * Format: did:web:<domain>[:<path-segment>...]
 *   e.g. did:web:example.com       -> https://example.com/.well-known/did.json
 *   e.g. did:web:example.com:users:alice -> https://example.com/users/alice/did.json
 *
 * Spec: https://w3c-ccg.github.io/did-method-web/
 */

import { parseDID } from "../did.js";
import {
  DIDResolutionError,
  type DIDDocument,
  type ParsedDID,
  type ResolverOptions,
} from "../types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Convert a did:web method-specific-id to a fetchable URL.
 *
 * Per spec:
 *  - The domain (and optional port) come first, percent-decoded.
 *  - `:` after the domain becomes `/` in the URL.
 *  - If no path segments follow the domain, append `/.well-known/did.json`.
 *  - Otherwise append `/did.json` to the path.
 */
export function didWebToUrl(methodSpecificId: string, did: string): string {
  if (!methodSpecificId || methodSpecificId.length === 0) {
    throw new DIDResolutionError("did:web requires a non-empty method-specific-id", did, "invalidDid");
  }

  // Split on `:` — first segment is the host, rest are path segments.
  const segments = methodSpecificId.split(":").map(decodeURIComponent);
  const host = segments[0];

  if (!host || host.length === 0) {
    throw new DIDResolutionError(`did:web has empty host: "${did}"`, did, "invalidDid");
  }

  // Reject obviously bogus host strings — must contain a dot OR be `localhost`.
  if (!host.includes(".") && host !== "localhost") {
    throw new DIDResolutionError(`did:web host "${host}" does not look like a valid domain`, did, "invalidDid");
  }

  const restPath = segments.slice(1);

  if (restPath.length === 0) {
    return `https://${host}/.well-known/did.json`;
  }
  return `https://${host}/${restPath.join("/")}/did.json`;
}

/**
 * Resolve a did:web DID by fetching the published DIDDocument.
 *
 * @throws DIDResolutionError on network error, 404, malformed JSON, or invalid document.
 */
export async function resolveWeb(parsed: ParsedDID, options: ResolverOptions = {}): Promise<DIDDocument> {
  if (parsed.method !== "web") {
    throw new DIDResolutionError(`Expected did:web, got did:${parsed.method}`, parsed.did, "methodNotSupported");
  }

  const url = didWebToUrl(parsed.methodSpecificId, parsed.did);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new DIDResolutionError(
      "did:web resolution requires fetch — provide options.fetchImpl or run in an environment with globalThis.fetch",
      parsed.did,
      "networkError",
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/did+json, application/json",
      },
      signal: controller.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DIDResolutionError(
      `did:web fetch failed for ${url}: ${message}`,
      parsed.did,
      "networkError",
    );
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new DIDResolutionError(
        `did:web document not found at ${url} (HTTP 404)`,
        parsed.did,
        "notFound",
      );
    }
    throw new DIDResolutionError(
      `did:web fetch returned HTTP ${response.status} for ${url}`,
      parsed.did,
      "networkError",
    );
  }

  let document: unknown;
  try {
    document = await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DIDResolutionError(
      `did:web document at ${url} is not valid JSON: ${message}`,
      parsed.did,
      "invalidDidDocument",
    );
  }

  validateDIDDocument(document, parsed.did);
  return document as DIDDocument;
}

function validateDIDDocument(doc: unknown, did: string): asserts doc is DIDDocument {
  if (!doc || typeof doc !== "object") {
    throw new DIDResolutionError(`did:web document must be a JSON object`, did, "invalidDidDocument");
  }
  const obj = doc as Record<string, unknown>;
  if (!obj["@context"]) {
    throw new DIDResolutionError(`did:web document missing @context`, did, "invalidDidDocument");
  }
  if (typeof obj.id !== "string") {
    throw new DIDResolutionError(`did:web document missing string id`, did, "invalidDidDocument");
  }
  if (obj.id !== did) {
    throw new DIDResolutionError(
      `did:web document id "${obj.id}" does not match requested DID "${did}"`,
      did,
      "invalidDidDocument",
    );
  }
}
