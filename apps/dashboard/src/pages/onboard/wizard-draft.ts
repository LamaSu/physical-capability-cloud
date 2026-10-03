import type {
  MachineCapabilityDef,
  OnboardingDocument,
  OperatorCertification,
  PricingConfig,
} from "@pcc/spec";
import { buildOnboardChatDraft } from "../../lib/onboard-handoff.js";

// Pure helpers for the onboarding wizard's PX-10 Wave 0 behaviour: the review
// step hands the user's own entries to /onboard/chat, and pricing holds only
// what the user typed. Kept free of UI imports so they are testable in node.

export interface WizardDraftInput {
  identity: { name: string; category: string; manufacturer: string; model: string };
  documents: Pick<OnboardingDocument, "filename">[];
  capabilities: Pick<MachineCapabilityDef, "type" | "name">[];
  pricing: PricingConfig | null;
  operatorName: string;
  certifications: Pick<OperatorCertification, "name">[];
}

function money(amount: string | undefined, currency: string): string {
  return amount ? `${amount} ${currency}` : "";
}

/** Only what the user entered in the wizard; nothing invented. */
export function wizardDraft(input: WizardDraftInput): string {
  const { identity, documents, capabilities, pricing, operatorName, certifications } = input;
  const currency = pricing?.currency ?? "USDC";
  return buildOnboardChatDraft("I want to offer a machine on PCC.", [
    { label: "Machine name", value: identity.name },
    { label: "Category", value: identity.category },
    { label: "Manufacturer", value: identity.manufacturer },
    { label: "Model", value: identity.model },
    { label: "Capabilities", value: capabilities.map((c) => c.name || c.type).join(", ") },
    { label: "Documents", value: documents.map((d) => d.filename).join(", ") },
    { label: "Base price", value: money(pricing?.baseCost, currency) },
    { label: "Minimum price", value: money(pricing?.minimum, currency) },
    { label: "Per minute", value: money(pricing?.perMinute, currency) },
    { label: "Per gram", value: money(pricing?.perGram, currency) },
    { label: "Operator", value: operatorName },
    { label: "Certifications", value: certifications.map((c) => c.name).join(", ") },
  ]);
}

export type PriceField = "baseCost" | "minimum" | "perMinute" | "perGram";

export const EMPTY_PRICING: PricingConfig = { baseCost: "", minimum: "", currency: "USDC" };

/** The user's pricing with one field changed. Starts empty, never from examples. */
export function withPriceField(pricing: PricingConfig | null, key: PriceField, value: string): PricingConfig {
  const next: PricingConfig = { ...(pricing ?? EMPTY_PRICING), [key]: value };
  if ((key === "perMinute" || key === "perGram") && value === "") delete next[key];
  return next;
}

/** A price the user typed: a positive base cost. */
export function isPricingEntered(pricing: PricingConfig | null): boolean {
  if (pricing === null || pricing.baseCost === "") return false;
  const base = Number(pricing.baseCost);
  return Number.isFinite(base) && base > 0;
}
