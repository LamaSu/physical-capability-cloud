/**
 * The commentary page sends the API key it is given (N103, client half).
 *
 * public/commentary.html streams POST /api/commentary/stream, which the
 * gateway's apiGate guards. The page sent only the SIWE session cookie. The
 * gateway is about to honor that cookie only beside the API key the session
 * was verified under (gateway's ruling #6597), so the page asks for the key
 * and sends it as a bearer. It holds the key in the field for this page only:
 * it never writes it to storage, and it does not read the dashboard's stored
 * key (lib/authorized-fetch.ts owns that slot, N50).
 *
 * The page is plain HTML with one inline script; this loads both into jsdom.
 *
 * @vitest-environment jsdom
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PAGE = readFileSync(resolve(__dirname, "../../public/commentary.html"), "utf8");

// Built at run time: a key-shaped literal in source trips the secret scanners (pack and push gates).
const KEY = ["pcc", "test", "commentarykey0123456789"].join("_");

interface Call {
  url: string;
  authorization: string | null;
  credentials: RequestCredentials | undefined;
}
let calls: Call[] = [];
let respond: () => Response;

function sse(...chunks: object[]): Response {
  const text = chunks.map((c) => `event: ${(c as { type: string }).type}\ndata: ${JSON.stringify(c)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Load the page's markup, then run its script (scripts set through innerHTML don't run on their own). */
function loadPage(): void {
  const parsed = new DOMParser().parseFromString(PAGE, "text/html");
  const scripts = [...parsed.querySelectorAll("script")];
  expect(scripts.length, "the page's inline script").toBe(1);
  const source = scripts[0]!.textContent ?? "";
  scripts[0]!.remove();
  document.body.innerHTML = parsed.body.innerHTML;
  new Function(source)();
}

const field = () => document.getElementById("api-key") as HTMLInputElement | null;
const start = () => (document.getElementById("btn-start") as HTMLButtonElement).click();
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  calls = [];
  respond = () => sse({ type: "ready" });
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization"), credentials: init?.credentials });
      return respond();
    }),
  );
  loadPage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("commentary.html sends the API key (N103)", () => {
  it("has a key field that browsers neither show nor autofill", () => {
    const input = field();
    expect(input, "an #api-key field").not.toBeNull();
    expect(input!.type).toBe("password");
    expect(input!.autocomplete).toBe("off");
    expect(input!.getAttribute("aria-label")?.trim(), "an accessible name").toBeTruthy();
  });

  it("sends the entered key as a bearer on the stream request, to this page's own gateway", async () => {
    field()!.value = `  ${KEY}  `;
    start();
    await settle();
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).origin).toBe(location.origin);
    expect(new URL(calls[0]!.url).pathname).toBe("/api/commentary/stream");
    expect(calls[0]!.authorization).toBe(`Bearer ${KEY}`);
  });

  it("keeps the key out of storage and cookies", async () => {
    field()!.value = KEY;
    start();
    await settle();
    expect(calls[0]!.authorization).toBe(`Bearer ${KEY}`);
    const stored = [localStorage, sessionStorage].flatMap((s) =>
      Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i)!)}`),
    );
    expect(stored.join("\n")).not.toContain(KEY);
    expect(document.cookie).not.toContain(KEY);
  });

  it("does not read the dashboard's stored key", async () => {
    localStorage.setItem("pcc-api-key", KEY);
    start();
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.authorization).toBeNull();
  });

  it("without a key, a 401 asks for the key instead of blaming the narrator's key", async () => {
    respond = () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    start();
    await settle();
    expect(calls[0]!.authorization).toBeNull();
    const narration = document.getElementById("narration")!.textContent ?? "";
    expect(narration).toMatch(/paste your PCC API key/i);
    expect(narration).not.toContain("ANTHROPIC_API_KEY on the gateway");
  });
});
