import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { OnboardHandoffPanel } from "../OnboardHandoffPanel.js";

function render(props: React.ComponentProps<typeof OnboardHandoffPanel>): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <OnboardHandoffPanel {...props} />
    </MemoryRouter>,
  );
}

const DRAFT = "I want to offer a machine on PCC.\n- Machine name: Shop Prusa";

describe("OnboardHandoffPanel", () => {
  it("says plainly that nothing was registered", () => {
    const html = render({ draft: DRAFT });
    expect(html).toContain("Nothing was registered");
    expect(html).toContain("Your machine is not on the network.");
    expect(html).toContain("can&#x27;t register machines yet");
  });

  it("names the machine when the user named it", () => {
    expect(render({ draft: DRAFT, machineLabel: "Shop Prusa" })).toContain(
      "Shop Prusa is not on the network.",
    );
  });

  it("shows the draft for copying", () => {
    const html = render({ draft: DRAFT });
    expect(html).toContain("- Machine name: Shop Prusa");
    expect(html).toContain("Copy details");
  });

  it("links to the onboarding chat", () => {
    const html = render({ draft: DRAFT });
    expect(html).toContain('href="/onboard/chat"');
    expect(html).toContain("Continue in the onboarding chat");
  });

  it("claims no success of any kind", () => {
    const html = render({ draft: DRAFT, machineLabel: "Shop Prusa" }).toLowerCase();
    for (const claim of [
      "you're live",
      "you&#x27;re live",
      "registered successfully",
      "machine registered",
      "setup complete",
      "has been added",
      "is on the network",
    ]) {
      expect(html).not.toContain(claim);
    }
  });
});
