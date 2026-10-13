// @vitest-environment jsdom
/**
 * astra EC3 M4: invalid JSON submitted while a preview request is still out must not leave the page
 * loading forever. The earlier request is cancelled when the source changes, so only the parse-error
 * path itself can end the loading state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock("../../lib/api.js", () => api);

import { EconomicAgreementsPage } from "../EconomicAgreementsPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("EconomicAgreementsPage: invalid JSON during an outstanding preview (astra EC3 M4)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    api.apiGet.mockResolvedValue({ templates: [{ templateId: "spare-printer", title: "Spare printer", summary: "" }] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows 'No preview', not a skeleton, after the held request resolves", async () => {
    let resolveFirst!: (v: unknown) => void;
    api.apiPost.mockReturnValueOnce(new Promise((r) => (resolveFirst = r)));
    await act(async () => root.render(<EconomicAgreementsPage />));

    const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Spare printer")!;
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(api.apiPost).toHaveBeenCalledTimes(1); // the template preview is now outstanding

    const textarea = container.querySelector("textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(textarea, "{ not json");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const previewButton = [...container.querySelectorAll("button")].find((b) => b.textContent === "Preview")!;
    await act(async () => previewButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => resolveFirst({ preview: null }));

    expect(container.textContent).toContain("No preview");
    expect(container.textContent).toContain("That is not valid JSON.");
  });
});
