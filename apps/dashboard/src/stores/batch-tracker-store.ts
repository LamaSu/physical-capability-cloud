import { create } from "zustand";
import type { BatchManifest, SampleSlot } from "@pcc/spec";

interface BatchTrackerState {
  batches: BatchManifest[];
  selectedBatchId: string | null;
  slotFilter: SampleSlot["status"] | "all";

  setBatches: (batches: BatchManifest[]) => void;
  selectBatch: (id: string | null) => void;
  updateSlot: (batchId: string, slotId: string, update: Partial<SampleSlot>) => void;
  setFilter: (filter: SampleSlot["status"] | "all") => void;
}

export const useBatchTrackerStore = create<BatchTrackerState>((set) => ({
  batches: [],
  selectedBatchId: null,
  slotFilter: "all",

  setBatches: (batches) => set({ batches }),

  selectBatch: (id) => set({ selectedBatchId: id }),

  updateSlot: (batchId, slotId, update) =>
    set((s) => ({
      batches: s.batches.map((b) =>
        b.id === batchId
          ? {
              ...b,
              slots: b.slots.map((slot) =>
                slot.id === slotId ? { ...slot, ...update } : slot,
              ),
            }
          : b,
      ),
    })),

  setFilter: (filter) => set({ slotFilter: filter }),
}));
