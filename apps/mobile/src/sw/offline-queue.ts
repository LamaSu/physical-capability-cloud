/**
 * IndexedDB-backed offline queue for evidence-push requests when the phone
 * loses connectivity mid-job.
 *
 * The single biggest correctness gap in today's PWA (per researcher-hotel)
 * is that uploads error out the moment the phone loses signal. This module
 * is the page-side + service-worker-side helper that solves it.
 *
 * Storage shape (IndexedDB v1):
 *   db: pcc-mobile-offline-queue, version 1
 *   store: requests (autoIncrement key)
 *     {
 *       id: number,
 *       method: "POST" | "PUT" | "PATCH",
 *       url: string,
 *       headers: Record<string, string>,
 *       body: string | null,         // JSON-stringified
 *       idempotencyKey: string,      // uuid for safe retries
 *       createdAt: number,           // Date.now()
 *       attempts: number,            // 0 on enqueue
 *       lastAttemptAt: number | null,
 *       lastError: string | null,
 *     }
 *
 * Replay strategy: oldest-first, exponential backoff (1s, 2s, 4s, 8s,
 * capped at 60s), max 5 attempts, then surface to UI.
 */

const DB_NAME = "pcc-mobile-offline-queue";
const DB_VERSION = 1;
const STORE_NAME = "requests";

export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 60_000;

export interface QueuedRequest {
  id?: number;
  method: "POST" | "PUT" | "PATCH";
  url: string;
  headers: Record<string, string>;
  body: string | null;
  idempotencyKey: string;
  createdAt: number;
  attempts: number;
  lastAttemptAt: number | null;
  lastError: string | null;
}

export interface EnqueueInput {
  method: "POST" | "PUT" | "PATCH";
  url: string;
  headers?: Record<string, string>;
  body?: string | null;
  /** Optional override; will be auto-generated if absent. */
  idempotencyKey?: string;
}

/**
 * Returns the next backoff delay (in ms) for a request that has just
 * completed `attempts` attempts.
 */
export function backoffFor(attempts: number): number {
  if (attempts <= 0) return 0;
  const exp = BACKOFF_BASE_MS * Math.pow(2, attempts - 1);
  return Math.min(exp, BACKOFF_CAP_MS);
}

/**
 * Generates a UUIDv4-shaped string. Uses crypto.randomUUID where available,
 * falls back to Math.random for environments that lack it (some older
 * jsdom versions).
 */
export function newIdempotencyKey(): string {
  const c = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  // Fallback — not cryptographically random but fine for an idempotency key
  // because the server doesn't trust it for security, only for dedup.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Enqueue a request for retry. Returns the assigned id.
 */
export async function enqueue(input: EnqueueInput): Promise<number> {
  const db = await openDb();
  try {
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const record: Omit<QueuedRequest, "id"> = {
        method: input.method,
        url: input.url,
        headers: input.headers ?? {},
        body: input.body ?? null,
        idempotencyKey: input.idempotencyKey ?? newIdempotencyKey(),
        createdAt: Date.now(),
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
      };
      const addReq = store.add(record);
      addReq.onsuccess = () => resolve(addReq.result as number);
      addReq.onerror = () => reject(addReq.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Get all queued requests, oldest first (by createdAt).
 */
export async function listAll(): Promise<QueuedRequest[]> {
  const db = await openDb();
  try {
    return await new Promise<QueuedRequest[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (req.result as QueuedRequest[]).sort(
          (a, b) => a.createdAt - b.createdAt,
        );
        resolve(rows);
      };
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Returns the number of queued requests.
 */
export async function size(): Promise<number> {
  const db = await openDb();
  try {
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Remove a single request by id (typically because it succeeded or
 * exceeded MAX_ATTEMPTS).
 */
export async function dequeue(id: number): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Update attempts/error metadata for a request without removing it.
 */
export async function recordAttempt(
  id: number,
  outcome: { error: string | null; attemptedAt?: number },
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const row = getReq.result as QueuedRequest | undefined;
        if (!row) {
          resolve();
          return;
        }
        row.attempts = row.attempts + 1;
        row.lastAttemptAt = outcome.attemptedAt ?? Date.now();
        row.lastError = outcome.error;
        const putReq = store.put(row);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Clear the entire queue. Mostly useful for tests; production code should
 * dequeue individual items as they succeed.
 */
export async function clearAll(): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Drain the queue oldest-first, calling the supplied executor for each
 * request. The executor should return true if the replay succeeded
 * (the entry is then dequeued) or false if it failed (attempts is
 * incremented; if attempts >= MAX_ATTEMPTS the entry is dequeued and
 * surfaced to onAbandon).
 *
 * Returns the count of (succeeded, failedRetriable, abandoned).
 */
export async function drain(opts: {
  executor: (req: QueuedRequest) => Promise<boolean>;
  onAbandon?: (req: QueuedRequest, reason: string) => void;
}): Promise<{ succeeded: number; failedRetriable: number; abandoned: number }> {
  const queue = await listAll();
  let succeeded = 0;
  let failedRetriable = 0;
  let abandoned = 0;

  for (const req of queue) {
    if (req.id === undefined) continue;
    let ok = false;
    let errMsg: string | null = null;
    try {
      ok = await opts.executor(req);
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
    }
    if (ok) {
      await dequeue(req.id);
      succeeded += 1;
    } else {
      await recordAttempt(req.id, { error: errMsg });
      const next = req.attempts + 1;
      if (next >= MAX_ATTEMPTS) {
        await dequeue(req.id);
        abandoned += 1;
        opts.onAbandon?.(req, errMsg ?? "max-attempts");
      } else {
        failedRetriable += 1;
      }
    }
  }

  return { succeeded, failedRetriable, abandoned };
}
