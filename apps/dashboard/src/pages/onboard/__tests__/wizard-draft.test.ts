import { describe, it, expect } from "vitest";
import {
  wizardDraft,
  withPriceField,
  isPricingEntered,
  EMPTY_PRICING,
  type WizardDraftInput,
} from "../wizard-draft.js";
import { useOnboardWizardStore } from "../../../stores/onboard-wizard-store.js";

const EMPTY: WizardDraftInput = {
  identity: { name: "", category: "", manufacturer: "", model: "" },
  documents: [],
  capabilities: [],
  pricing: null,
  operatorName: "",
  certifications: [],
};

describe("wizardDraft", () => {
  it("contains only what the user entered", () => {
    const draft = wizardDraft({
      ...EMPTY,
      identity: { name: "Shop Prusa", category: "fdm-printing", manufacturer: "Prusa", model: "MK4" },
      capabilities: [{ type: "fdm-printing", name: "PLA prints" }],
      documents: [{ filename: "mk4-datasheet.pdf" }],
      pricing: { baseCost: "12", minimum: "", currency: "USDC" },
      operatorName: "Ada",
    });
    expect(draft).toBe(
      [
        "I want to offer a machine on PCC.",
        "- Machine name: Shop Prusa",
        "- Category: fdm-printing",
        "- Manufacturer: Prusa",
        "- Model: MK4",
        "- Capabilities: PLA prints",
        "- Documents: mk4-datasheet.pdf",
        "- Base price: 12 USDC",
        "- Operator: Ada",
      ].join("\n"),
    );
  });

  it("adds nothing for steps the user skipped", () => {
    expect(wizardDraft(EMPTY)).toBe("I want to offer a machine on PCC.");
  });
});

describe("pricing input", () => {
  it("starts empty, never from example values", () => {
    expect(withPriceField(null, "baseCost", "")).toEqual(EMPTY_PRICING);
    expect(withPriceField(null, "baseCost", "7.5")).toEqual({ ...EMPTY_PRICING, baseCost: "7.5" });
  });

  it("drops an optional rate the user cleared", () => {
    const withRate = withPriceField(null, "perMinute", "0.4");
    expect(withRate.perMinute).toBe("0.4");
    expect("perMinute" in withPriceField(withRate, "perMinute", "")).toBe(false);
  });

  it.each([
    [null, false],
    [{ ...EMPTY_PRICING }, false],
    [{ ...EMPTY_PRICING, baseCost: "0" }, false],
    [{ ...EMPTY_PRICING, baseCost: "-3" }, false],
    [{ ...EMPTY_PRICING, baseCost: "abc" }, false],
    [{ ...EMPTY_PRICING, baseCost: "12.50" }, true],
  ])("isPricingEntered(%j) is %s", (pricing, expected) => {
    expect(isPricingEntered(pricing)).toBe(expected);
  });
});

describe("wizard store validation", () => {
  it("does not demand space requirements the wizard no longer collects", () => {
    useOnboardWizardStore.getState().reset();
    expect(useOnboardWizardStore.getState().isStepValid(3)).toBe(true);
  });

  it("needs a price the user typed before the pricing step passes", () => {
    const store = useOnboardWizardStore.getState();
    store.reset();
    expect(useOnboardWizardStore.getState().isStepValid(4)).toBe(false);
    store.setPricing({ ...EMPTY_PRICING, baseCost: "" });
    expect(useOnboardWizardStore.getState().isStepValid(4)).toBe(false);
    store.setPricing({ ...EMPTY_PRICING, baseCost: "15" });
    expect(useOnboardWizardStore.getState().isStepValid(4)).toBe(true);
  });
});
