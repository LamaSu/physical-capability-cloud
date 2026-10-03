/**
 * PX-10 Wave 0 (product-steward #2386 and #2561, product-qa #31 and #32,
 * shell #2544): onboarding pages that cannot register a machine must not
 * pretend to, and must not show invented data as the user's.
 *
 * The dashboard has no DOM test runtime, so, like OnboardLandingPage.test.tsx,
 * this reads the page sources as text. Comments are stripped first, so the
 * notes that explain the old behaviour do not count.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { startPageDraft, type FormState } from "../StartPage.js";

const here = dirname(fileURLToPath(import.meta.url));

function code(rel: string): string {
  return readFileSync(resolve(here, "..", rel), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const REGISTERING_SURFACES = ["StartPage.tsx", "onboard/Step7_Review.tsx", "SetupAgentPage.tsx"];
const WIZARD_STEPS = [
  "onboard/Step2_Documentation.tsx",
  "onboard/Step4_PhysicalSpace.tsx",
  "onboard/Step5_Pricing.tsx",
  "onboard/Step6_Operator.tsx",
];

describe("surfaces that cannot register a machine register nothing", () => {
  it.each(REGISTERING_SURFACES)("%s calls no registration or test-job endpoint", (rel) => {
    const src = code(rel);
    for (const endpoint of [
      "/setup/register-device",
      "/devices/register",
      "/setup/test-job",
      "/setup/generate-config",
    ]) {
      expect(src).not.toContain(endpoint);
    }
  });

  it.each(REGISTERING_SURFACES)("%s uses no placeholder adapter or shared dev kernel", (rel) => {
    const src = code(rel);
    expect(src).not.toMatch(/adapter(Type|Kind)?\s*:\s*["']mock["']/);
    expect(src).not.toMatch(/kernel_dev_/);
    expect(src).not.toMatch(/mockMode/);
  });

  it.each(REGISTERING_SURFACES)("%s ends at the hand-off to /onboard/chat", (rel) => {
    expect(code(rel)).toContain("OnboardHandoffPanel");
  });
});

describe("no success is claimed that the server did not confirm", () => {
  it.each([...REGISTERING_SURFACES, "SetupWizardPage.tsx"])("%s", (rel) => {
    const src = code(rel);
    for (const claim of [
      "You're live",
      "Go live",
      "Machine Registered",
      "machine has been registered",
      "Device registered successfully",
      "Setup complete!",
      "Setup Complete!",
      "has been added to the PCC network",
      "would look like",
      "duration: 1234",
      "registers your identity",
      "no platform fees",
    ]) {
      expect(src, claim).not.toContain(claim);
    }
  });
});

describe("wizard steps show only what the user entered", () => {
  it.each(WIZARD_STEPS)("%s uses no mock onboarding data and no random values", (rel) => {
    const src = code(rel);
    expect(src).not.toContain("mock-onboarding-data");
    expect(src).not.toContain("Math.random");
  });

  it("documentation records the real hash and runs no pretend analysis", () => {
    const src = code("onboard/Step2_Documentation.tsx");
    expect(src).toContain("sha256OfBlob");
    expect(src).not.toContain("setTimeout");
    expect(src).not.toContain("Build volume: 250");
  });

  it("pricing is typed by the user, with no invented market rate", () => {
    const src = code("onboard/Step5_Pricing.tsx");
    expect(src).not.toContain("readOnly");
    expect(src).not.toContain("networkAvg");
    expect(src).not.toContain("MarketRateCard");
    expect(src).not.toContain("generateROIProjection");
  });
});

describe("the setup wizard does not pass a failed validation", () => {
  const src = code("SetupWizardPage.tsx");
  const body = src.slice(src.indexOf("const handleNext = async () => {"), src.indexOf("const handleSkip"));

  it("stops before completing when the gateway says the setup is not valid", () => {
    const invalid = body.indexOf("if (!validation.valid)");
    const complete = body.indexOf("completeSetup()");
    expect(invalid).toBeGreaterThan(-1);
    expect(complete).toBeGreaterThan(invalid);
    expect(body.slice(invalid, complete)).toContain("return;");
  });

  it("does not complete setup when the gateway is unreachable or errors", () => {
    const catchBlock = body.slice(body.indexOf("} catch (err) {"), body.indexOf("} finally {"));
    expect(catchBlock.length).toBeGreaterThan(0);
    expect(catchBlock).not.toContain("completeSetup");
    expect(catchBlock).not.toContain("nextStep");
  });
});

describe("/start's hand-off draft", () => {
  const base: FormState = {
    category: "3d-printing",
    description: "PLA and PETG parts",
    machineName: "Shop Prusa",
    connectionType: "octoprint",
    connectionUrl: "http://192.168.1.50",
    rate: "12",
    rateUnit: "hour",
  };

  it("carries what the user entered", () => {
    expect(startPageDraft(base)).toBe(
      [
        "I want to offer a machine on PCC.",
        "- Capability: 3D Printing",
        "- What it does: PLA and PETG parts",
        "- Machine name: Shop Prusa",
        "- Connection: OctoPrint",
        "- Connection address: http://192.168.1.50",
        "- Rate: $12 per hour",
      ].join("\n"),
    );
  });

  it("leaves out an address for a manual connection and a rate never entered", () => {
    const draft = startPageDraft({ ...base, connectionType: "manual", connectionUrl: "stale", rate: "" });
    expect(draft).toContain("- Connection: Manual");
    expect(draft).not.toContain("Connection address");
    expect(draft).not.toContain("Rate");
  });
});
