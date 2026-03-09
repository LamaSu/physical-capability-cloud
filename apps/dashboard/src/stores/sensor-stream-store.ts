import { create } from "zustand";
import type { SensorChannelDescriptor, SensorReading, SensorAnomaly } from "@pcc/spec";

interface SensorStreamState {
  selectedChannels: string[];
  channelDescriptors: SensorChannelDescriptor[];
  recentReadings: Record<string, SensorReading[]>;
  anomalies: SensorAnomaly[];
  isStreaming: boolean;

  addChannel: (channel: string) => void;
  removeChannel: (channel: string) => void;
  pushReading: (reading: SensorReading) => void;
  pushAnomaly: (anomaly: SensorAnomaly) => void;
  setDescriptors: (descriptors: SensorChannelDescriptor[]) => void;
  setStreaming: (v: boolean) => void;
  clearReadings: () => void;
}

const MAX_READINGS_PER_CHANNEL = 200;

export const useSensorStreamStore = create<SensorStreamState>((set, get) => ({
  selectedChannels: [],
  channelDescriptors: [],
  recentReadings: {},
  anomalies: [],
  isStreaming: false,

  addChannel: (channel) =>
    set((s) => ({
      selectedChannels: s.selectedChannels.includes(channel)
        ? s.selectedChannels
        : [...s.selectedChannels, channel],
    })),

  removeChannel: (channel) =>
    set((s) => ({
      selectedChannels: s.selectedChannels.filter((c) => c !== channel),
    })),

  pushReading: (reading) =>
    set((s) => {
      const existing = s.recentReadings[reading.channel] ?? [];
      const updated = [...existing, reading].slice(-MAX_READINGS_PER_CHANNEL);
      return { recentReadings: { ...s.recentReadings, [reading.channel]: updated } };
    }),

  pushAnomaly: (anomaly) =>
    set((s) => ({
      anomalies: [...s.anomalies.slice(-99), anomaly],
    })),

  setDescriptors: (descriptors) => set({ channelDescriptors: descriptors }),

  setStreaming: (v) => set({ isStreaming: v }),

  clearReadings: () => set({ recentReadings: {}, anomalies: [] }),
}));
