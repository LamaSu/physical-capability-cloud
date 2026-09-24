// @vitest-environment jsdom
/**
 * AmountDisplay rendered into a real DOM (jsdom), as product-steward #2573 asked.
 * This file imports only the component, so on master it fails on behaviour
 * (master prints "$0.00 USDC" for a missing amount), not on a missing export.
 */

import { describe, it, expect } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AmountDisplay, type AmountDisplayProps } from "./AmountDisplay.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function withRender(props: AmountDisplayProps, check: (host: HTMLElement) => void): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() => root.render(React.createElement(AmountDisplay, props)));
    check(host);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
}

describe("AmountDisplay in a real DOM", () => {
  it("shows a missing or unreadable amount as unavailable, never $0.00", () => {
    for (const amount of [undefined, null, "", "abc", "5 USDC", "NaN"]) {
      withRender({ amount }, (host) => {
        const shown = host.textContent ?? "";
        expect(shown, String(amount)).not.toMatch(/0\.00/);
        expect(shown, String(amount)).toContain("—");
        // The dash is hidden from screen readers; the label is what they announce.
        const hidden = Array.from(host.querySelectorAll('[aria-hidden="true"]')).map((n) => n.textContent);
        expect(hidden, String(amount)).toEqual(["—"]);
        expect(shown, String(amount)).toContain("amount unavailable");
        expect(host.querySelector('[data-amount="unavailable"]'), String(amount)).not.toBeNull();
      });
    }
  });

  it("shows a real amount exactly", () => {
    withRender({ amount: "1234.5" }, (host) => expect(host.textContent).toBe("$1,234.50USDC"));
    withRender({ amount: "0" }, (host) => expect(host.textContent).toBe("$0.00USDC"));
    withRender({ amount: "0.004" }, (host) => expect(host.textContent).toBe("$0.004USDC"));
    withRender({ amount: "2500000", decimals: 6 }, (host) => expect(host.textContent).toBe("$2.50USDC"));
  });

  it("gives the number no payment-state colour or glow", () => {
    withRender({ amount: "12.5", glow: true }, (host) => {
      const el = host.querySelector('[data-amount="value"]');
      expect(el).not.toBeNull();
      expect(el!.className).not.toMatch(/green|glow|text-(red|gold|teal|cyan)-/);
    });
  });
});
