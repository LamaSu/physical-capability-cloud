/**
 * Canonical serialization and hashing for evidence events and bundles.
 *
 * Rules:
 * 1. JSON keys are sorted lexicographically at all depths.
 * 2. No whitespace.
 * 3. Numbers are not quoted.
 * 4. Null values are included; undefined values are omitted.
 * 5. SHA-256 of the canonical JSON produces the content hash.
 *
 * This ensures that identical data always produces the same hash,
 * regardless of key insertion order or formatting.
 */

import type { EvidenceEvent, EvidenceBundle } from "../types/evidence.js";
import type { SHA256 } from "../types/common.js";
import { ArrayIsArray, hasOwn, JSONStringify, listAt, ObjectKeys, sortedStrings, StringCtor } from "./primordials.js";

/**
 * Canonicalize any value to a deterministic JSON string.
 * Keys sorted lexicographically at all depths.
 *
 * It calls only intrinsics captured when `./primordials.ts` loads (astra pack
 * 170). A method or global replaced afterwards cannot change what it writes,
 * so it cannot make two different values serialize, and hash, alike. For JSON
 * data its output is byte-identical to the implementation it replaces
 * (`value.map(canonicalize).join(",")` and `Object.keys(value).sort()`
 * filtered and mapped), including the edge cases:
 *   - a hole in an array is written as nothing;
 *   - `undefined` in an array is written as null;
 *   - an object member whose value is undefined is omitted;
 *   - a number is written as String() writes it.
 * For a value that is not data, two things differ. An index or member is read
 * once, so a getter runs once, not twice. An array index is read only when it
 * is the array's own, never one a prototype serves.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return JSONStringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `${value}`;
  }
  if (ArrayIsArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ",";
      // `map` skips a hole, and `join` writes the hole as nothing. The read is the first thing the
      // guarded branch does, so nothing can remove the element between the check and the read.
      if (hasOwn(value, i)) {
        const item = value[i];
        out += canonicalize(item);
      }
    }
    return `${out}]`;
  }
  if (typeof value === "object") {
    const keys = sortedStrings(ObjectKeys(value as Record<string, unknown>));
    let out = "{";
    let first = true;
    for (let i = 0; i < keys.length; i++) {
      // The keys are the object's own (ObjectKeys), so this read never reaches its prototype (astra pack 291).
      const key = listAt(keys, i)!;
      const record = value as Record<string, unknown>;
      const member = hasOwn(record, key) ? record[key] : undefined;
      if (member === undefined) continue;
      out += `${first ? "" : ","}${JSONStringify(key)}:${canonicalize(member)}`;
      first = false;
    }
    return `${out}}`;
  }
  return StringCtor(value);
}

/**
 * Compute SHA-256 hash of a string.
 * Uses Web Crypto API (available in Node 18+ and browsers).
 */
export async function sha256(input: string): Promise<SHA256> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);

  // Use Web Crypto API
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  return `sha256:${hashHex}` as SHA256;
}

/**
 * Hash an evidence event.
 * Hashes the canonical JSON of: type + timestamp + source + payload.
 */
export async function hashEvent(
  event: Omit<EvidenceEvent, "hash" | "id">
): Promise<SHA256> {
  const hashInput = {
    type: event.type,
    timestamp: event.timestamp,
    source: event.source,
    payload: event.payload,
  };
  return sha256(canonicalize(hashInput));
}

/**
 * Hash an evidence bundle.
 * Hashes the sorted array of all event hashes.
 */
export async function hashBundle(
  events: EvidenceEvent[]
): Promise<SHA256> {
  const sortedHashes = events.map((e) => e.hash).sort();
  return sha256(canonicalize(sortedHashes));
}

/**
 * Verify that a bundle hash matches its events.
 */
export async function verifyBundleHash(
  bundle: EvidenceBundle
): Promise<boolean> {
  const computed = await hashBundle(bundle.events);
  return computed === bundle.bundleHash;
}

/**
 * Verify that an event hash matches its contents.
 */
export async function verifyEventHash(
  event: EvidenceEvent
): Promise<boolean> {
  const computed = await hashEvent(event);
  return computed === event.hash;
}
