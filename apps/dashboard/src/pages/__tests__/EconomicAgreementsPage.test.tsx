/**
 * PX-12: the agreement preview is rendered from the server's DTO, and the retired IP pages are gone.
 *
 * The view is rendered to static markup with a preview the real economics builder produced, so the
 * test checks what a person would read, not a mock of it.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { economics } from "@pcc/spec";
import { EconomicAgreementView } from "../../components/economics/EconomicAgreementView.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(here, "..", rel), "utf-8");

function templatePreview(templateId: string, withScenarios = false) {
  const t = economics.AGREEMENT_TEMPLATES.find((x) => x.templateId === templateId)!;
  const ag = t.build();
  const compiled = economics.compileEconomics(ag, t.compileOptions);
  const scenarios = withScenarios
    ? economics.simulateEconomics(ag, [{ scenarioId: "print-fails", label: "Printing fails", grossOverrides: [], usesOverrides: [], outcomes: [{ unitRef: ag.units[0]!.unitRef, outcome: "refunded" }] }], t.compileOptions)
    : [];
  return economics.buildEconomicPreview(ag, compiled, { feeVerified: true, scenarios });
}

describe("EconomicAgreementView", () => {
  it("shows who gets paid what, when and why, in the server's own words and amounts", () => {
    const html = renderToStaticMarkup(<EconomicAgreementView preview={templatePreview("print-and-mail", true)} />);
    expect(html).toContain("You pay at most 22.00 USDC.");
    expect(html).toContain("Mei (invented the address check)");
    expect(html).toContain("Address check: $0.25 each time it runs");
    expect(html).toContain("Composer&#x27;s margin");
    expect(html).toContain("Preview, not a deal");
    expect(html).toContain("Printing fails");
    expect(html).toContain("Nothing is reserved or paid yet.");
  });

  it("a refused agreement shows its reasons and no money", () => {
    const ag = economics.exampleIncompatibleLicense();
    const html = renderToStaticMarkup(<EconomicAgreementView preview={economics.buildEconomicPreview(ag, economics.compileEconomics(ag), { feeVerified: true })} />);
    expect(html).toContain("Refused");
    expect(html).toContain("A license does not allow this use.");
    expect(html).not.toContain("Most you pay");
  });

  it("an unchecked fee is flagged", () => {
    const t = economics.AGREEMENT_TEMPLATES[0]!;
    const ag = t.build();
    const p = economics.buildEconomicPreview(ag, economics.compileEconomics(ag, t.compileOptions), { feeVerified: false });
    expect(renderToStaticMarkup(<EconomicAgreementView preview={p} />)).toContain("Fee not checked");
  });

  it("computes nothing itself: no arithmetic on amounts in the view", () => {
    const view = src("../components/economics/EconomicAgreementView.tsx");
    for (const forbidden of ["BigInt(", "Number(", "parseFloat", "parseInt", "toFixed", "Math."]) {
      expect(view, forbidden).not.toContain(forbidden);
    }
  });
});

describe("EconomicAgreementsPage and the retired IP pages", () => {
  it("asks the server for the preview, never computes it in the browser", () => {
    const page = src("EconomicAgreementsPage.tsx");
    expect(page).toContain('apiPost<{ preview: economics.EconomicPreviewDTO }>("/economics/preview"');
    expect(page).toContain('apiGet<{ templates: Template[] }>("/economics/templates")');
    expect(page).not.toContain("compileEconomics");
  });

  it("the fabricated IP, DePIN and SWF pages are retired and their routes redirect to the agreements page", () => {
    for (const retired of ["IPDashboardPage.tsx", "IPDetailPage.tsx", "RevenueClaimsPage.tsx", "IPRevenuePage.tsx", "DePINDashboardPage.tsx", "SWFDashboardPage.tsx", "SWFGovernancePage.tsx"]) {
      expect(existsSync(resolve(here, "..", retired)), retired).toBe(false);
    }
    const app = src("../App.tsx");
    expect(app).toContain('<Route path="/economics" element={<EconomicAgreementsPage />} />');
    for (const path of ["/ip", "/depin", "/swf/*"]) {
      expect(app).toContain(`<Route path="${path}" element={<Navigate to="/economics" replace />} />`);
    }
    const nav = src("../components/nav-config.tsx");
    expect(nav).not.toContain('path: "/depin"');
    expect(nav).not.toContain('path: "/swf"');
  });

  it("the rate schedule pages call the gateway once-prefixed (readmodels #2697)", () => {
    for (const page of ["RateSchedulePublishPage.tsx", "RateScheduleViewPage.tsx"]) {
      const text = src(page);
      expect(text, page).not.toMatch(/api(Get|Post)(<[^>]*>)?\(\s*["'`]\/api\/contributors/);
    }
  });
});
