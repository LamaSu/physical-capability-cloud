/**
 * astra 408a LOW: in a demo build (VITE_PCC_DEMO=1) demo mode can't be left,
 * because isDemoMode() returns on the build flag before ?demo=0 is read
 * (lib/demo-mode.ts). The banner must not offer a "Leave demo mode" link it
 * can't honour. The build flag is mocked here: a test can't set it.
 *
 * @vitest-environment jsdom
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const build = vi.hoisted(() => ({ demo: false }));
vi.mock("../../lib/demo-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/demo-mode.js")>()),
  isDemoBuild: () => build.demo,
}));

import { DemoBanner } from "../DemoState.js";

describe("DemoBanner", () => {
  it("in a demo build, offers no 'Leave demo mode' link it can't honour (astra 408a LOW)", () => {
    build.demo = true;
    expect(renderToStaticMarkup(<DemoBanner what="Wallet" />)).not.toContain("Leave demo mode");
  });

  it("outside a demo build, offers the way out", () => {
    build.demo = false;
    expect(renderToStaticMarkup(<DemoBanner what="Wallet" />)).toContain("Leave demo mode");
  });
});
