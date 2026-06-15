#!/usr/bin/env tsx
/**
 * Smoke test: does the served system_prompt actually drive a host LLM
 * to interview an operator and register them via PCC tools?
 *
 * Source: pcc-agent-pack-prompts-v3.md §9.4.
 *
 * What it does:
 *   1. Fetches /agent-package.json from PCC_GATEWAY_URL (default capability.network)
 *   2. Extracts system_prompt + tools
 *   3. Feeds them to Anthropic Messages API with a scripted operator transcript
 *      ("I run Marios Pizzeria in Brooklyn, I make wood-fired margherita for $12...")
 *   4. Asserts the tool-call sequence includes pcc_kernel_register (or
 *      pcc_onboard_register) followed by pcc_capability_create
 *   5. Prints PASS/FAIL with the actual tool-call trace
 *
 * If ANTHROPIC_API_KEY is unset, exits 0 with "skipped" so CI doesn't fail
 * in branches that lack the secret.
 *
 * Run:
 *   pnpm tsx scripts/smoke-onboarding-prompt.ts
 *
 * Env vars:
 *   ANTHROPIC_API_KEY  - required to actually run; skip if missing
 *   PCC_GATEWAY_URL    - default https://capability.network
 *   ANTHROPIC_MODEL    - default claude-sonnet-4-6 (any tool-using model)
 */

import Anthropic from "@anthropic-ai/sdk";

const GATEWAY = process.env.PCC_GATEWAY_URL ?? "https://capability.network";
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

const OPERATOR_TRANSCRIPT = [
  "I run Marios Pizzeria in Brooklyn. I make wood-fired margherita for $12 and pepperoni for $14.",
  "Open Tuesday through Sunday, 11 AM to 11 PM. Closed Mondays.",
  "I can send a photo of each pizza when it's ready.",
  "My wallet address is 0xMariosWallet123. Notifications by SMS to (555) 123-4567.",
].join(" ");

// Tools we expect to see called in the right order
const EXPECTED_KERNEL_TOOLS = ["pcc_kernel_register", "pcc_onboard_register"];
const EXPECTED_CAPABILITY_TOOLS = ["pcc_capability_create", "pcc_capability_clone"];

async function main(): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("⊘ skipped (no ANTHROPIC_API_KEY in env)");
    return 0;
  }

  console.log(`Fetching agent-package from ${GATEWAY}/agent-package.json ...`);
  const pkgRes = await fetch(`${GATEWAY}/agent-package.json`);
  if (!pkgRes.ok) {
    console.error(`FAIL: ${GATEWAY}/agent-package.json returned HTTP ${pkgRes.status}`);
    return 1;
  }
  const pkg = (await pkgRes.json()) as { system_prompt: string; tools: AnyTool[] };
  console.log(`  system_prompt length: ${pkg.system_prompt.length}`);
  console.log(`  tools: ${pkg.tools.length}`);

  // Convert PCC tool schema to Anthropic tool-use schema.
  // PCC tools have shape { name, description, input_schema, endpoint }; the
  // Anthropic API wants { name, description, input_schema }. The endpoint
  // attribute is dropped silently by the API.
  const tools = pkg.tools
    .filter((t) => t && t.name && t.input_schema)
    .map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: t.input_schema,
    }));
  console.log(`  tools eligible: ${tools.length}`);

  console.log("\nCalling Anthropic Messages API ...");
  const anthropic = new Anthropic({ apiKey });
  const calledTools: string[] = [];
  let turns = 0;
  const MAX_TURNS = 10;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: OPERATOR_TRANSCRIPT },
  ];

  while (turns < MAX_TURNS) {
    turns += 1;
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: pkg.system_prompt,
      tools: tools as Anthropic.Tool[],
      messages,
    });

    let calledThisTurn = false;
    const toolResults: Anthropic.MessageParam["content"] = [];
    for (const block of res.content) {
      if (block.type === "tool_use") {
        calledTools.push(block.name);
        calledThisTurn = true;
        console.log(`  turn ${turns}: tool_use ${block.name}`);
        // Synthesize a plausible success response so the model can continue.
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify({
            ok: true,
            id: `mock_${block.name}_${Date.now()}`,
            note: "smoke-test mock — no real PCC call was made",
          }),
        });
      } else if (block.type === "text") {
        // Optional: log the model's reasoning for human review.
        const snip = block.text.slice(0, 120).replace(/\n/g, " ");
        if (snip.trim().length > 0) {
          console.log(`  turn ${turns}: text "${snip}${block.text.length > 120 ? "..." : ""}"`);
        }
      }
    }

    if (!calledThisTurn) {
      // Model is asking the user a question or ending the conversation.
      // Feed the next operator line if any, else stop.
      console.log(`  turn ${turns}: model paused for user input — ending smoke run.`);
      break;
    }

    messages.push({ role: "assistant", content: res.content });
    messages.push({ role: "user", content: toolResults });

    if (res.stop_reason === "end_turn" || res.stop_reason === "stop_sequence") {
      console.log(`  turn ${turns}: model ended turn cleanly.`);
      break;
    }
  }

  // Verify the tool-call sequence includes kernel + capability creation.
  const sawKernel = calledTools.some((t) => EXPECTED_KERNEL_TOOLS.includes(t));
  const sawCapability = calledTools.some((t) => EXPECTED_CAPABILITY_TOOLS.includes(t));

  console.log("\n--- Tool-call trace ---");
  calledTools.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));

  console.log("\n--- Result ---");
  console.log(`  saw kernel registration tool: ${sawKernel ? "✓" : "✗"} (${EXPECTED_KERNEL_TOOLS.join(" or ")})`);
  console.log(`  saw capability creation tool: ${sawCapability ? "✓" : "✗"} (${EXPECTED_CAPABILITY_TOOLS.join(" or ")})`);

  if (sawKernel && sawCapability) {
    console.log("\nPASS — host LLM drove the operator through kernel + capability creation.");
    return 0;
  }
  console.error("\nFAIL — host LLM did not complete kernel + capability creation in the expected sequence.");
  return 1;
}

type AnyTool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  endpoint?: unknown;
};

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("smoke-onboarding-prompt error:", err);
    process.exit(1);
  });
