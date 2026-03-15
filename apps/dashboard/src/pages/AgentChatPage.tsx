import React, { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useUIStore } from "../stores/ui-store.js";
import { useChatStore } from "../stores/chat-store.js";
import type { AgentConnection } from "../stores/chat-store.js";
import { sendAgentMessage, executeToolCall } from "../agent/agent-client.js";
import { extractCards } from "../agent/card-registry.js";
import { agentTools } from "../agent/agent-tools.js";
import { ChatMessageList } from "../components/chat/ChatMessageList.js";
import { ChatInput } from "../components/chat/ChatInput.js";
import { useAgentSSE } from "../hooks/use-agent-sse.js";
import type { ToolCall, SuggestedAction } from "../agent/agent-types.js";
import { GlassPanel } from "@pcc/ui";

// ---------------------------------------------------------------------------
// Connect Agent Modal
// ---------------------------------------------------------------------------

function ConnectAgentPanel({ onConnect, onClose }: {
  onConnect: (conn: AgentConnection) => void;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState<"claude" | "openai" | "custom">("claude");
  const [apiKey, setApiKey] = useState("");
  const [endpoint, setEndpoint] = useState("");

  const defaults: Record<string, string> = {
    claude: "https://api.anthropic.com/v1/messages",
    openai: "https://api.openai.com/v1/chat/completions",
    custom: "",
  };

  function handleConnect() {
    const ep = endpoint || defaults[provider];
    if (!ep || !apiKey) return;
    onConnect({ endpoint: ep, apiKey, provider, connected: true });
  }

  return (
    <GlassPanel className="p-5 space-y-4 max-w-md mx-auto">
      <div className="text-sm font-medium text-white/80">Connect Your Agent</div>
      <div className="text-xs text-white/40">
        Your API key stays in your browser — it's sent directly to your provider, never stored on PCC servers.
      </div>

      {/* Provider selector */}
      <div className="flex gap-2">
        {(["claude", "openai", "custom"] as const).map((p) => (
          <button
            key={p}
            onClick={() => { setProvider(p); setEndpoint(""); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              provider === p
                ? "bg-teal-500/15 border-teal-500/25 text-teal-300"
                : "bg-white/[0.03] border-white/[0.06] text-white/40 hover:text-white/60"
            }`}
          >
            {p === "claude" ? "Claude" : p === "openai" ? "OpenAI" : "Custom"}
          </button>
        ))}
      </div>

      {/* Endpoint */}
      {provider === "custom" && (
        <input
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="https://your-agent.example.com/v1/chat"
          className="w-full bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 placeholder-white/20 focus:outline-none focus:border-teal-500/30"
        />
      )}

      {/* API Key */}
      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={provider === "claude" ? "sk-ant-..." : provider === "openai" ? "sk-..." : "API key"}
        className="w-full bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 placeholder-white/20 focus:outline-none focus:border-teal-500/30"
      />

      <div className="flex gap-2">
        <button
          onClick={handleConnect}
          disabled={!apiKey}
          className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-teal-500/15 border border-teal-500/25 text-teal-300 hover:bg-teal-500/25 disabled:opacity-30 transition-all"
        >
          Connect
        </button>
        <button
          onClick={onClose}
          className="px-4 py-2 rounded-lg text-sm text-white/40 border border-white/[0.06] hover:text-white/60 transition-all"
        >
          Cancel
        </button>
      </div>
    </GlassPanel>
  );
}

// ---------------------------------------------------------------------------
// Agent Chat Page
// ---------------------------------------------------------------------------

export function AgentChatPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const {
    messages, chatState, streamingText, agentConnection,
    addMessage, updateMessage, appendStreamingText, clearStreamingText,
    setChatState, setAgentConnection,
  } = useChatStore();
  const [showConnect, setShowConnect] = useState(false);

  React.useEffect(() => {
    setPageMeta("PCC Network", "Connect your agent");
  }, [setPageMeta]);

  useAgentSSE(true);

  // Handle built-in commands + agent relay
  const handleSend = useCallback(async (text: string) => {
    // Built-in onboarding commands
    if (text === "/connect") {
      setShowConnect(true);
      return;
    }

    if (text === "/tools") {
      addMessage({ role: "user", content: "Show me the tool spec" });
      const toolList = agentTools.map((t) => `- **${t.name}**: ${t.description}`).join("\n");
      addMessage({
        role: "assistant",
        content: `**PCC Network Tools** (${agentTools.length} tools)\n\nYour agent gets these tools automatically when connected:\n\n${toolList}\n\nFetch the full spec programmatically:\n\`\`\`\nGET /api/agent/tools\n\`\`\`\n\nOr have your agent call tools directly:\n\`\`\`\nPOST /api/agent/execute\n{ "tool_name": "list_kernels", "tool_input": {} }\n\`\`\``,
        suggestedActions: [
          { label: "Connect my agent", message: "/connect" },
          { label: "How it works", message: "/how" },
        ],
      });
      return;
    }

    if (text === "/how") {
      addMessage({ role: "user", content: "How does PCC work?" });
      addMessage({
        role: "assistant",
        content: `**How PCC Works**

**The Network**
PCC connects **requesters** (who need manufacturing) with **operators** (who have machines). Every machine's capabilities are registered on-chain as soulbound NFTs (Metaplex Core).

**The Flow**
1. **Discover** — Your agent searches for capabilities (FDM printing, CNC machining, HPLC analysis...)
2. **Build Contract** — Configure parameters, get pricing from Meteora DLMM pools, set assurance tier
3. **Submit Workflow** — Contract goes on-chain via MilestoneEscrow (Base Sepolia)
4. **Execute** — Shop Kernel runs the job, emitting encrypted evidence (Lit Protocol → IPFS)
5. **Verify** — Bittensor subnet miners verify evidence quality
6. **Settle** — Escrow releases funds when milestones are met

**The Stack**
- **Identity**: W3C DIDs + Verifiable Credentials
- **Certificates**: Metaplex Core soulbound NFTs (PermanentFreezeDelegate)
- **Pricing**: Meteora DLMM pools (real-time supply/demand)
- **Evidence**: AES-256-GCM encryption (Lit Protocol) → IPFS (Helia)
- **Verification**: Bittensor subnet (Yuma Consensus)
- **Settlement**: MilestoneEscrow on Base Sepolia + x402 micropayments
- **Payments**: Solana USDC (SPL tokens) + EVM USDC
- **Rewards**: DePIN epoch-based distribution

**For Builders**
\`GET /api/agent/tools\` — Full tool spec (JSON)
\`POST /api/agent/execute\` — Execute any tool
\`POST /api/agent/chat\` — Relay to your agent with tools attached`,
        suggestedActions: [
          { label: "Connect my agent", message: "/connect" },
          { label: "View tools", message: "/tools" },
          { label: "Explore dashboard", message: "/dashboard" },
        ],
      });
      return;
    }

    if (text === "/dashboard") {
      useUIStore.getState().setMode("dashboard");
      return;
    }

    if (text === "/disconnect") {
      setAgentConnection(null);
      addMessage({
        role: "system",
        content: "Agent disconnected.",
        suggestedActions: [{ label: "Reconnect", message: "/connect" }],
      });
      return;
    }

    // ── Agent relay (requires connection) ──────────────────────
    if (!agentConnection?.connected) {
      addMessage({ role: "user", content: text });
      addMessage({
        role: "assistant",
        content: "No agent connected. Connect your AI agent to start interacting with the PCC network.",
        suggestedActions: [
          { label: "Connect my agent", message: "/connect" },
          { label: "View tools", message: "/tools" },
        ],
      });
      return;
    }

    // Send to user's connected agent via gateway relay
    addMessage({ role: "user", content: text });
    setChatState("sending");
    clearStreamingText();

    const allMessages = [...useChatStore.getState().messages];

    let collectedText = "";
    const collectedToolCalls: ToolCall[] = [];

    await sendAgentMessage(allMessages, {
      onText: (delta) => {
        setChatState("streaming");
        collectedText += delta;
        appendStreamingText(delta);
      },

      onToolCall: async (toolCall) => {
        collectedToolCalls.push(toolCall);
        clearStreamingText();

        addMessage({
          role: "assistant",
          content: collectedText || `Using **${toolCall.name}**...`,
          toolCalls: [toolCall],
        });

        setChatState("tool_executing");
        const result = await executeToolCall(
          toolCall,
          (path) => { navigate(path); useUIStore.getState().setMode("dashboard"); },
          { connected: false },
        );

        const cards = extractCards(toolCall.name, result);

        addMessage({
          role: "assistant",
          content: "",
          toolResults: [{ toolCallId: toolCall.id, name: toolCall.name, result }],
          cards,
        });

        // Continue conversation with tool results
        const updatedMessages = useChatStore.getState().messages;
        collectedText = "";

        await sendAgentMessage(updatedMessages, {
          onText: (d) => { setChatState("streaming"); collectedText += d; appendStreamingText(d); },
          onToolCall: () => { /* nested — skip for now */ },
          onDone: () => {},
          onError: (err) => { clearStreamingText(); addMessage({ role: "system", content: `Error: ${err}` }); setChatState("idle"); },
        });

        clearStreamingText();
        if (collectedText) {
          addMessage({ role: "assistant", content: collectedText, suggestedActions: inferActions(collectedText) });
        }
        setChatState("idle");
      },

      onDone: () => {
        clearStreamingText();
        if (collectedText && collectedToolCalls.length === 0) {
          addMessage({ role: "assistant", content: collectedText, suggestedActions: inferActions(collectedText) });
        }
        setChatState("idle");
      },

      onError: (err) => {
        clearStreamingText();
        addMessage({ role: "system", content: `Agent error: ${err}` });
        setChatState("idle");
      },
    });
  }, [addMessage, updateMessage, appendStreamingText, clearStreamingText, setChatState, navigate, agentConnection, setAgentConnection]);

  function handleAgentConnect(conn: AgentConnection) {
    setAgentConnection(conn);
    setShowConnect(false);
    addMessage({
      role: "system",
      content: `Agent connected via **${conn.provider}**. ${agentTools.length} PCC tools loaded. Start chatting to interact with the network.`,
      suggestedActions: [
        { label: "What capabilities exist?", message: "What capabilities are available on the network?" },
        { label: "Show my jobs", message: "Show me my active jobs" },
        { label: "I need manufacturing", message: "I need to get something manufactured — what are my options?" },
        { label: "Disconnect", message: "/disconnect" },
      ],
    });
  }

  const placeholder = agentConnection?.connected
    ? "Ask your agent anything about PCC..."
    : "Type /connect to link your agent, or /tools to see the API spec...";

  return (
    <div className="flex flex-col h-full">
      {/* Connection status bar */}
      {agentConnection?.connected && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-teal-500/5 border-b border-teal-500/10 text-xs">
          <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse" />
          <span className="text-teal-300/70">
            Connected via {agentConnection.provider} — {agentTools.length} tools active
          </span>
          <button
            onClick={() => handleSend("/disconnect")}
            className="ml-auto text-white/30 hover:text-white/50 transition-colors"
          >
            Disconnect
          </button>
        </div>
      )}

      {showConnect ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <ConnectAgentPanel
            onConnect={handleAgentConnect}
            onClose={() => setShowConnect(false)}
          />
        </div>
      ) : (
        <ChatMessageList
          messages={messages}
          streamingText={streamingText}
          chatState={chatState}
          onQuickAction={handleSend}
        />
      )}

      <ChatInput
        onSend={handleSend}
        disabled={chatState !== "idle"}
        placeholder={placeholder}
      />
    </div>
  );
}

function inferActions(text: string): SuggestedAction[] {
  const actions: SuggestedAction[] = [];
  const l = text.toLowerCase();
  if (l.includes("capability") || l.includes("available")) actions.push({ label: "Build a contract", message: "Help me build a contract" });
  if (l.includes("contract") || l.includes("price")) actions.push({ label: "Submit workflow", message: "Submit this as a workflow" });
  if (l.includes("job")) actions.push({ label: "Check job status", message: "Show my active jobs" });
  if (actions.length === 0) actions.push({ label: "Search capabilities", message: "What capabilities are available?" }, { label: "My jobs", message: "Show my active jobs" });
  return actions.slice(0, 4);
}
