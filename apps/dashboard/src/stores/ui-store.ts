import { create } from "zustand";

interface UIState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  currentPageTitle: string;
  currentPageSubtitle: string;
  setPageMeta: (title: string, subtitle?: string) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  currentPageTitle: "Dashboard",
  currentPageSubtitle: "",
  setPageMeta: (title, subtitle = "") => set({ currentPageTitle: title, currentPageSubtitle: subtitle }),
}));
