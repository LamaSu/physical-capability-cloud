/**
 * FC-8 round 5 (astra pack 61d, DO-NOT-SHIP at #326 @d8190fe3) — shared
 * dynamic fixtures for the three remaining reproductions: env-var canaries
 * (item 4), dependency canaries through the injected CHAIN client (item
 * 5), and FULL request capture with per-destination allowlists (item 6,
 * replacing fc8-round4-fakes.ts's printer-only capture).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeResponse, allEncodings, isPrinterBody, printedContentOf } from "./fc8-round4-fakes.js";

export { fakeResponse, allEncodings, isPrinterBody, printedContentOf };

/** A writable report path whose directory name EMBEDS `canary` — so if the path is ever printed (even just the dirname), the canary leaks through it, and the absence assertions catch it. */
export function canaryReportPath(canary: string): string {
  const safe = canary.replace(/[^a-zA-Z0-9]/g, "");
  const dir = mkdtempSync(join(tmpdir(), `fc8-r5-${safe}-`));
  return join(dir, "report.txt");
}

// ── Item 5: dependency canaries through the chain client ───────────────────
//
// Every prior round's fake chain client (fc8-round3-fakes.ts's
// makeFakeChain) returns FIXED, non-canary hex for tx hashes / addresses /
// topics. That means no prior dynamic test ever drove a REAL chain-
// returned hash/address through the script's print sites with a traceable
// value in it — only the HTTP/gateway/oracle side varied. This fixture
// returns the HEX ENCODING of `canary` as the tx hash, contract address,
// and receipt log topic/address — so a script that still interpolated any
// of these raw (or merely shape-checked them, round 3's safeLogHex) would
// leak the hex-encoded canary verbatim.

function hexEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("hex");
}

/** A 20-byte (40 hex char) address-shaped hex encoding of `canary`, padded/truncated to fit. */
function hexAddressOf(canary: string): string {
  const hex = hexEncode(canary);
  return "0x" + (hex.length >= 40 ? hex.slice(0, 40) : hex.padEnd(40, "0"));
}

/** A 32-byte (64 hex char) hash-shaped hex encoding of `canary`, padded/truncated to fit. */
function hexHashOf(canary: string): string {
  const hex = hexEncode(canary);
  return "0x" + (hex.length >= 64 ? hex.slice(0, 64) : hex.padEnd(64, "0"));
}

/**
 * A fake viem wallet+public client pair, same method surface as
 * fc8-round3-fakes.ts's makeFakeChain, but every hash/address IS the hex
 * encoding of `canary` — proving publicIdForLog (not a shape check) is
 * what stands between a chain-returned value and the script's output.
 */
export function makeFakeChainWithHexCanary(canary: string): { wallet: any; pub: any } {
  let nonce = 0;
  const TX_HASH = hexHashOf(canary);
  const CONTRACT_ADDR = hexAddressOf(canary);
  // topics[1] padded to 32 bytes so `"0x" + topics[1].slice(26)` yields the 20-byte address above.
  const ESCROW_TOPIC1 = "0x" + "0".repeat(24) + CONTRACT_ADDR.slice(2);

  const pub = {
    getBalance: async () => 1_000_000_000_000_000_000n,
    getTransactionCount: async () => nonce++,
    waitForTransactionReceipt: async ({ hash }: { hash: string }) => ({
      blockNumber: 12345n,
      gasUsed: 21000n,
      status: "success",
      contractAddress: CONTRACT_ADDR,
      logs: [{ topics: [TX_HASH, ESCROW_TOPIC1], address: CONTRACT_ADDR }],
      transactionHash: hash,
    }),
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "balanceOf": return 5_000_000n;
        case "funded": return true;
        case "getMilestoneCount": return 1n;
        case "totalAmount": return 1_000_000n;
        case "totalFeesCollectedByToken": return 100n;
        case "getEscrowCount": return 3n;
        default: return 0n;
      }
    },
  };
  const wallet = {
    deployContract: async () => TX_HASH,
    writeContract: async () => TX_HASH,
  };
  return { wallet, pub };
}

// ── FC-8 round 5b (steward ruling #6712) ───────────────────────────────────
//
// makeFakeChainWithHexCanary above always produces a SHAPE-VALID hex
// encoding (exactly 40 or 64 hex characters) — proving publicChainRef's
// verbatim path is reachable. This sibling fixture proves the shape GATE
// itself is load-bearing: every hash/address/topic value is deliberately
// the WRONG length (50 hex characters — neither address's 40 nor
// tx/topic's 64), so publicChainRef must reject every one of them as
// "(invalid)" and `canary`'s hex encoding must never appear anywhere this
// chain client's values reach, verbatim or otherwise.

