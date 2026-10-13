import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { normalizeUserCode, WalletLinkError } from "./repository.js";

const KEY_MATERIAL_FIELD = /^(private_?key|secret|mnemonic|seed(_?phrase)?)$/i;

/** Iterative traversal covers arrays and deeply nested JSON without recursion. */
export function containsKeyMaterial(body: unknown): boolean {
  const pending: unknown[] = [body];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    for (const [key, nested] of Object.entries(value)) {
      if (KEY_MATERIAL_FIELD.test(key)) return true;
      if (nested && typeof nested === "object") pending.push(nested);
    }
  }
  return false;
}

export function userCodesEqual(input: string, stored: string): boolean {
  const digest = (value: string) => createHash("sha256").update(normalizeUserCode(value), "utf8").digest();
  return timingSafeEqual(digest(input), digest(stored));
}

/** Only this coarse class reaches persistence or the consent renderer. */
export function requesterIpClass(ip: string): string {
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  if (isIP(ip) === 4) return `${ip.split(".").slice(0, 3).join(".")}.x`;
  if (isIP(ip) === 6) {
    ip = ip.split("%", 1)[0];
    const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const [left, right = ""] = normalized.split("::");
    const prefix = left ? left.split(":") : [];
    const suffix = right ? right.split(":") : [];
    const words = normalized.includes("::") ? [...prefix, ...Array(8 - prefix.length - suffix.length).fill("0"), ...suffix] : prefix;
    return `${words.slice(0, 3).map(word => word.padStart(4, "0")).join(":")}::/48`;
  }
  return "unknown";
}

/** In-memory counters are acceptable for v1; they reset when this process restarts. */
export function walletRequestLimits() {
  const wrongCodes = new Map<string, { count: number; until: number }>();
  const creates = new Map<string, { count: number; until: number }>();
  const polls = new Map<string, { last: number; until: number }>();
  const prune = (map: Map<string, { until: number }>, now: number) => {
    for (const [key, item] of map) if (item.until <= now) map.delete(key);
  };
  return {
    create(ip: string, now: number) {
      prune(creates, now);
      // Retain a one-way identifier for hourly accounting, never the full IP.
      const key = createHash("sha256").update(ip).digest("hex");
      const item = creates.get(key) ?? { count: 0, until: now + 3600000 };
      creates.set(key, item);
      if (++item.count > 10) throw new WalletLinkError(429, "rate_limited");
    },
    checkCodes(accountId: string, now: number) {
      prune(wrongCodes, now);
      if ((wrongCodes.get(accountId)?.count ?? 0) >= 5) throw new WalletLinkError(429, "too_many_attempts");
    },
    wrongCode(accountId: string, now: number) {
      prune(wrongCodes, now);
      const item = wrongCodes.get(accountId) ?? { count: 0, until: now + 600000 };
      item.count++;
      wrongCodes.set(accountId, item);
    },
    poll(id: string, expiresAt: string, now: number) {
      prune(polls, now);
      const previous = polls.get(id);
      polls.set(id, { last: now, until: Math.max(Date.parse(expiresAt), now + 5000) });
      return Boolean(previous && now - previous.last < 5000);
    },
  };
}
