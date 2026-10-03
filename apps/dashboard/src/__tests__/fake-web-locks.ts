/**
 * navigator.locks for jsdom, which has no Web Locks API: exclusive locks,
 * granted in request order, and a request's `signal` withdraws it while it
 * waits. Installed on the window, so every module instance in a test shares
 * it, as every tab of an origin shares the browser's lock manager.
 */
export function installFakeWebLocks(): void {
  const queues = new Map<string, Array<() => void>>();
  const held = new Set<string>();

  const acquire = (name: string, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      if (!held.has(name)) {
        held.add(name);
        return resolve();
      }
      const queue = queues.get(name) ?? [];
      const grant = () => {
        signal?.removeEventListener("abort", withdraw);
        resolve();
      };
      const withdraw = () => {
        const at = queue.indexOf(grant);
        if (at >= 0) queue.splice(at, 1);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", withdraw, { once: true });
      queue.push(grant);
      queues.set(name, queue);
    });

  const release = (name: string) => {
    const next = queues.get(name)?.shift();
    if (next) next(); // passed straight to the next request: the lock stays held
    else held.delete(name);
  };

  const locks = {
    async request(name: string, optionsOrCallback: unknown, maybeCallback?: unknown) {
      const callback = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback) as (lock: unknown) => unknown;
      const options = (typeof optionsOrCallback === "function" ? {} : optionsOrCallback) as { signal?: AbortSignal };
      await acquire(name, options.signal);
      try {
        return await callback({ name, mode: "exclusive" });
      } finally {
        release(name);
      }
    },
    async query() {
      return { held: [...held].map((name) => ({ name, mode: "exclusive" })), pending: [] };
    },
  };
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
}
