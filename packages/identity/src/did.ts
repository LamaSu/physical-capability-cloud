/**
 * DID URI parsing per W3C DID Core spec.
 *
 * Grammar (ABNF, simplified):
 *   did                = "did:" method-name ":" method-specific-id
 *   method-name        = 1*method-char
 *   method-char        = %x61-7A / DIGIT
 *   method-specific-id = *( *idchar ":" ) 1*idchar
 *   idchar             = ALPHA / DIGIT / "." / "-" / "_" / pct-encoded
 *
 * Ref: https://www.w3.org/TR/did-core/#did-syntax
 */

import { DIDResolutionError, type ParsedDID } from "./types.js";

/**
 * DID URI regex.
 * Captures: method-name, method-specific-id (with optional path/query/fragment).
 */
const DID_REGEX = /^did:([a-z0-9]+):([A-Za-z0-9.\-_:%]+?)(?:\/([^?#]*))?(?:\?([^#]*))?(?:#(.*))?$/;

/**
 * Parse a DID URI into its components.
 *
 * @throws DIDResolutionError if the URI is not a valid DID.
 */
export function parseDID(did: string): ParsedDID {
  if (typeof did !== "string" || did.length === 0) {
    throw new DIDResolutionError("DID must be a non-empty string", did ?? "", "invalidDid");
  }

  if (!did.startsWith("did:")) {
    throw new DIDResolutionError(`DID must start with "did:" — got "${did}"`, did, "invalidDid");
  }

  const match = DID_REGEX.exec(did);
  if (!match) {
    throw new DIDResolutionError(`DID does not match required syntax: "${did}"`, did, "invalidDid");
  }

  const [, method, methodSpecificId, path, query, fragment] = match;

  if (!method || !methodSpecificId) {
    throw new DIDResolutionError(`DID missing method or method-specific-id: "${did}"`, did, "invalidDid");
  }

  // Reconstruct the DID without path/query/fragment
  const cleanDid = `did:${method}:${methodSpecificId}`;

  const parsed: ParsedDID = {
    method,
    methodSpecificId,
    did: cleanDid,
  };

  if (path) parsed.path = path;
  if (query) parsed.query = query;
  if (fragment) parsed.fragment = fragment;

  return parsed;
}

/**
 * Quick boolean check — does this string look like a valid DID?
 */
export function isDID(value: string): boolean {
  try {
    parseDID(value);
    return true;
  } catch {
    return false;
  }
}
