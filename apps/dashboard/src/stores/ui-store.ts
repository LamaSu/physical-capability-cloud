import { create } from "zustand";

export type InterfaceMode = "agent" | "dashboard";

interface UIState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  currentPageTitle: string;
  currentPageSubtitle: string;
  setPageMeta: (title: string, subtitle?: string) => void;
  interfaceMode: InterfaceMode;
  toggleMode: () => void;
  setMode: (mode: InterfaceMode) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  currentPageTitle: "Dashboard",
  currentPageSubtitle: "",
  setPageMeta: (title, subtitle = "") => set({ currentPageTitle: title, currentPageSubtitle: subtitle }),
  interfaceMode: "agent",
  toggleMode: () => set((s) => ({ interfaceMode: s.interfaceMode === "agent" ? "dashboard" : "agent" })),
  setMode: (mode) => set({ interfaceMode: mode }),
}));
