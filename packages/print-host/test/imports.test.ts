import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("print-host module imports", () => {
  it.each(["cli", "keys", "keygen", "index"])("importing %s does not initialize a logging kernel runtime", async (name) => {
    // Each import starts with an empty module cache. An earlier import of the
    // kernel barrel must not hide its startup side effect from this regression.
    vi.resetModules();
    const spies = (["log", "info", "warn", "error", "debug", "trace", "dir", "table", "assert"] as const)
      .map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    if (name === "cli") await import("../src/cli.js");
    else if (name === "keys") await import("../src/keys.js");
    else if (name === "keygen") await import("../src/keygen.js");
    else await import("../src/index.js");
    for (const spy of spies) expect(spy.mock.calls.length).toBe(0);
  });
});
