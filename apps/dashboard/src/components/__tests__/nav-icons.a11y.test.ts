/**
 * nav-icons accessibility.
 *
 * Every exported icon is decorative — its label lives on the Sidebar button's
 * aria-label, not on the glyph. Each icon's <svg> must be aria-hidden and
 * non-focusable so screen readers don't announce ~40+ unnamed "image" nodes
 * per page (product-qa's a11y smoke finding). Uses react-dom/server so no DOM
 * is needed.
 */

import { describe, it, expect } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const NavIcons: Record<string, () => ReactElement> = await import("../nav-icons.js");
const entries = Object.entries(NavIcons);

describe("nav-icons accessibility", () => {
  it("exports at least one icon to check", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)("%s hides its <svg> from screen readers", (_name, IconComponent) => {
    const markup = renderToStaticMarkup(IconComponent());
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('focusable="false"');
  });
});
