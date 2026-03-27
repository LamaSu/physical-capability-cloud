import { create } from "zustand";

export type InterfaceMode = "agent" | "dashboard" | "spatial";

const MODE_CYCLE: InterfaceMode[] = ["spatial", "agent", "dashboard"];

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
  interfaceMode: "spatial",
  toggleMode: () =>
    set((s) => {
      const idx = MODE_CYCLE.indexOf(s.interfaceMode);
      const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
      return { interfaceMode: next };
    }),
  setMode: (mode) => set({ interfaceMode: mode }),
}));
