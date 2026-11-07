// @vitest-environment node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publishedText } from "../../lib/public-claims.js";

const here = dirname(fileURLToPath(import.meta.url));

function sourcePath(path: string): string {
  return resolve(here, "../../", path);
}

function readSource(path: string): string {
  return publishedText(`apps/dashboard/src/${path}`, readFileSync(sourcePath(path), "utf8"));
}

const surfaces = [
  "pages/onboard/Step7_Review.tsx",
  "pages/StartPage.tsx",
  "pages/SetupAgentPage.tsx",
].map((path) => ({ path, source: readSource(path) }));

describe("T2a: onboarding surfaces send no registration", () => {
  it("contains none of the four registration or test-job routes", () => {
    for (const { path, source } of surfaces) {
      for (const route of ["/setup/generate-config", "/setup/register-device", "/devices/register", "/setup/test-job"]) {
        expect(source, path).not.toContain(route);
      }
    }
  });

  it("contains no mock adapter string literal", () => {
    for (const { path, source } of surfaces) expect(source, path).not.toMatch(/(["'`])mock\1/);
  });

  it("contains no mockMode", () => {
    for (const { path, source } of surfaces) expect(source, path).not.toContain("mockMode");
  });

  it("contains no development kernel identifier", () => {
    for (const { path, source } of surfaces) expect(source, path).not.toContain("kernel_dev_");
  });

  it("sets no kernelId to a literal", () => {
    for (const { path, source } of surfaces) expect(source, path).not.toMatch(/\bkernelId\s*[:=]\s*["'`]/);
  });
});

describe("T2b: removed onboarding copy", () => {
  it("SetupAgentPage removes unsupported help and greeting claims", () => {
    const source = readSource("pages/SetupAgentPage.tsx");
    expect(source).not.toContain("  - Generate kernel configurations");
    expect(source).not.toContain("  - Register devices and run test jobs");
    expect(source).not.toContain("I'll guide you through adding a machine");
  });

  it("StartPage removes the rate note and platform fee copy", () => {
    const source = readSource("pages/StartPage.tsx");
    expect(source).not.toContain("You keep 100%");
    expect(source).not.toMatch(/platform fee/i);
  });
});

describe("T2c: the shared chat handoff", () => {
  it("offers one plain chat link and transfers no data", () => {
    const path = "components/onboard/OnboardChatHandoff.tsx";
    expect(existsSync(sourcePath(path))).toBe(true);
    const source = readSource(path);
    expect(source.match(/<Link\b/g)).toHaveLength(1);
    const destinations = [...source.matchAll(/\bto\s*=\s*("[^"]*"|'[^']*'|\{[^}]*\}|[^\s>]+)/g)];
    expect(destinations).toHaveLength(1);
    for (const destination of destinations) expect(destination[1]).toBe('"/onboard/chat"');
    expect(source).not.toMatch(/\bstate\s*=/);
    for (const forbidden of ["useNavigate", "navigate(", "localStorage", "sessionStorage", "fetch", "apiPost"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("T2d: inbound onboarding copy", () => {
  it("OnboardChatPage states that registration is unavailable", () => {
    const source = readSource("pages/OnboardChatPage.tsx");
    expect(source).toContain("Tell me what you do. Registration isn't available here yet.");
    expect(source).not.toContain("I'll register it");
  });

  it("SetupWizardPage offers Describe a Machine", () => {
    const source = readSource("pages/SetupWizardPage.tsx");
    expect(source).toContain('label: "Describe a Machine", path: "/onboard/wizard"');
    expect(source).not.toContain('label: "Add a Machine"');
  });

  it("MarketplaceDetailPage offers to describe the equipment", () => {
    const source = readSource("pages/MarketplaceDetailPage.tsx");
    expect(source).toContain("Describe your {ec.name} &rarr;");
    expect(source).not.toContain("Register a {ec.name}");
  });
});
