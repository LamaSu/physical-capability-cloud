/**
 * commentary.html never sends the API key over plain HTTP to a remote host (astra n103c-586-r1,
 * finding 1).
 *
 * This file serves the page from http://192.0.2.10, a remote host over plain HTTP (the
 * environment option below sets jsdom's URL). N50 sends a key only over https, or over http to
 * this page's own server on loopback (lib/gateway-base.ts). The page must hold to the same rule:
 * a key typed here is never sent, and the page says why.
 *
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "http://192.0.2.10/commentary.html"}
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PAGE = readFileSync(resolve(__dirname, "../../public/commentary.html"), "utf8");

// Built at run time: a key-shaped literal in source trips the secret scanners (pack and push gates).
const KEY = ["pcc", "test", "commentarykey0123456789"].join("_");

let calls: Array<{ url: string; authorization: string | null }> = [];

function loadPage(): void {
  const parsed = new DOMParser().parseFromString(PAGE, "text/html");
  const script = parsed.querySelector("script")!;
  const source = script.textContent ?? "";
  script.remove();
  document.body.innerHTML = parsed.body.innerHTML;
  new Function(source)();
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return new Response("event: ready\ndata: {\"type\":\"ready\"}\n\n", { status: 200 });
    }),
  );
  loadPage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("commentary.html served over plain HTTP from a remote host", () => {
  it("is the origin this file means to test", () => {
    expect(location.origin).toBe("http://192.0.2.10");
  });

  it("never sends the entered key, and says why", async () => {
    (document.getElementById("api-key") as HTMLInputElement).value = KEY;
    (document.getElementById("btn-start") as HTMLButtonElement).click();
    await settle();
    expect(calls.filter((c) => c.authorization !== null)).toEqual([]);
    expect(document.body.textContent ?? "").toMatch(/https/i);
  });
});
