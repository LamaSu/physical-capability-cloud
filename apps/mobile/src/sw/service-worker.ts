/// <reference lib="webworker" />
/**
 * PCC Mobile Service Worker
 *
 * Scope: registered from the app shell at boot time.
 *
 * Responsibilities (Week 1 surface):
 * 1. Intercept fetch failures for evidence-push endpoints (POST /api/photo/upload,
 *    POST /api/issues, POST /api/photo/compare) and enqueue them via the offline
 *    queue. Page-side gets a synthetic 202-style response with `{queued:true,id}`.
 * 2. Drain the queue when network comes back online (or when the Background Sync
 *    API fires a `sync` event tagged `pcc-offline-flush`).
 * 3. Skip caching for everything else — Week 1 doesn't need a precache shell.
 *
 * Out of scope for Week 1 (deferred):
 * - Workbox runtime caching of GET /api/* responses
 * - Stale-while-revalidate for the dashboard shell
 * - Push notification handler (Week 3)
 */

import { backoffFor, drain, enqueue, MAX_ATTEMPTS } from "./offline-queue.js";
import type { QueuedRequest } from "./offline-queue.js";

declare const self: ServiceWorkerGlobalScope;

const QUEUEABLE_PATHS = [
  "/api/photo/upload",
  "/api/photo/compare",
  "/api/issues",
];

/**
 * Returns true if this URL/method should be intercepted for offline queueing
 * when the network is unreachable.
 */
export function shouldQueue(method: string, url: string): boolean {
  if (method !== "POST") return false;
  try {
    const u = new URL(url, "http://placeholder.local");
    return QUEUEABLE_PATHS.some((p) => u.pathname === p);
  } catch {
    return false;
  }
}

self.addEventListener("install", () => {
  // Take over immediately — no precache.
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event: FetchEvent) => {
  const req = event.request;
  if (!shouldQueue(req.method, req.url)) return;

  // Try the network first. On any error (offline, timeout, 5xx-class),
  // serialize the request and enqueue it.
  event.respondWith(handleQueueable(req));
});

async function handleQueueable(req: Request): Promise<Response> {
  const cloned = req.clone();
  try {
    const res = await fetch(req);
    if (res.status >= 500) throw new Error(`server-error-${res.status}`);
    return res;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    let bodyText: string | null = null;
    try {
      bodyText = await cloned.text();
    } catch {
      // Some request bodies (FormData, ReadableStream) aren't text-encodable.
      // For Week 1 we only queue JSON POSTs from the page; the dashboard's
      // upload endpoint sends `application/json` with the dataUrl in a
      // string field. Defensively fail-soft on non-text bodies.
      bodyText = null;
    }

    const headers: Record<string, string> = {};
    cloned.headers.forEach((value, key) => {
      // Strip Content-Length — the body will be re-serialized with idempotency
      // headers added.
      if (key.toLowerCase() === "content-length") return;
      headers[key] = value;
    });

    const id = await enqueue({
      method: req.method as "POST",
      url: req.url,
      headers,
      body: bodyText,
    });

    if ("registration" in self && "sync" in self.registration) {
      try {
        await (
          self.registration as ServiceWorkerRegistration & {
            sync?: { register: (tag: string) => Promise<void> };
          }
        ).sync?.register("pcc-offline-flush");
      } catch {
        // Background Sync not available; we'll fall back to the `online`
        // listener that the page-side helper sets up.
      }
    }

    return new Response(
      JSON.stringify({ queued: true, id, error: errMsg }),
      {
        status: 202,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

self.addEventListener("sync", (rawEvent) => {
  const event = rawEvent as ExtendableEvent & { tag?: string };
  if (event.tag !== "pcc-offline-flush") return;
  event.waitUntil(flushQueue());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "pcc-flush-queue") {
    event.waitUntil(flushQueue());
  }
});

async function flushQueue(): Promise<void> {
  await drain({
    executor: replayRequest,
    onAbandon: (req, reason) => {
      // Notify all clients so the dashboard can show a "this upload failed
      // permanently after N retries" UI.
      void notifyClients({
        type: "pcc-queue-abandoned",
        request: { url: req.url, attempts: req.attempts, reason },
      });
    },
  });
}

async function replayRequest(req: QueuedRequest): Promise<boolean> {
  const headers = { ...req.headers, "Idempotency-Key": req.idempotencyKey };
  // Honor backoff — we may be re-entering quickly via a `sync` event.
  const backoff = backoffFor(req.attempts);
  if (backoff > 0 && req.lastAttemptAt) {
    const elapsed = Date.now() - req.lastAttemptAt;
    if (elapsed < backoff) {
      // Not yet — leave for the next drain pass.
      return false;
    }
  }
  if (req.attempts >= MAX_ATTEMPTS) {
    // Defensive — drain() already handles this, but be explicit.
    return false;
  }
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers,
      body: req.body,
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function notifyClients(message: unknown): Promise<void> {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const c of clients) {
    c.postMessage(message);
  }
}

/**
 * Page-side helper: registers the SW and exposes pccMobile.queueSize() etc.
 * Imported separately by app-init code; not run in the SW context.
 */
export async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/service-worker.js", {
      scope: "/",
    });
  } catch (err) {
    // Registration failed — surface to console; the app still works without
    // the offline queue (just loses the retry behavior).
    console.warn("[pcc-mobile] service worker registration failed:", err);
  }
}
