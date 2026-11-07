import { createHmac, randomBytes } from "node:crypto";

/** Correlation lasts for this process; no identity source or key leaves it. */
const IDENTITY_KEY = randomBytes(32);

export function analyticsIdentityDigest(value: string): string {
  return createHmac("sha256", IDENTITY_KEY).update(value).digest("hex").slice(0, 16);
}
