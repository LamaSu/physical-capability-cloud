import { timingSafeEqual } from "node:crypto";

/**
 * True only when PCC_ADMIN_KEY is set and `provided` (the X-Admin-Key header) equals it,
 * compared in constant time. There is no development bypass: an unset key grants
 * nothing, so a missing configuration can never open an admin read.
 */
export function hasValidAdminKey(provided: unknown, expected: string | undefined = process.env.PCC_ADMIN_KEY): boolean {
  if (typeof expected !== "string" || expected.length === 0 || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