/** A 50-hex-char (never 40, never 64) encoding of `canary`, padded/truncated to fit — deliberately the wrong shape for every PublicChainRefKind. */
function hexWrongLengthOf(canary: string): string {
  const hex = hexEncode(canary);
  return "0x" + (hex.length >= 50 ? hex.slice(0, 50) : hex.padEnd(50, "0"));
}

/**
 * Same shape as makeFakeChainWithHexCanary, but every tx hash / contract
 * address / receipt-log topic is the WRONG hex length — proving
 * publicChainRef's shape check, not merely "the function exists", is what
 * stands between a dependency-returned value and verbatim output.
 */
export function makeFakeChainWithInvalidHexCanary(canary: string): { wallet: any; pub: any } {
  let nonce = 0;
  const BAD = hexWrongLengthOf(canary);

  const pub = {
    getBalance: async () => 1_000_000_000_000_000_000n,
    getTransactionCount: async () => nonce++,
    waitForTransactionReceipt: async ({ hash }: { hash: string }) => ({
      blockNumber: 12345n,
      gasUsed: 21000n,
      status: "success",
      contractAddress: BAD,
      logs: [{ topics: [BAD, BAD], address: BAD }],
      transactionHash: hash,
    }),
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "balanceOf": return 5_000_000n;
        case "funded": return true;
        case "getMilestoneCount": return 1n;
        case "totalAmount": return 1_000_000n;
        case "totalFeesCollectedByToken": return 100n;
        case "getEscrowCount": return 3n;
        default: return 0n;
      }
    },
  };
  const wallet = {
    deployContract: async () => BAD,
    writeContract: async () => BAD,
  };
  return { wallet, pub };
}

// ── Item 6: full request capture with per-destination allowlists ───────────
//
// fc8-round4-fakes.ts's capture is PRINTER-only (isPrinterBody/
// printedContentOf discard everything else) — sound for "does the printer
// page leak", but its test titles claimed "any sent body", which it never
// checked. This wraps ANY fetch implementation to additionally record
// EVERY request — destination, method, a normalized path template, and
// the parsed body — so a per-destination allowlist can be asserted against
// the full set, not just the printer-bound subset.

export interface CapturedRequest {
  destination: "gateway" | "oracle" | "other";
  method: string;
  pathTemplate: string;
  body: unknown;
}

/** Classifies a request URL by which service it is bound for. */
export function classifyDestination(url: string): CapturedRequest["destination"] {
  if (url.includes("capability.network")) return "gateway";
  if (
    url.includes("trycloudflare.com") ||
    url.includes("fake-oracle.invalid") ||
    /:\/\/(localhost|127\.0\.0\.1):4100\b/.test(url)
  ) {
    return "oracle";
  }
  return "other";
}

/** A normalized path: any long or 0x-hex-shaped segment collapses to ":id", so the template is stable across different canaries/ids. */
function pathTemplateOf(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").map((seg) => (seg.length > 12 || /^0x[0-9a-fA-F]+$/.test(seg) ? ":id" : seg));
    return parts.join("/");
  } catch {
    return url;
  }
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** Wraps `inner` so every call is ALSO pushed to `out` as a CapturedRequest, before delegating to `inner` unchanged. */
export function captureRequests(inner: typeof fetch, out: CapturedRequest[]): typeof fetch {
  return (async (url: string | URL, opts?: any) => {
    const u = String(url);
    out.push({
      destination: classifyDestination(u),
      method: opts?.method ?? "GET",
      pathTemplate: pathTemplateOf(u),
      body: parseBody(opts?.body),
    });
    return inner(url, opts);
  }) as unknown as typeof fetch;
}

/** Every dot-path to a string leaf in `body` whose value contains `needle` (case-insensitive substring match, so an interpolated "prefix-CANARY-suffix" field is still caught). */
export function leafPathsContaining(body: unknown, needle: string, path: string[] = []): string[] {
  const hits: string[] = [];
  const n = needle.toLowerCase();
  if (typeof body === "string") {
    if (body.toLowerCase().includes(n)) hits.push(path.join(".") || "(root)");
    return hits;
  }
  if (Array.isArray(body)) {
    body.forEach((v, i) => hits.push(...leafPathsContaining(v, needle, [...path, String(i)])));
    return hits;
  }
  if (body && typeof body === "object") {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      hits.push(...leafPathsContaining(v, needle, [...path, k]));
    }
    return hits;
  }
  return hits;
}
