// @vitest-environment jsdom
/**
 * Sidebar + AppShell accessibility, rendered into a real DOM (jsdom).
 *
 * product-qa's accessibility smoke found 44-54 unnamed "image" announcements
 * per dashboard page (decorative nav icons with no aria-hidden), no landmark
 * name on the nav, no current-page indication, and no skip link past the
 * ~42-item nav. This file imports only the components, so on master it fails
 * on missing attributes/markup, not on a missing export.
 */

import { describe, it, expect } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar, type NavGroup } from "./Sidebar.js";
import { AppShell } from "./AppShell.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function withRender(element: React.ReactElement, check: (host: HTMLElement) => void): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() => root.render(element));
    check(host);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
}

const GROUPS: NavGroup[] = [
  {
    title: "General",
    items: [
      { label: "Dashboard", path: "/dashboard", icon: React.createElement("svg") },
      { label: "Discover", path: "/discover", icon: React.createElement("svg") },
    ],
  },
  {
    title: "Operate",
    items: [{ label: "Jobs", path: "/jobs", icon: React.createElement("svg") }],
  },
];

describe("Sidebar accessibility", () => {
  it("names the nav landmark 'Main'", () => {
    withRender(
      React.createElement(Sidebar, { groups: GROUPS, currentPath: "/discover", onNavigate: () => {} }),
      (host) => {
        const nav = host.querySelector("nav");
        expect(nav).not.toBeNull();
        expect(nav!.getAttribute("aria-label")).toBe("Main");
      },
    );
  });

  it("marks the active item with aria-current='page' and leaves the others unmarked", () => {
    withRender(
      React.createElement(Sidebar, { groups: GROUPS, currentPath: "/discover", onNavigate: () => {} }),
      (host) => {
        const buttons = Array.from(host.querySelectorAll("nav button"));
        expect(buttons.length).toBe(3);

        const active = buttons.filter((b) => b.getAttribute("aria-current") === "page");
        expect(active.length).toBe(1);
        expect(active[0].getAttribute("aria-label")).toBe("Discover");

        const inactive = buttons.filter((b) => b !== active[0]);
        expect(inactive.length).toBe(2);
        for (const b of inactive) {
          expect(b.getAttribute("aria-current")).toBeNull();
        }
      },
    );
  });

  it("gives every collapsed item button an accessible name equal to its label", () => {
    withRender(
      React.createElement(Sidebar, {
        groups: GROUPS,
        currentPath: "/discover",
        onNavigate: () => {},
        collapsed: true,
      }),
      (host) => {
        const buttons = Array.from(host.querySelectorAll("nav button"));
        const labels = GROUPS.flatMap((g) => g.items.map((i) => i.label));
        expect(buttons.length).toBe(labels.length);
        buttons.forEach((b, i) => {
          expect(b.getAttribute("aria-label")).toBe(labels[i]);
        });
      },
    );
  });

  it("hides every item's icon wrapper from screen readers", () => {
    withRender(
      React.createElement(Sidebar, { groups: GROUPS, currentPath: "/discover", onNavigate: () => {} }),
      (host) => {
        const buttons = Array.from(host.querySelectorAll("nav button"));
        expect(buttons.length).toBe(3);
        for (const b of buttons) {
          const iconWrapper = b.querySelector(".flex-shrink-0.w-5.h-5");
          expect(iconWrapper).not.toBeNull();
          expect(iconWrapper!.getAttribute("aria-hidden")).toBe("true");
        }
      },
    );
  });

  it("marks the collapse toggle with aria-expanded, reflecting collapsed state", () => {
    withRender(
      React.createElement(Sidebar, {
        groups: GROUPS,
        currentPath: "/discover",
        onNavigate: () => {},
        collapsed: false,
        onToggle: () => {},
      }),
      (host) => {
        const toggle = host.querySelector('button[aria-label="Collapse sidebar"]');
        expect(toggle).not.toBeNull();
        expect(toggle!.getAttribute("aria-expanded")).toBe("true");
      },
    );

    withRender(
      React.createElement(Sidebar, {
        groups: GROUPS,
        currentPath: "/discover",
        onNavigate: () => {},
        collapsed: true,
        onToggle: () => {},
      }),
      (host) => {
        const toggle = host.querySelector('button[aria-label="Expand sidebar"]');
        expect(toggle).not.toBeNull();
        expect(toggle!.getAttribute("aria-expanded")).toBe("false");
      },
    );
  });
});

function renderShell(children: React.ReactNode = React.createElement("div", null, "content")) {
  return React.createElement(AppShell, {
    sidebar: React.createElement("button", { type: "button" }, "sidebar-item"),
    topBar: React.createElement("div", null, "topbar"),
    statusBar: React.createElement("div", null, "statusbar"),
    children,
  });
}

describe("AppShell accessibility", () => {
  it("puts the skip link first among focusable elements, before the app chrome", () => {
    withRender(renderShell(), (host) => {
      const focusable = Array.from(host.querySelectorAll('a[href], button, input, select, textarea, [tabindex]'));
      expect(focusable.length).toBeGreaterThan(0);
      const first = focusable[0] as HTMLElement;
      expect(first.tagName).toBe("A");
      expect(first.textContent).toBe("Skip to main content");
    });
  });

  it("moves focus to #pcc-main when the skip link is activated", () => {
    withRender(renderShell(), (host) => {
      const skipLink = host.querySelector("a") as HTMLAnchorElement | null;
      expect(skipLink).not.toBeNull();
      act(() => {
        skipLink!.click();
      });
      expect(document.activeElement?.id).toBe("pcc-main");
    });
  });

  it("gives <main> id='pcc-main' and tabindex='-1'", () => {
    withRender(renderShell(), (host) => {
      const main = host.querySelector("main");
      expect(main).not.toBeNull();
      expect(main!.id).toBe("pcc-main");
      expect(main!.getAttribute("tabindex")).toBe("-1");
    });
  });
});
