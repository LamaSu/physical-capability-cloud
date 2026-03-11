import { create } from "zustand";

interface SpaceFinderState {
  searchQuery: string;
  minPower: number;
  minArea: number;
  maxPrice: number;
  accessFilter: "all" | "24/7" | "business-hours" | "scheduled";
  sortBy: "sqft" | "rating" | "match" | "slots";
  selectedSpaceId: string | null;

  setSearch: (q: string) => void;
  setMinPower: (v: number) => void;
  setMinArea: (v: number) => void;
  setMaxPrice: (v: number) => void;
  setAccessFilter: (f: "all" | "24/7" | "business-hours" | "scheduled") => void;
  setSortBy: (s: "sqft" | "rating" | "match" | "slots") => void;
  setSelectedSpace: (id: string | null) => void;
}

export const useSpaceFinderStore = create<SpaceFinderState>((set) => ({
  searchQuery: "",
  minPower: 0,
  minArea: 0,
  maxPrice: 0,
  accessFilter: "all",
  sortBy: "match",
  selectedSpaceId: null,

  setSearch: (q) => set({ searchQuery: q }),
  setMinPower: (v) => set({ minPower: v }),
  setMinArea: (v) => set({ minArea: v }),
  setMaxPrice: (v) => set({ maxPrice: v }),
  setAccessFilter: (f) => set({ accessFilter: f }),
  setSortBy: (s) => set({ sortBy: s }),
  setSelectedSpace: (id) => set({ selectedSpaceId: id }),
}));
