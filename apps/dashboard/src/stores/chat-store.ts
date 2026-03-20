import { create } from "zustand";
import type { AgentMessage, ChatState } from "../agent/agent-types.js";

let nextId = 1;
function makeId() {
  return `msg-${Date.now()}-${nextId++}`;
}

interface ChatStoreState {
  messages: AgentMessage[];
  chatState: ChatState;
  streamingText: string;

  addMessage: (msg: Omit<AgentMessage, "id" | "timestamp">) => string;
  updateMessage: (id: string, patch: Partial<AgentMessage>) => void;
  appendStreamingText: (text: string) => void;
  clearStreamingText: () => void;
  setChatState: (state: ChatState) => void;
  clearChat: () => void;
}

const WELCOME_MESSAGE: AgentMessage = {
  id: "welcome",
  role: "assistant",
  content: `**Physical Capability Cloud**

A verifiable on-chain skill wrapper for any physical capability. Machines register what they can do as soulbound NFTs. Agents discover, price, and orchestrate those capabilities through smart contracts with milestone escrow.

**Your agent connects directly to PCC.** No API keys, no middleware — just fetch the agent package and your agent has 73 tools to interact with the network.

\`\`\`
GET /agent-package.json
\`\`\`

That single file gives your agent everything: system prompt, tool definitions, and API endpoint mappings. Any LLM, any framework, any language.`,
  suggestedActions: [
    { label: "What is PCC?", message: "/how" },
    { label: "See the tools", message: "/tools" },
    { label: "Get the agent package", message: "/package" },
    { label: "Explore the dashboard", message: "/dashboard" },
  ],
  timestamp: Date.now(),
};

export const useChatStore = create<ChatStoreState>((set) => ({
  messages: [WELCOME_MESSAGE],
  chatState: "idle",
  streamingText: "",

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
}));
