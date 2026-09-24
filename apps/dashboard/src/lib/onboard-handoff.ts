/**
 * Onboarding hand-off (PX-10 Wave 0, product-steward #2386, decision D3).
 *
 * /start, the /onboard/wizard review step and /setup/agent cannot register a
 * machine yet. They used to register a mock adapter (or onto kernel_dev_001)
 * and then report success. Now they say plainly that nothing was registered
 * and hand what the user typed to the canonical entry, /onboard/chat.
 *
 * Nothing in this module talks to the network or registers anything.
 */

export const ONBOARD_CHAT_PATH = "/onboard/chat";

/**
 * Router-state key carrying the draft to /onboard/chat. The chat page does not
 * read it yet, so the hand-off panel always shows the draft for copying too.
 */
export const ONBOARD_DRAFT_STATE_KEY = "onboardDraft";

export interface HandoffField {
  label: string;
  value: string | number | null | undefined;
}

/**
 * A plain-text summary of what the user entered, to paste into the onboarding
 * chat. Empty values are left out. Only pass values the user actually entered
 * or chose; never defaults or example data.
 */
export function buildOnboardChatDraft(intro: string, fields: HandoffField[]): string {
  const lines = fields
    .map((f) => ({
      label: f.label.trim(),
      value: f.value === null || f.value === undefined ? "" : String(f.value).trim(),
    }))
    .filter((f) => f.label !== "" && f.value !== "")
    .map((f) => `- ${f.label}: ${f.value}`);
  return [intro.trim(), ...lines].filter((line) => line !== "").join("\n");
}

/** A machine configuration the user confirmed (for example on /setup/agent). */
export interface ConfirmedMachineConfig {
  make?: string;
  model?: string;
  type?: string;
  adapterType?: string;
  url?: string;
}

export function machineConfigDraft(config: ConfirmedMachineConfig): string {
  return buildOnboardChatDraft("I want to add a machine to PCC.", [
    { label: "Make", value: config.make },
    { label: "Model", value: config.model },
    { label: "Type", value: config.type },
    { label: "Connection", value: config.adapterType },
    { label: "Address", value: config.url },
  ]);
}

export function onboardChatState(draft: string): Record<string, string> {
  return { [ONBOARD_DRAFT_STATE_KEY]: draft };
}
