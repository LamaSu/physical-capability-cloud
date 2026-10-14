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
  redirect: RequestRedirect | undefined;
}
let calls: Call[] = [];
let respond: () => Response;

function sse(...chunks: object[]): Response {
  const text = chunks.map((c) => `event: ${(c as { type: string }).type}\ndata: ${JSON.stringify(c)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/**
 * Load the page's markup, then run its script (scripts set through innerHTML don't run on their own).
 * With `servedFrom`, the script sees that URL as its `location`, as if the page were served there
 * (the script reads `location` and nothing else of the page's address). commentary-page-origin.test.ts
 * checks one such origin with jsdom's own URL.
 */
function loadPage(servedFrom?: string): void {
  const parsed = new DOMParser().parseFromString(PAGE, "text/html");
  const scripts = [...parsed.querySelectorAll("script")];
  expect(scripts.length, "the page's inline script").toBe(1);
  const source = scripts[0]!.textContent ?? "";
  scripts[0]!.remove();
  document.body.innerHTML = parsed.body.innerHTML;
  expect(source.match(/\blocation\b/g)?.length, "the script reads location only as the bare global").toBeGreaterThan(0);
  expect(source).not.toMatch(/(window|document|globalThis|self)\.location/);
  new Function("location", source)(servedFrom ? new URL(servedFrom) : location);
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
      calls.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        credentials: init?.credentials,
        redirect: init?.redirect,
      });
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

  it("refuses to follow a redirect with the key", async () => {
    field()!.value = KEY;
    start();
    await settle();
    expect(calls[0]!.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.redirect).toBe("error");
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

// N50's rule (lib/gateway-base.ts): a key goes over https, or over http only to the page's own
// server on loopback (astra n103c-586-r1, finding 1).
describe("commentary.html sends the key only where N50 would (astra n103c-586-r1 F1)", () => {
  const sendTo = async (page: string) => {
    calls = [];
    loadPage(page);
    field()!.value = KEY;
    start();
    await settle();
    return calls;
  };

  it.each([
    "https://capability.network/commentary.html",
    "https://gateway.example.com:8443/commentary.html",
    "http://localhost:3200/commentary.html",
    "http://127.0.0.1:3200/commentary.html",
    "http://[::1]:3200/commentary.html",
  ])("sends it to the page's own gateway when served from %s", async (page) => {
    const sent = await sendTo(page);
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]!.url).origin).toBe(new URL(page).origin);
    expect(sent[0]!.authorization).toBe(`Bearer ${KEY}`);
    expect(field()!.disabled).toBe(false);
  });

  it.each([
    "http://192.0.2.10/commentary.html",
    "http://gateway.example.com/commentary.html",
    "http://127.0.0.2:3200/commentary.html",
    "http://localhost.example.com/commentary.html",
    "http://0.0.0.0:3200/commentary.html",
  ])("never sends it over plain HTTP from %s: the field is disabled and Start says why", async (page) => {
    const sent = await sendTo(page);
    expect(sent.filter((c) => c.authorization !== null)).toEqual([]);
    expect(sent).toEqual([]);
    expect(field()!.disabled).toBe(true);
    const narration = document.getElementById("narration")!.textContent ?? "";
    expect(narration).toContain("Your API key was not sent");
    expect(narration).toContain(new URL(page).host);
  });

  it("without a key, a plain-HTTP page still streams (there is no key to protect)", async () => {
    calls = [];
    loadPage("http://192.0.2.10/commentary.html");
    start();
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.authorization).toBeNull();
  });

  it("a page opened from a file streams from capability.network, over https", async () => {
    const sent = await sendTo("file:///home/someone/commentary.html");
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]!.url).origin).toBe("https://capability.network");
    expect(sent[0]!.authorization).toBe(`Bearer ${KEY}`);
  });
});
