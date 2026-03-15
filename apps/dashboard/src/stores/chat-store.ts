import { create } from "zustand";
import type { AgentMessage, ChatState, SuggestedAction } from "../agent/agent-types.js";

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
  content:
    "Welcome to the Physical Capability Cloud. I can help you discover manufacturing capabilities, build contracts, monitor jobs, and manage your network.\n\nAre you a **requester** looking to get something manufactured, or an **operator** with equipment to offer?",
  suggestedActions: [
    { label: "I need manufacturing", message: "I'm a requester — I need to get something manufactured" },
    { label: "I have equipment", message: "I'm an operator — I have manufacturing equipment to offer" },
    { label: "Show capabilities", message: "What capabilities are available on the network?" },
    { label: "Check my jobs", message: "Show me my active jobs" },
  ],
  timestamp: Date.now(),
};

export const useChatStore = create<ChatStoreState>((set, get) => ({
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
