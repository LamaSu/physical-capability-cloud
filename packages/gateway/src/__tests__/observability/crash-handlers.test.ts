/**
 * N107b: the process crash handlers print the error closed. A rejection from work a request
 * started can echo that request in its message, and these handlers run outside any request
 * scope, so they print the error's class, code and code frames and its message as a keyed hash.
 */
import { describe, it, expect, vi } from "vitest";
import { onUncaughtException, onUnhandledRejection } from "../../server.js";

describe("N107b: the process crash handlers close the error they print", () => {
  it("an unhandled rejection and an uncaught exception print the class and frames, never the message", () => {
    const marker = ["crash", "marker", "8675309"].join("-");
    const printed: unknown[][] = [];
    const exits: unknown[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      printed.push(args);
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: unknown) => {
      exits.push(code);
    }) as never);
    try {
      onUnhandledRejection(new Error(`unknown kernel ${marker}`));
      onUncaughtException(new TypeError(`bad input ${marker}`));
      onUnhandledRejection(`a bare reason ${marker}`);
    } finally {
      error.mockRestore();
      exit.mockRestore();
    }
    expect(JSON.stringify(printed)).not.toContain(marker);
    expect(printed[0]![1]).toMatchObject({ type: "Error" });
    expect(printed[1]![1]).toMatchObject({ type: "TypeError" });
    expect((printed[1]![1] as { stack?: string[] }).stack?.length ?? 0).toBeGreaterThan(0);
    expect(printed[2]![1]).toMatchObject({ type: "NonError" });
    expect(exits).toEqual([1]);
  });
});
