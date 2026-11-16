// @vitest-environment jsdom
/**
 * /order.html (pizza demo): a rejected order must not render in the success colour, and every
 * form field has a label tied to it. Static checks on the shipped file (its script opens a live
 * event stream, so it is not run here).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HTML = readFileSync(resolve(__dirname, "../../../public/order.html"), "utf8");
const doc = new DOMParser().parseFromString(HTML, "text/html");

describe("/order.html", () => {
  it("ties every form label to an existing field", () => {
    const labels = Array.from(doc.querySelectorAll("#step1 label"));
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) {
      const id = l.getAttribute("for");
      expect(id, l.textContent ?? "").toBeTruthy();
      expect(doc.getElementById(id!), `label for=${id}`).not.toBeNull();
    }
  });

  it("styles a rejected order as a failure and an unknown status as neutral, never success", () => {
    expect(HTML).toMatch(/\.status-card \.big\[data-tone="bad"\]\{color:var\(--danger\)\}/);
    expect(HTML).toMatch(/\.status-card \.big\[data-tone="unknown"\]\{color:var\(--muted\)\}/);
    expect(HTML).toMatch(/o\.status==="rejected"\?"bad"/);
    expect(HTML).toMatch(/\$\("#statusTitle"\)\.dataset\.tone=tone\|\|""/);
  });

  it("announces status changes", () => {
    expect(doc.getElementById("statusTitle")?.getAttribute("aria-live")).toBe("polite");
  });
});
