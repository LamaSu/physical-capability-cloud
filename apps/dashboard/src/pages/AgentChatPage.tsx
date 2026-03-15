import React, { useCallback } from "react";
import { useUIStore } from "../stores/ui-store.js";
import { useChatStore } from "../stores/chat-store.js";
import { agentTools } from "../agent/agent-tools.js";
import { ChatMessageList } from "../components/chat/ChatMessageList.js";
import { ChatInput } from "../components/chat/ChatInput.js";
import { useAgentSSE } from "../hooks/use-agent-sse.js";
import type { SuggestedAction } from "../agent/agent-types.js";

export function AgentChatPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { messages, chatState, streamingText, addMessage, setChatState } = useChatStore();

  React.useEffect(() => {
    setPageMeta("PCC Network", "Agent-first physical capability protocol");
  }, [setPageMeta]);

  useAgentSSE(true);

  const handleSend = useCallback((text: string) => {
    if (text === "/dashboard") {
      useUIStore.getState().setMode("dashboard");
      return;
    }

    if (text === "/tools") {
      addMessage({ role: "user", content: "Show me the tools" });
      const toolList = agentTools.map((t) => `- **${t.name}** — ${t.description}`).join("\n");
      addMessage({
        role: "assistant",
        content: `**PCC Network Tools** (${agentTools.length} tools)\n\nThese are the tools your agent gets from the agent package:\n\n${toolList}\n\n**Fetch the full spec:**\n\`\`\`\nGET /agent-package.json\n\`\`\`\n\nEach tool maps to a REST endpoint. Your agent calls them directly — no proxy, no middleware.`,
        suggestedActions: [
          { label: "How it works", message: "/how" },
          { label: "Get the package", message: "/package" },
          { label: "Try an endpoint", message: "/try" },
        ],
      });
      return;
    }

    if (text === "/how") {
      addMessage({ role: "user", content: "How does PCC work?" });
      addMessage({
        role: "assistant",
        content: `**How PCC Works**

**The Problem**
Physical machines have capabilities (3D printing, CNC machining, chemical analysis) but no standard way to make them discoverable, priceable, or verifiable by AI agents.

**The Solution**
PCC wraps every physical capability in a verifiable on-chain skill:

1. **Register** — Machine capabilities become soulbound NFTs (Metaplex Core + PermanentFreezeDelegate)
2. **Discover** — Agents search the network for capabilities that match their needs
3. **Price** — Meteora DLMM pools provide real-time supply/demand pricing per capability type
4. **Contract** — Agent builds a job contract with parameters, assurance tier, and milestone escrow
5. **Execute** — Shop Kernel runs the job, emitting encrypted evidence (Lit Protocol → IPFS via Helia)
6. **Verify** — Bittensor subnet miners verify evidence quality via Yuma Consensus
7. **Settle** — MilestoneEscrow on Base Sepolia releases funds when milestones are met

**For Your Agent**
\`\`\`
curl https://pcc-gateway-production.up.railway.app/agent-package.json
\`\`\`

That gives your agent a system prompt + 28 tools + endpoint mappings. Feed it to any LLM. Your agent calls PCC's API endpoints directly.

**The Stack**
- Identity: W3C DIDs + Verifiable Credentials
- Certificates: Metaplex Core soulbound NFTs
- Pricing: Meteora DLMM pools
- Evidence: Lit Protocol encryption → IPFS (Helia)
- Verification: Bittensor subnet
- Settlement: MilestoneEscrow (Base Sepolia)
- Payments: Solana USDC + x402 micropayments
- Rewards: DePIN epoch-based distribution`,
        suggestedActions: [
          { label: "See the tools", message: "/tools" },
          { label: "Get the package", message: "/package" },
          { label: "Try an endpoint", message: "/try" },
        ],
      });
      return;
    }

    if (text === "/package") {
      addMessage({ role: "user", content: "Get the agent package" });
      addMessage({
        role: "assistant",
        content: `**Agent Package**

One JSON file. Everything your agent needs.

\`\`\`
GET /agent-package.json
\`\`\`

**What's inside:**
- \`system_prompt\` — Domain knowledge for any LLM
- \`tools[]\` — 28 tool definitions with \`name\`, \`description\`, \`input_schema\`, and \`endpoint\` (method + path)
- \`quickstart.claude\` — Copy-paste code for Claude SDK
- \`quickstart.openai\` — Copy-paste code for OpenAI SDK

**How your agent uses it:**
1. Fetch the package
2. Pass \`system_prompt\` as the system message
3. Pass \`tools[]\` as tool definitions (Claude format or convert to OpenAI function calling)
4. When the LLM returns a tool call, look up the tool's \`endpoint\` and call it
5. Feed the API response back as a tool result
6. Repeat

No SDK. No auth. No vendor lock-in. Any LLM, any framework, any language.`,
        suggestedActions: [
          { label: "See the tools", message: "/tools" },
          { label: "How it works", message: "/how" },
          { label: "Try an endpoint", message: "/try" },
        ],
      });
      return;
    }

    if (text === "/try") {
      addMessage({ role: "user", content: "Try a PCC endpoint" });
      setChatState("sending");

      fetch("/api/kernels")
        .then((r) => r.json())
        .then((data) => {
          const kernels = (data.kernels ?? []) as Array<Record<string, unknown>>;
          const display = kernels.length > 0
            ? kernels.map((k) => `- **${k.name}** (${k.id}) — ${k.status}, ${(k.capabilities as unknown[])?.length ?? 0} capabilities`).join("\n")
            : "No kernels returned (gateway may not be running locally)";

          addMessage({
            role: "assistant",
            content: `**Live API Response** — \`GET /api/kernels\`\n\n${display}\n\nThis is what your agent gets when it calls \`list_kernels\`. Every tool in the package maps to an endpoint like this.`,
            suggestedActions: [
              { label: "Try capabilities", message: "/try-capabilities" },
              { label: "Try jobs", message: "/try-jobs" },
              { label: "Get the package", message: "/package" },
            ],
          });
          setChatState("idle");
        })
        .catch((err) => {
          addMessage({ role: "assistant", content: `API call failed: ${err.message}. The gateway needs to be running for live endpoints.` });
          setChatState("idle");
        });
      return;
    }

    if (text === "/try-capabilities") {
      addMessage({ role: "user", content: "Try capabilities endpoint" });
      setChatState("sending");
      fetch("/api/capabilities/types")
        .then((r) => r.json())
        .then((data) => {
          addMessage({
            role: "assistant",
            content: `**Live API Response** — \`GET /api/capabilities/types\`\n\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 500)}\n\`\`\``,
            suggestedActions: [{ label: "Try jobs", message: "/try-jobs" }, { label: "Get the package", message: "/package" }],
          });
          setChatState("idle");
        })
        .catch(() => { addMessage({ role: "system", content: "Endpoint not reachable" }); setChatState("idle"); });
      return;
    }

    if (text === "/try-jobs") {
      addMessage({ role: "user", content: "Try jobs endpoint" });
      setChatState("sending");
      fetch("/api/jobs")
        .then((r) => r.json())
        .then((data) => {
          addMessage({
            role: "assistant",
            content: `**Live API Response** — \`GET /api/jobs\`\n\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 500)}\n\`\`\``,
            suggestedActions: [{ label: "Try kernels", message: "/try" }, { label: "Get the package", message: "/package" }],
          });
          setChatState("idle");
        })
        .catch(() => { addMessage({ role: "system", content: "Endpoint not reachable" }); setChatState("idle"); });
      return;
    }

    // Default: explain what this is
    addMessage({ role: "user", content: text });
    addMessage({
      role: "assistant",
      content: `This is the PCC Network portal — not a chatbot. Your AI agent connects to PCC by fetching the agent package and calling the API directly.\n\nTry one of these:`,
      suggestedActions: [
        { label: "What is PCC?", message: "/how" },
        { label: "See the tools", message: "/tools" },
        { label: "Get the agent package", message: "/package" },
        { label: "Try a live endpoint", message: "/try" },
      ],
    });
  }, [addMessage, setChatState]);

  return (
    <div className="flex flex-col h-full">
      <ChatMessageList
        messages={messages}
        streamingText={streamingText}
        chatState={chatState}
        onQuickAction={handleSend}
      />
      <ChatInput
        onSend={handleSend}
        disabled={chatState !== "idle"}
        placeholder="Type /tools, /how, /package, or /try..."
      />
    </div>
  );
}
