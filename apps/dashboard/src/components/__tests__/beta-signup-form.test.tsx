// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BetaSignupForm } from "../BetaSignupForm.js";
import { WhitepaperPage } from "../../pages/WhitepaperPage.js";
import { gatewayUrl } from "../../lib/gateway-base.js";
import { PUBLISHED_SURFACES } from "../../lib/public-claims.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPO_ROOT = fileURLToPath(new NodeURL("../../../../../", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

describe("the whitepaper's beta signup form", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function renderForm() {
    await act(async () => {
      root.render(<BetaSignupForm />);
    });
  }

  function nameInput(): HTMLInputElement {
    return container.querySelector('input[autocomplete="name"]') as HTMLInputElement;
  }

  function emailInput(): HTMLInputElement {
    return container.querySelector('input[autocomplete="email"]') as HTMLInputElement;
  }

  async function setValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function chooseRadio(value: string) {
    const radio = container.querySelector(`input[name="role"][value="${value}"]`) as HTMLInputElement;
    await act(async () => {
      radio.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  async function submitForm() {
    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    await act(async () => {});
  }

  async function fillValid() {
    await setValue(nameInput(), "Ann Example");
    await setValue(emailInput(), "ann@example.com");
    await chooseRadio("builder");
  }

  it("the whitepaper page shows the form after its article, with no session", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      if (String(input) === "/whitepaper.md") return new Response("# Title");
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => {
      root.render(<WhitepaperPage />);
    });
    await act(async () => {});
    await act(async () => {});
    const article = container.querySelector("article") as HTMLElement;
    const form = container.querySelector('form[aria-label="Private beta signup"]') as HTMLElement;
    expect(article).not.toBeNull();
    expect(form).not.toBeNull();
    expect(article.contains(form)).toBe(false);
    expect(article.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("one valid signup sends one POST with no key, no cookie and no field in the URL", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    await renderForm();
    await setValue(nameInput(), "  Ann Example ");
    await setValue(emailInput(), " ann@example.com ");
    await chooseRadio("builder");
    await submitForm();
    await submitForm();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(gatewayUrl("/api/beta-apply"));
    expect(String(url)).not.toContain("?");
    expect(String(url)).not.toContain("Ann Example");
    expect(String(url)).not.toContain("ann@example.com");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("omit");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Ann Example", email: "ann@example.com", role: "builder", hp: "" });
    await act(async () => {
      resolveFetch(new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } }));
    });
    await act(async () => {});
  });

  it("the form's text is exactly the given copy", async () => {
    await renderForm();
    const form = container.querySelector("form") as HTMLFormElement;
    expect(form.getAttribute("aria-label")).toBe("Private beta signup");
    const labels = [...container.querySelectorAll("label")];
    expect(labels[0].textContent).toBe("Name");
    expect(labels[1].textContent).toBe("Email");
    expect(container.querySelector("legend")?.textContent).toBe("Role");
    const radioLabels = [...container.querySelectorAll("fieldset label")];
    expect(radioLabels.map((label) => [...label.querySelectorAll("span")].map((s) => s.textContent))).toEqual([
      ["Buyer", "I want to order physical work."],
      ["Operator", "I run machines, a lab or a service."],
      ["Builder", "I build kits, templates or tools."],
    ]);
    const note = [...container.querySelectorAll("p")].find((p) => p.textContent?.startsWith("We'll use")) as HTMLElement;
    expect(note.textContent).toBe("We'll use your name, email and role only to contact you about the private beta. They're stored privately and never published. To be removed from the list, email <<ADDRESS>>.");
    expect(container.querySelector("button")?.textContent).toBe("Sign up");
  });

  it.each([
    ["a rejected fetch", async () => { throw new Error("down"); }],
    ["500", async () => new Response(JSON.stringify({ error: "server_error" }), { status: 500 })],
    ["503", async () => new Response(JSON.stringify({ error: "server_error" }), { status: 503 })],
    ["400 with server text", async () => new Response(JSON.stringify({ error: "bad_request", message: "SERVER-TEXT" }), { status: 400 })],
    ["415", async () => new Response(JSON.stringify({ error: "unsupported_media_type" }), { status: 415 })],
    ["a 200 with the body not json", async () => new Response("not json", { status: 200 })],
    ["a 200 with status error", async () => new Response(JSON.stringify({ status: "error" }), { status: 200 })],
  ] as Array<[string, () => Promise<Response>]>)("%s shows the failure line, keeps the inputs and frees the button", async (_label, impl) => {
    const fetchMock = vi.fn(impl);
    vi.stubGlobal("fetch", fetchMock);
    await renderForm();
    await fillValid();
    await submitForm();
    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toBe("We couldn't confirm your signup. Try again.");
    expect(container.textContent).not.toContain("SERVER-TEXT");
    expect(nameInput().value).toBe("Ann Example");
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.textContent).toBe("Sign up");
    expect(button.disabled).toBe(false);
  });

  it("a 429 shows the rate line", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    await renderForm();
    await fillValid();
    await submitForm();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Too many signups right now. Try again in a few minutes.");
  });

  it.each([
    ["an empty name", "", "ann@example.com", "builder", "Enter your name."],
    ["a 101-char name", "a".repeat(101), "ann@example.com", "builder", "Enter your name."],
    ["a name holding U+202E", "Ann" + String.fromCharCode(0x202e) + "Example", "ann@example.com", "builder", "Enter your name."],
    ["the email a@b", "Ann Example", "a@b", "builder", "Enter a valid email address."],
    ["the email with forbidden characters", "Ann Example", "<script>alert(1)</script>@x.y", "builder", "Enter a valid email address."],
    ["no role", "Ann Example", "ann@example.com", "", "Choose a role."],
  ])("%s shows its line and sends nothing", async (_label, nameValue, emailValue, roleValue, expected) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await renderForm();
    await setValue(nameInput(), nameValue);
    await setValue(emailInput(), emailValue);
    if (roleValue) await chooseRadio(roleValue);
    await submitForm();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(expected);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["ok", '{"status":"ok"}'],
    ["ok with extra keys", '{"status":"ok","id":"beta-x","fastTracked":false,"message":"Application received"}'],
  ])("a 2xx with %s shows the success line in place of the form", async (_label, body) => {
    const fetchMock = vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await renderForm();
    await fillValid();
    await submitForm();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Thanks. We received your signup.");
    expect(container.querySelector("form")).toBeNull();
  });

  it("the form sits in a ph-no-capture sentry-block section and writes nothing to the console", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      await renderForm();
      const section = container.querySelector("section") as HTMLElement;
      expect(section.classList.contains("ph-no-capture")).toBe(true);
      expect(section.classList.contains("sentry-block")).toBe(true);
      await fillValid();
      await submitForm();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("the honeypot input has no label, no tab stop and no autocomplete, and is hidden from assistive tech", async () => {
    await renderForm();
    const hpInput = container.querySelector('input[name="hp"]') as HTMLInputElement;
    expect(hpInput.closest("label")).toBeNull();
    expect(hpInput.tabIndex).toBe(-1);
    expect(hpInput.getAttribute("autocomplete")).toBe("off");
    expect(hpInput.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it("the guard checks the form's file, and neither whitepaper file holds a form or an input", () => {
    expect(PUBLISHED_SURFACES).toContain("apps/dashboard/src/components/BetaSignupForm.tsx");
    for (const path of ["apps/dashboard/public/whitepaper.md", "docs/whitepaper.md"]) {
      const text = read(path);
      expect(text).not.toMatch(/<form/i);
      expect(text).not.toMatch(/<input/i);
    }
  });
});
