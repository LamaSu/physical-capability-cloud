/**
 * The feedback form posts through the shared gateway client (api.submitFeedback),
 * so the key is attached the same way as for every other request, and a
 * rejected post says so instead of claiming it was submitted.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackButton } from "../FeedbackButton.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let posts: Array<{ url: string; method: string | undefined; body: unknown }>;
let status: number;

beforeEach(() => {
  posts = [];
  status = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      posts.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ id: "fb-1", submitted: true }), { status, statusText: status === 200 ? "OK" : "Error" });
    }),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function openAndSubmit(message: string) {
  await act(async () => root.render(<FeedbackButton />));
  const open = [...container.querySelectorAll("button")].find((b) => b.textContent === "Feedback")!;
  await act(async () => open.click());
  const textarea = container.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(textarea, message);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submit = [...container.querySelectorAll("button")].find((b) => b.textContent === "Submit")!;
  await act(async () => {
    submit.click();
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe("FeedbackButton", () => {
  it("posts the message to /api/feedback and says it was submitted", async () => {
    await openAndSubmit("The jobs page is slow");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("/api/feedback");
    expect(posts[0]!.method).toBe("POST");
    expect(posts[0]!.body).toMatchObject({ type: "bug", message: "The jobs page is slow" });
    expect(container.textContent).toContain("Submitted!");
  });

  it("a rejected post shows the failure, not success", async () => {
    status = 500;
    await openAndSubmit("Broken");
    expect(container.textContent).toContain("Failed -- retry?");
    expect(container.textContent).not.toContain("Submitted!");
  });
});
