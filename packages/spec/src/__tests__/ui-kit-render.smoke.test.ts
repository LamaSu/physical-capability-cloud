/**
 * @vitest-environment jsdom
 *
 * On-Ramp Wave 2 — render smoke test for the shipped kit (pcc-ui.js).
 *
 * Boots the ACTUAL kit source in jsdom against the job-watch manifest + a baked
 * data snapshot (the same pair demo-snapshot.html ships), and asserts the render
 * path works end-to-end with NO gateway: snapshot mode is detected, the banner
 * appears, every window builds, and the baked values reach the DOM — all via
 * textContent (the kit never touches innerHTML). This is the "watched it render"
 * proof behind demo-snapshot.html.
 *
 * The kit is a classic-script IIFE; we execute its source in the jsdom global
 * scope. In snapshot mode it performs NO fetch, so the render is fully offline.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const kitPath = path.resolve(
  here,
  "../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js",
);
const examplesDir = path.resolve(
  here,
  "../../../../apps/dashboard/public/ui-kit/v1/example-manifests",
);
const kitSrc = readFileSync(kitPath, "utf8");
const jobWatch = readFileSync(path.join(examplesDir, "job-watch.json"), "utf8");

const SNAPSHOT = JSON.stringify({
  _ts: "2026-07-09T18:42:00Z",
  "/api/escrow/esc-pizza-8k3f": {
    id: "esc-pizza-8k3f",
    status: "funded",
    totalAmount: "21.99",
    currency: "USDC",
    payer: "you@example.com",
    payee: "kernel_dominos_7764",
    rail: "escrow-milestone",
    events: [
      { type: "created", timestamp: "2026-07-09T18:31:12Z" },
      { type: "funded", timestamp: "2026-07-09T18:32:05Z" },
    ],
    escrowAddress: "0x4547ec08a1b2c3",
  },
  "/api/jobs/job-pizza-8k3f": {
    job: {
      status: "in_progress",
      timeline: [
        { type: "order placed", timestamp: "2026-07-09T18:31:00Z" },
        { type: "out for delivery", timestamp: "2026-07-09T18:41:00Z" },
      ],
    },
    evidence: [],
  },
});

function boot(manifestJson: string, snapshotJson?: string) {
  document.documentElement.removeAttribute("data-theme");
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  (window as unknown as { __PCC_UI_BOOTED__?: boolean }).__PCC_UI_BOOTED__ = false;

  const main = document.createElement("main");
  main.id = "pcc-root";
  const status = document.createElement("p");
  status.id = "pcc-kit-status";
  status.textContent = "Loading…";
  main.appendChild(status);
  document.body.appendChild(main);

  const mNode = document.createElement("script");
  mNode.type = "application/json";
  mNode.id = "pcc-manifest";
  mNode.textContent = manifestJson;
  document.body.appendChild(mNode);

  if (snapshotJson) {
    const sNode = document.createElement("script");
    sNode.type = "application/json";
    sNode.id = "pcc-snapshot";
    sNode.textContent = snapshotJson;
    document.body.appendChild(sNode);
  }

  // Execute the kit source in the jsdom global scope (indirect eval). The kit
  // runs mount() immediately because document.readyState is not 'loading'.
  // eslint-disable-next-line no-eval
  (0, eval)(kitSrc);
}

// Let snapshot-mode Promise.resolve() bindings (metric/receipt) settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("pcc-ui kit renders a manifest in snapshot mode (offline, no gateway)", () => {
  beforeEach(() => boot(jobWatch, SNAPSHOT));

  it("boots without throwing and builds the wrapper", () => {
    expect(document.querySelector(".pcc-wrap")).not.toBeNull();
    expect(document.getElementById("pcc-kit-status")).toBeNull(); // placeholder removed
  });

  it("detects snapshot mode and shows the honest banner", () => {
    const wrap = document.querySelector(".pcc-wrap") as HTMLElement;
    expect(wrap.getAttribute("data-mode")).toBe("snapshot");
    const banner = document.querySelector(".pcc-banner");
    expect(banner).not.toBeNull();
    expect(banner!.textContent!.toLowerCase()).toContain("snapshot");
  });

  it("builds a window per manifest window (metric + run + receipt)", () => {
    // 3 windows: metric, run, receipt (note-less manifest).
    expect(document.querySelectorAll(".pcc-win").length).toBeGreaterThanOrEqual(3);
  });

  it("renders the run window status from the baked snapshot", () => {
    const run = document.querySelector(".pcc-run-latest");
    expect(run).not.toBeNull();
    // latest line becomes the last timeline event in snapshot mode
    expect(document.body.textContent).toContain("out for delivery");
    const pill = document.querySelector(".pcc-win .pcc-pill");
    expect(document.body.textContent).toContain("in_progress");
    expect(pill).not.toBeNull();
  });

  it("fills async metric + receipt bindings from the snapshot (baked 21.99)", async () => {
    await flush();
    expect(document.querySelector(".pcc-metric-amount")!.textContent).toContain("21.99");
    expect(document.querySelector(".pcc-receipt-num")!.textContent).toContain("21.99");
    // payer→payee + rail present
    expect(document.body.textContent).toContain("kernel_dominos_7764");
    expect(document.body.textContent).toContain("escrow-milestone");
  });

  it("injects the visual-system stylesheet (tokens present)", () => {
    const style = document.getElementById("pcc-ui-styles");
    expect(style).not.toBeNull();
    expect(style!.textContent).toContain("--bg:#0A0B0D"); // dark token
    expect(style!.textContent).toContain("prefers-reduced-motion"); // motion kill-switch
    expect(style!.textContent).toContain("prefers-color-scheme: light"); // light path
  });

  it("no action fired on load: no POST modal, no intent chip present at rest", () => {
    expect(document.querySelector(".pcc-overlay")).toBeNull();
    expect(document.querySelector(".pcc-chip")).toBeNull();
  });
});

describe("pcc-ui kit renders an actions manifest and gates money verbs", () => {
  const actionsManifest = JSON.stringify({
    csd: "pcc://artifacts/dashboard/v1",
    title: "Actions",
    sections: [
      {
        windows: [
          {
            kind: "actions",
            actions: [
              {
                id: "fund",
                label: "Fund escrow",
                kind: "post",
                path: "/api/escrow/fund",
                confirm: "approval",
                intentText: "pcc: fund the escrow",
              },
            ],
          },
        ],
      },
    ],
  });

  it("in snapshot mode a money action yields an intent chip, never a POST", () => {
    boot(actionsManifest, JSON.stringify({ _ts: "2026-07-09T00:00:00Z" }));
    const btn = document.querySelector(".pcc-actionbar .pcc-btn") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    // snapshot → copyable intent chip, no approval modal, no network
    expect(document.querySelector(".pcc-chip")).not.toBeNull();
    expect(document.querySelector(".pcc-overlay")).toBeNull();
    expect(document.querySelector(".pcc-chip")!.textContent).toContain("fund");
  });
});
