import { create } from "zustand";
import type { AgentMessage, ChatState } from "../agent/agent-types.js";

let nextId = 1;
function makeId() {
  return `msg-${Date.now()}-${nextId++}`;
}

export interface AgentConnection {
  endpoint: string;
  apiKey: string;
  provider: "claude" | "openai" | "custom";
  connected: boolean;
}

interface ChatStoreState {
  messages: AgentMessage[];
  chatState: ChatState;
  streamingText: string;
  agentConnection: AgentConnection | null;

  addMessage: (msg: Omit<AgentMessage, "id" | "timestamp">) => string;
  updateMessage: (id: string, patch: Partial<AgentMessage>) => void;
  appendStreamingText: (text: string) => void;
  clearStreamingText: () => void;
  setChatState: (state: ChatState) => void;
  clearChat: () => void;
  setAgentConnection: (conn: AgentConnection | null) => void;
}

const WELCOME_MESSAGE: AgentMessage = {
  id: "welcome",
  role: "assistant",
  content: `**Welcome to the Physical Capability Cloud**

PCC is **AWS for the physical world** — a cloud control plane for manufacturing capabilities. Shop Kernels are physical sites with equipment. Capabilities are what machines can do. Contracts define jobs with on-chain escrow.

**Connect your AI agent** to interact with the network. PCC provides **28 tools** your agent can use — capability discovery, contract building, job monitoring, escrow management, and more.

Your agent needs:
1. An API endpoint (Claude, GPT, or any LLM)
2. An API key for your provider
3. PCC's tool definitions (auto-loaded when you connect)

Once connected, your agent can discover capabilities, build contracts, submit workflows, and monitor jobs — all through natural conversation.`,
  suggestedActions: [
    { label: "Connect my agent", message: "/connect" },
    { label: "View tool spec", message: "/tools" },
    { label: "How it works", message: "/how" },
    { label: "Explore the dashboard", message: "/dashboard" },
  ],
  timestamp: Date.now(),
};

export const useChatStore = create<ChatStoreState>((set) => ({
  messages: [WELCOME_MESSAGE],
  chatState: "idle",
  streamingText: "",
  agentConnection: null,

  addMessage: (msg) => {
    const id = makeId();
    const full: AgentMessage = { ...msg, id, timestamp: Date.now() };
    set((s) => ({ messages: [...s.messages, full] }));
    return id;
  },

  updateMessage: (id, patch) => {
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }));
  },

  appendStreamingText: (text) => {
    set((s) => ({ streamingText: s.streamingText + text }));
  },

  clearStreamingText: () => set({ streamingText: "" }),

  setChatState: (state) => set({ chatState: state }),

  clearChat: () => set({ messages: [WELCOME_MESSAGE], chatState: "idle", streamingText: "" }),

  setAgentConnection: (conn) => set({ agentConnection: conn }),
}));
