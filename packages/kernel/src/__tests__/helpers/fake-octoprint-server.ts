/**
 * An OctoPrint server on the (fake) clock, for tests of OctoPrintAdapter's real mode.
 *
 * A started job prints for `printMs`, reporting progress 96 for its last 2.5 s (OctoPrint's
 * completion is detected from a poll that saw it above 95% while printing), then the
 * printer is Operational at 100%. cancel() ends the current print at its progress. A POST
 * can be held until the test releases it, and a GET of /api/printer can be held too, to
 * keep a poll in flight.
 */
export function fakeOctoPrintServer(printMs = 5_000) {
  let selected = "";
  let job: { name: string; startedAt: number } | null = null;
  let finished: { name: string; progress: number } | null = null;
  const held = new Map<string, Promise<void>>();
  const pending = new Set<string>();
  const requests: string[] = [];

  const state = () => {
    if (job !== null && Date.now() - job.startedAt >= printMs) {
      finished = { name: job.name, progress: 100 };
      job = null;
    }
    if (job === null) return { state: "Operational", progress: finished?.progress ?? 0, name: finished?.name ?? null };
    const elapsed = Date.now() - job.startedAt;
    return { state: "Printing", progress: elapsed >= printMs - 2_500 ? 96 : Math.floor((elapsed / printMs) * 90), name: job.name };
  };
  const json = (body: unknown) => fakeResponse(200, body);
  const holdIfAsked = async (key: string) => {
    const hold = held.get(key);
    if (hold === undefined) return;
    pending.add(key);
    await hold;
    pending.delete(key);
  };

  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    requests.push(`${method} ${path}`);
    await holdIfAsked(`${method} ${path}`);
    if (method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { command?: string };
      if (path.startsWith("/api/files/local/") && body.command === "select") selected = decodeURIComponent(path.slice("/api/files/local/".length));
      if (path === "/api/job" && body.command === "start") {
        state();
        job = { name: selected, startedAt: Date.now() };
      }
      if (path === "/api/job" && body.command === "cancel") cancel();
      return fakeResponse(204, null);
    }
    const s = state();
    if (path === "/api/printer") return json({ state: { text: s.state }, temperature: { bed: { actual: 60, target: 60 }, tool0: { actual: 210, target: 210 } } });
    if (path === "/api/job") return json({ progress: { completion: s.progress }, job: { file: { name: s.name } } });
    return fakeResponse(404, null);
  };

  /** The printer cancels the current print where it is (as from its own screen). */
  const cancel = () => {
    const s = state();
    if (job !== null) {
      finished = { name: job.name, progress: s.progress };
      job = null;
    }
  };

  return {
    fetch,
    cancel,
    /** Every request made, as "METHOD /path". */
    requests,
    /** Hold requests to `METHOD /path` until the returned function is called. */
    hold(methodAndPath: string): () => void {
      let release!: () => void;
      held.set(methodAndPath, new Promise<void>((resolve) => (release = resolve)));
      return () => {
        held.delete(methodAndPath);
        release();
      };
    },
    isPending: (methodAndPath: string) => pending.has(methodAndPath),
  };
}

/**
 * A fetch Response whose body reads resolve on microtasks (an undici Response reads a
 * stream), so a fake-clock test decides exactly when a request completes.
 */
export function fakeResponse(status: number, body: unknown): Response {
  const text = body === null ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(body === null ? {} : { "content-type": "application/json" }),
    json: async () => (body === null ? {} : JSON.parse(text)),
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  } as unknown as Response;
}
