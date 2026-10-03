/**
 * A static guard for the evidence path's failure text (steward #5547). A catch on the evidence
 * path turns a failure's reason into text only through failureText, which never throws. The raw
 * `err instanceof Error ? err.message : String(err)` throws for a reason with no text form (astra
 * pack 200), so it may appear only inside a failureText helper, under its try.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { failureText } from "../failure-text.js";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const FILES = ["job-runner.ts", "evidence-session.ts", "adapters/printer-log-adapter.ts", "failure-text.ts"];
const RAW = /instanceof\s+Error\s*\?\s*[\w.]+\.message\s*:\s*String\(/g;

/** The source without the body of any `function failureText(`: the one place the raw conversion runs, under a try. */
function outsideFailureText(source: string): string {
  return source.replace(/function failureText\([^)]*\)[^{]*\{[\s\S]*?\n\}/g, "");
}

describe("the evidence path's failure text (steward #5547)", () => {
  it.each(FILES)("%s turns a failure's reason into text only through failureText", (file) => {
    const raw = outsideFailureText(readFileSync(SRC + file, "utf8")).match(RAW) ?? [];
    expect(raw, `raw conversions in ${file}, outside failureText`).toEqual([]);
  });

  it("the guard sees a raw conversion outside failureText", () => {
    const sample = "try { run(); } catch (err) {\n  const message = err instanceof Error ? err.message : String(err);\n}\n";
    expect(outsideFailureText(sample).match(RAW)).toHaveLength(1);
  });

  it.each([
    ["an Error", () => new Error("disk full") as unknown, "disk full"],
    ["a string", () => "disk full" as unknown, "disk full"],
    ["an object with no prototype", () => Object.create(null) as unknown, "a reason with no text form"],
    ["an object whose toString throws", () => ({ toString: () => { throw new Error("no text"); } }) as unknown, "a reason with no text form"],
    ["an Error whose message getter throws", () => Object.defineProperty(new Error("x"), "message", { get: () => { throw new Error("no message"); } }) as unknown, "a reason with no text form"],
    ["an Error whose message is not text", () => Object.defineProperty(new Error("x"), "message", { value: 42 }) as unknown, "a reason with no text form"],
    ["a revoked Proxy", () => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy as unknown; }, "a reason with no text form"],
  ])("failureText of %s", (_what, reason, text) => {
    expect(failureText(reason())).toBe(text);
  });
});
