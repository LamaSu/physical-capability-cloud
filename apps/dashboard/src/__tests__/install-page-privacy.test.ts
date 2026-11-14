/**
 * product-qa #33: public/install.html posted each feedback submission (the
 * user's email, message, full page URL and user agent) to the third-party
 * formsubmit.co as well as to the gateway. The page must talk only to its own
 * origin. Read as text: install.html is a static file with inline script.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, "../../public/install.html"), "utf-8");

describe("install.html sends nothing to third parties", () => {
  it("has no formsubmit.co (or any form-relay) endpoint", () => {
    expect(html.toLowerCase()).not.toContain("formsubmit");
  });

  it("fetches only same-origin paths", () => {
    const targets = [...html.matchAll(/fetch\(\s*(['"`])([^'"`]*)\1/g)].map((m) => m[2]);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target, target).toMatch(/^\//);
    }
  });

  it("loads no third-party script, image, stylesheet or frame", () => {
    const loads = [
      ...html.matchAll(/<(script|img|iframe)\b[^>]*\bsrc\s*=\s*["'](https?:)?\/\/[^"']+["']/gi),
      ...html.matchAll(/<link\b[^>]*\bhref\s*=\s*["'](https?:)?\/\/[^"']+["']/gi),
      ...html.matchAll(/<form\b[^>]*\baction\s*=\s*["'](https?:)?\/\/[^"']+["']/gi),
    ].map((m) => m[0]);
    expect(loads).toEqual([]);
  });

  it("does not embed a personal email address", () => {
    expect(html).not.toMatch(/[A-Za-z0-9._%+-]+@gmail\.com/);
  });

  it("posts feedback to the gateway's /api/feedback", () => {
    expect(html).toMatch(/fetch\(\s*['"]\/api\/feedback['"]/);
  });

  it("describes what the gateway does with the message, without false limits", () => {
    const note = html.match(/<p class="privacy">([\s\S]*?)<\/p>/)?.[1] ?? "";
    expect(note).toContain("PCC gateway");
    expect(note).toContain("IP address");
    expect(note).toContain("Discord");
    expect(note).not.toContain("Nothing else");
    expect(note).not.toContain("10 submissions per hour");
  });
});
