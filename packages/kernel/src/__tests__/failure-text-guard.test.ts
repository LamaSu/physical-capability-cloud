/**
 * A static tripwire for the evidence path's failure text (steward #5547). A catch on the evidence
 * path turns a failure's reason into text only through failureText, which never throws. The raw
 * `err instanceof Error ? err.message : String(err)` throws for a reason with no text form (astra
 * pack 200), so it may appear only inside a failureText helper, under its try.
 *
 * Its scope, precisely: the files in FILES, and the conversion's known spellings (RAW), including
 * `(err).message`, `String (err)` and a template literal (astra pack 209). It is a text match, not a
 * parser, so it cannot prove that no other spelling exists. The dynamic tests are the protection
 * (job-runner-failure-text, printer-log-adapter-polling, printer-log-adapter-reentrancy); this
 * guard stops the known spellings from coming back. An exempted failureText must have the total
 * shape: its conversion inside a try, only a string returned, a fixed text otherwise.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { eventType, failureText } from "../failure-text.js";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const FILES = ["job-runner.ts", "evidence-session.ts", "adapters/printer-log-adapter.ts", "failure-text.ts"];
const RAW = /instanceof\s+Error\s*\?\s*\(?\s*[\w.]+\s*\)?\s*\.message\s*:\s*(?:String\s*\(|`\$\{)/g;
const FAILURE_TEXT = /function failureText\([^)]*\)[^{]*\{[\s\S]*?\n\}/g;

/** The source without the body of any `function failureText(`: the one place the raw conversion runs, under a try. */
function outsideFailureText(source: string): string {
  return source.replace(FAILURE_TEXT, "");
}

/** Every failureText the guard exempts, so each can be checked for the total shape. */
function failureTextBodies(source: string): string[] {
  return source.match(FAILURE_TEXT) ?? [];
}

describe("the evidence path's failure text (steward #5547)", () => {
  it.each(FILES)("%s turns a failure's reason into text only through failureText", (file) => {
    const raw = outsideFailureText(readFileSync(SRC + file, "utf8")).match(RAW) ?? [];
    expect(raw, `raw conversions in ${file}, outside failureText`).toEqual([]);
  });

  it.each([
    ["the plain spelling", "err instanceof Error ? err.message : String(err)"],
    ["a parenthesized receiver", "err instanceof Error ? (err).message : String(err)"],
    ["a space before the call", "err instanceof Error ? err.message : String (err)"],
    ["a template literal", "err instanceof Error ? err.message : `${err}`"],
  ])("the guard sees a raw conversion outside failureText: %s", (_what, conversion) => {
    const sample = `try { run(); } catch (err) {\n  const message = ${conversion};\n}\n`;
    expect(outsideFailureText(sample).match(RAW)).toHaveLength(1);
  });

  it.each(FILES)("every failureText in %s that the guard exempts has the total shape", (file) => {
    for (const body of failureTextBodies(readFileSync(SRC + file, "utf8"))) {
      expect.soft(body, `${file}: a failureText`).toMatch(/try \{[\s\S]*instanceof Error[\s\S]*\} catch \{[\s\S]*\}\s*return "a reason with no text form";/);
      expect.soft(body, `${file}: a failureText returns only a string`).toMatch(/if \(typeof text === "string"\) return text;/);
    }
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

  it.each([
    ["a string type", () => ({ type: "execution_started" }) as unknown, "execution_started"],
    ["a type getter that throws", () => Object.defineProperty({}, "type", { get: () => { throw Object.create(null); } }) as unknown, "(unreadable)"],
    ["a type that is not a string", () => ({ type: 42 }) as unknown, "(unreadable)"],
    ["no event at all", () => undefined as unknown, "(unreadable)"],
  ])("eventType of %s", (_what, event, type) => {
    expect(eventType(event())).toBe(type);
  });
});
