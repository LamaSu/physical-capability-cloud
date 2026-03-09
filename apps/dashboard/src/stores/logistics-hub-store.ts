import { create } from "zustand";

type HubTab = "overview" | "shipments" | "bookings" | "installations" | "providers";
type ShipmentFilter = "all" | "in_transit" | "delivered" | "pending";
type BookingFilter = "all" | "active" | "upcoming" | "completed" | "cancelled";
type InstallationFilter = "all" | "draft" | "scheduled" | "in_progress" | "completed";

interface LogisticsHubState {
  activeTab: HubTab;
  shipmentFilter: ShipmentFilter;
  bookingFilter: BookingFilter;
  installationFilter: InstallationFilter;
  selectedShipmentId: string | null;
  selectedBookingId: string | null;
  selectedInstallationId: string | null;
  searchQuery: string;

  setActiveTab: (t: HubTab) => void;
  setShipmentFilter: (f: ShipmentFilter) => void;
  setBookingFilter: (f: BookingFilter) => void;
  setInstallationFilter: (f: InstallationFilter) => void;
  setSelectedShipment: (id: string | null) => void;
  setSelectedBooking: (id: string | null) => void;
  setSelectedInstallation: (id: string | null) => void;
  setSearch: (q: string) => void;
}

export const useLogisticsHubStore = create<LogisticsHubState>((set) => ({
  activeTab: "overview",
  shipmentFilter: "all",
  bookingFilter: "all",
  installationFilter: "all",
  selectedShipmentId: null,
  selectedBookingId: null,
  selectedInstallationId: null,
  searchQuery: "",

  setActiveTab: (t) => set({ activeTab: t }),
  setShipmentFilter: (f) => set({ shipmentFilter: f }),
  setBookingFilter: (f) => set({ bookingFilter: f }),
  setInstallationFilter: (f) => set({ installationFilter: f }),
  setSelectedShipment: (id) => set({ selectedShipmentId: id }),
  setSelectedBooking: (id) => set({ selectedBookingId: id }),
  setSelectedInstallation: (id) => set({ selectedInstallationId: id }),
  setSearch: (q) => set({ searchQuery: q }),
}));
