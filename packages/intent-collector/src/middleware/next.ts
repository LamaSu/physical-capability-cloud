/**
 * Next.js middleware adapter for @pcc/intent-collector.
 *
 * Usage (Next.js App Router or Pages Router — middleware.ts at project root):
 *
 *   // middleware.ts
 *   import type { NextRequest } from "next/server";
 *   import { NextResponse } from "next/server";
 *   import { IntentCollectorClient } from "@pcc/intent-collector";
 *   import { nextIntentMiddleware } from "@pcc/intent-collector/middleware/next";
 *
 *   const client = new IntentCollectorClient();
 *   const capture = nextIntentMiddleware({ client });
 *
 *   export function middleware(req: NextRequest) {
 *     capture(req);
 *     return NextResponse.next();
 *   }
 *
 *   export const config = { matcher: "/(.*)" };
 *
 * The adapter is sync: it inspects the URL + method, fires capture, and
 * returns immediately. The caller is responsible for returning the
 * `NextResponse` (passthrough, redirect, etc.).
 *
 * `NextRequest` types are not imported directly — we duck-type them so
 * this package does not need `next` as a peer dependency.
 */

import type { IntentCollectorClient } from "../client.js";
import { matchUrlPattern } from "../url-patterns.js";

interface NextLikeRequest {
  method: string;
  url: string;
  /** Next 13+ exposes nextUrl with .href; older versions only `url`. */
  nextUrl?: { href: string } | undefined;
}

export interface NextIntentMiddlewareOptions {
  client: IntentCollectorClient;
}

/**
 * Construct a Next.js-compatible middleware capture function. Returns a
 * function the caller invokes from inside its own `middleware()` export.
 */
export function nextIntentMiddleware(
  opts: NextIntentMiddlewareOptions,
) {
  const { client } = opts;
  return function captureFromNextRequest(req: NextLikeRequest): void {
    try {
      const url = req.nextUrl?.href ?? req.url;
      if (!url) return;
      const match = matchUrlPattern(url, undefined, req.method);
      if (match) {
        client.captureIntent(match.partial);
      }
    } catch {
      // Capture must never break the request path.
    }
  };
}
