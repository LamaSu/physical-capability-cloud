/**
 * Express middleware adapter for @pcc/intent-collector.
 *
 * Usage:
 *
 *   import express from "express";
 *   import { IntentCollectorClient } from "@pcc/intent-collector";
 *   import { expressIntentMiddleware } from "@pcc/intent-collector/middleware/express";
 *
 *   const app = express();
 *   const client = new IntentCollectorClient();
 *   app.use(expressIntentMiddleware({ client }));
 *
 * What it does: hooks `res.send`/`res.json` so the URL the AGENT served is
 * checked against the URL pattern library. If it matches an intent-shape
 * pattern (e.g. a route the agent exposes that proxies a real-world purchase
 * via `/buy/amazon/...`), the envelope is captured.
 *
 * What it does NOT do: capture OUTBOUND requests the agent makes — that's
 * the job of `client.wrap(fetch)`. This middleware is for the symmetric
 * case where the agent surfaces its own endpoints whose URL shape mirrors
 * a known intent pattern.
 *
 * Express types are imported via `unknown`-style ducks to keep this package
 * free of `express` as a peer dependency. Callers that use Express already
 * have the types installed.
 */

import type { IntentCollectorClient } from "../client.js";
import { matchUrlPattern } from "../url-patterns.js";

// Minimal duck-typed Express shapes — avoids adding express as a dep.
interface ExpressReq {
  method: string;
  originalUrl?: string;
  url?: string;
  protocol?: string;
  body?: unknown;
  get?(name: string): string | undefined;
}
interface ExpressRes {
  send: (...args: unknown[]) => unknown;
  json?: (...args: unknown[]) => unknown;
}
type ExpressNext = (err?: unknown) => void;

export interface ExpressIntentMiddlewareOptions {
  client: IntentCollectorClient;
  /**
   * Override the URL used for pattern matching. Default reconstructs from
   * the request (`protocol://host/path`).
   */
  resolveUrl?: (req: ExpressReq) => string;
}

/**
 * Construct an Express middleware that captures intent envelopes when the
 * inbound request URL matches the pattern library.
 */
export function expressIntentMiddleware(
  opts: ExpressIntentMiddlewareOptions,
) {
  const { client, resolveUrl } = opts;
  return function intentMiddleware(
    req: ExpressReq,
    _res: ExpressRes,
    next: ExpressNext,
  ): void {
    try {
      const url =
        resolveUrl?.(req) ??
        defaultResolveUrl(req);
      const match = matchUrlPattern(url, req.body, req.method);
      if (match) {
        client.captureIntent(match.partial);
      }
    } catch {
      // Capture must never break the request path.
    }
    next();
  };
}

function defaultResolveUrl(req: ExpressReq): string {
  const proto = req.protocol ?? "http";
  const host = req.get?.("host") ?? "localhost";
  const path = req.originalUrl ?? req.url ?? "/";
  return `${proto}://${host}${path}`;
}
