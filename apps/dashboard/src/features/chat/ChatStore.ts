import { create } from "zustand";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpatialMessage {
  id: string;
  role: "user" | "system";
  content: string;
  /** If this message opened a panel, store the panel ID so user can re-open */
  panelId?: string;
  timestamp: number;
}

interface SpatialChatState {
  messages: SpatialMessage[];
  sidebarOpen: boolean;

  addMessage: (msg: Omit<SpatialMessage, "id" | "timestamp">) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  clearMessages: () => void;
}

let nextId = 1;
function makeId() {
  return `spatial-${Date.now()}-${nextId++}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const WELCOME: SpatialMessage = {
  id: "spatial-welcome",
  role: "system",
  content:
    "Welcome to the spatial interface. Type a panel name or use /open <panel> to open floating windows. /help for all commands.",
  timestamp: Date.now(),
};

export const useSpatialChatStore = create<SpatialChatState>((set) => ({
  messages: [WELCOME],
  sidebarOpen: false,

  addMessage: (msg) => {
    const full: SpatialMessage = { ...msg, id: makeId(), timestamp: Date.now() };
    set((s) => ({ messages: [...s.messages, full] }));
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  clearMessages: () => set({ messages: [WELCOME] }),
}));
