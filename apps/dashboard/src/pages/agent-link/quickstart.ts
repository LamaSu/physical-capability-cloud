import claudeScript from "./pcc-agent.js.txt?raw";
import openaiScript from "./pcc-agent-openai.js.txt?raw";

/**
 * The quickstart scripts AgentLinkPage shows for the user to copy or download
 * and run with node. The dashboard never runs them: they are text, kept in
 * text assets rather than code, because they build the Authorization header
 * the user's agent will send, and no dashboard module may (N50, astra A03c
 * F1; __tests__/no-direct-auth-headers.test.ts).
 */

/** Where each script's first message goes, as a JavaScript string literal. */
const FIRST_MESSAGE = "__PCC_FIRST_MESSAGE__";
const DEFAULT_FIRST_MESSAGE = "I have equipment to put on the network. Help me get set up.";

/**
 * The script for `sdk`, with `capability` (the page's ?q=) as the agent's
 * first message. It goes in as a JSON string literal, so no ?q= can add code
 * to a script the user runs.
 */
export function quickstartScript(sdk: "claude" | "openai", capability: string): string {
  const script = sdk === "claude" ? claudeScript : openaiScript;
  // A replacer function: a replacement string would expand $& and $1 in the capability.
  return script.replace(FIRST_MESSAGE, () => JSON.stringify(capability || DEFAULT_FIRST_MESSAGE));
}
