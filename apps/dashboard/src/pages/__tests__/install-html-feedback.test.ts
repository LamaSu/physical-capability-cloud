// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const PUBLIC = resolve(__dirname, "../../../public");
const HTML = readFileSync(join(PUBLIC, "install.html"), "utf8");
const BODY = HTML.slice(HTML.indexOf("<body>") + "<body>".length, HTML.indexOf("<script>"));
const SCRIPT = HTML.slice(HTML.indexOf("<script>") + "<script>".length, HTML.indexOf("</script>"));
const EMAIL_DECLARATION = "const FEEDBACK_EMAIL = '';";
const MESSAGE = "Please add more setup examples.";
const TYPE = "suggestion";
const VISITOR_EMAIL = "visitor@example.com";
const SUCCESS_TEXT = "✓ Sent — thank you";

const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => ({
  ok: true,
  status: 200,
  json: async () => ({}),
}));

function boot(script = SCRIPT) {
  document.body.innerHTML = BODY;
  new Function(script)();
}

function scriptWithEmail(email: string) {
  expect(SCRIPT.split(EMAIL_DECLARATION)).toHaveLength(2);
  const declaration = `const FEEDBACK_EMAIL = ${JSON.stringify(email)};`;
  const script = SCRIPT.replace(EMAIL_DECLARATION, declaration);
  expect(script).not.toContain(EMAIL_DECLARATION);
  expect(script.split(declaration)).toHaveLength(2);
  return script;
}

async function submit(message = MESSAGE) {
  (document.getElementById("fb-email") as HTMLInputElement).value = VISITOR_EMAIL;
  (document.getElementById("fb-type") as HTMLSelectElement).value = TYPE;
  (document.getElementById("fb-message") as HTMLTextAreaElement).value = message;
  document.getElementById("feedback-form")!.dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
  // Settle the async handler without reaching the four-second button reset.
  await vi.advanceTimersByTimeAsync(0);
}

function expectApiOnlySuccess() {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toBe("/api/feedback");
  expect(options?.method).toBe("POST");
  expect(JSON.parse(options?.body as string)).toEqual({
    type: TYPE,
    message: MESSAGE,
    email: VISITOR_EMAIL,
    page: location.pathname,
  });
  expect(fetchMock.mock.calls.some(([url]) => url.includes("formsubmit.co"))).toBe(false);
  expect(document.getElementById("fb-submit")!.textContent).toBe(SUCCESS_TEXT);
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("/install.html feedback", () => {
  it("F1: the shipped page submits only to the API and shows success", async () => {
    boot();
    await submit();
    expectApiOnlySuccess();
  });

  it("F2: a configured recipient also receives the same feedback through formsubmit", async () => {
    const recipient = "feedback@example.com";
    boot(scriptWithEmail(recipient));
    await submit();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/feedback",
      "https://formsubmit.co/ajax/" + recipient,
    ]);
    const [, options] = fetchMock.mock.calls[1];
    expect(options?.method).toBe("POST");
    expect(options?.body).toBeInstanceOf(FormData);
    expect(Array.from((options?.body as FormData).entries())).toEqual([
      ["_subject", "PCC feedback: " + TYPE + " from " + VISITOR_EMAIL],
      ["_template", "box"],
      ["_captcha", "false"],
      ["email", VISITOR_EMAIL],
      ["type", TYPE],
      ["message", MESSAGE],
      ["page", location.href],
      ["userAgent", navigator.userAgent],
    ]);
  });

  it("F3: a whitespace-only recipient submits only to the API", async () => {
    boot(scriptWithEmail(" \t \n "));
    await submit();
    expectApiOnlySuccess();
  });

  it("F4: an empty message sends no request", async () => {
    boot();
    await submit("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("F5: public text has no free-mail address and the plugin contact uses the role domain", () => {
    const domains = [
      "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com",
      "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
    ];
    const freeMail = new RegExp(
      "[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:" +
        domains.map((domain) => domain.replace(/\./g, "\\.")).join("|") +
        ")\\b",
      "i",
    );
    const binaryExtensions = new Set([
      ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".tif", ".tiff", ".heic",
      ".woff", ".woff2", ".ttf", ".otf", ".eot",
      ".zip", ".gz", ".tgz", ".tar", ".bz2", ".xz", ".7z", ".rar", ".br",
      ".pdf", ".wasm",
    ]);
    function textFiles(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return textFiles(path);
        return entry.isFile() && !binaryExtensions.has(extname(entry.name).toLowerCase()) ? [path] : [];
      });
    }
    for (const path of textFiles(PUBLIC)) {
      expect(readFileSync(path, "utf8"), relative(PUBLIC, path)).not.toMatch(freeMail);
    }
    const plugin = JSON.parse(readFileSync(join(PUBLIC, ".well-known/ai-plugin.json"), "utf8"));
    expect(plugin.contact_email).toMatch(/^(?:[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@capability\.network)?$/i);
  });
});
