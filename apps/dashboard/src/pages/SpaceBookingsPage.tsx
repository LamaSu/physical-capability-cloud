import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { GlassPanel, GlowBadge } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";

const mockBookings = [
  {
    id: "book-001",
    spaceId: "space-bk",
    spaceName: "Brooklyn Maker Hub",
    slot: "Bay 3",
    machine: "Prusa MK4 + MMU3 + Enclosure",
    status: "equipment_arriving" as const,
    period: { start: "2026-03-10", end: "2027-03-10" },
    monthlyRate: "$1,200",
    deposit: "$2,400",
    requirements: { power: "1 circuit, 120V", air: false, network: "1 port", floor: "Standard" },
    shipmentId: "shp-001",
    installationId: "inst-001",
    moveInDate: "Mar 12, 2026",
    timeline: [
      { date: "Mar 1", event: "Booking requested", done: true },
      { date: "Mar 2", event: "Deposit paid — booking confirmed", done: true },
      { date: "Mar 8", event: "Space preparation started", done: true },
      { date: "Mar 12", event: "Equipment arriving (shipment in transit)", done: false },
      { date: "Mar 12", event: "Installation scheduled", done: false },
    ],
  },
  {
    id: "book-002",
    spaceId: "space-bk",
    spaceName: "Brooklyn Maker Hub",
    slot: "Bay 5",
    machine: "Haas VF-2 CNC Vertical Mill",
    status: "confirmed" as const,
    period: { start: "2026-03-16", end: "2027-03-16" },
    monthlyRate: "$1,800",
    deposit: "$3,600",
    requirements: { power: "3 circuits, 480V 3-phase", air: true, network: "2 ports", floor: "Concrete pad required" },
    shipmentId: "shp-002",
    installationId: "inst-002",
    moveInDate: "Mar 16, 2026",
    timeline: [
      { date: "Mar 8", event: "Booking requested", done: true },
      { date: "Mar 8", event: "Deposit paid — booking confirmed", done: true },
      { date: "Mar 15", event: "Space preparation", done: false },
      { date: "Mar 16", event: "Equipment delivery", done: false },
      { date: "Mar 17", event: "Installation", done: false },
    ],
  },
];

const statusColor = (status: string): "green" | "gold" | "red" | "gray" => {
  if (["active", "equipment_arriving"].includes(status)) return "green";
  if (["confirmed", "preparing", "requested"].includes(status)) return "gold";
  if (["cancelled"].includes(status)) return "red";
  return "gray";
};

export function SpaceBookingsPage() {
  const { bookingId } = useParams();
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  React.useEffect(() => {
    setPageMeta("Space Bookings", "Manage your space reservations");
  }, [setPageMeta]);

  // If bookingId is provided, show detail view
  const selectedBooking = bookingId ? mockBookings.find((b) => b.id === bookingId) : null;

  if (selectedBooking) {
    return (
      <div className="space-y-6">
        <button
          onClick={() => navigate("/logistics/bookings")}
          className="text-[10px] text-white/20 hover:text-white/40 transition-colors"
        >
          ← Back to Bookings
        </button>

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg text-white/80">{selectedBooking.spaceName} — {selectedBooking.slot}</span>
              <GlowBadge color={statusColor(selectedBooking.status)}>{selectedBooking.status.replace(/_/g, " ")}</GlowBadge>
            </div>
            <div className="text-xs text-white/20 mt-1">{selectedBooking.id} · {selectedBooking.machine}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Booking Details */}
          <GlassPanel padding="md">
            <div className="text-xs text-white/30 mb-3">Booking Details</div>
            <div className="space-y-3 text-[10px]">
              <div className="flex justify-between">
                <span className="text-white/20">Period</span>
                <span className="text-white/50">{selectedBooking.period.start} → {selectedBooking.period.end}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/20">Monthly Rate</span>
                <span className="text-green-400/70">{selectedBooking.monthlyRate}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/20">Deposit</span>
                <span className="text-white/50">{selectedBooking.deposit}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/20">Move-in Date</span>
                <span className="text-white/50">{selectedBooking.moveInDate}</span>
              </div>
            </div>
          </GlassPanel>

          {/* Requirements */}
          <GlassPanel padding="md">
            <div className="text-xs text-white/30 mb-3">Space Requirements</div>
            <div className="space-y-3 text-[10px]">
              <div className="flex justify-between">
                <span className="text-white/20">Power</span>
                <span className="text-white/50">{selectedBooking.requirements.power}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/20">Compressed Air</span>
                <span className="text-white/50">{selectedBooking.requirements.air ? "Required" : "Not needed"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/20">Network</span>
                <span className="text-white/50">{selectedBooking.requirements.network}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/20">Floor</span>
                <span className="text-white/50">{selectedBooking.requirements.floor}</span>
              </div>
            </div>
          </GlassPanel>
        </div>

        {/* Timeline */}
        <GlassPanel padding="md">
          <div className="text-xs text-white/30 mb-3">Booking Timeline</div>
          <div className="space-y-0">
            {selectedBooking.timeline.map((t, i) => (
              <div key={i} className="flex items-start gap-3 py-2">
                <div className="flex flex-col items-center">
                  <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${t.done ? "bg-green-500/60" : "bg-white/10"}`} />
                  {i < selectedBooking.timeline.length - 1 && (
                    <div className="w-px h-full bg-white/[0.06] min-h-[16px]" />
                  )}
                </div>
                <div className="-mt-0.5">
                  <span className={`text-xs ${t.done ? "text-white/50" : "text-white/20"}`}>{t.event}</span>
                  <div className="text-[10px] text-white/15">{t.date}</div>
                </div>
              </div>
            ))}
          </div>
        </GlassPanel>

        {/* Linked Items */}
        <div className="flex gap-3">
          {selectedBooking.shipmentId && (
            <button
              onClick={() => navigate(`/logistics/shipments/${selectedBooking.shipmentId}`)}
              className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white/40 text-[10px] hover:text-white/60 transition-colors"
            >
              View Shipment →
            </button>
          )}
          {selectedBooking.installationId && (
            <button
              onClick={() => navigate(`/logistics/installations/${selectedBooking.installationId}`)}
              className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white/40 text-[10px] hover:text-white/60 transition-colors"
            >
              View Installation →
            </button>
          )}
          <button
            onClick={() => navigate(`/spaces/${selectedBooking.spaceId}`)}
            className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white/40 text-[10px] hover:text-white/60 transition-colors"
          >
            View Space →
          </button>
        </div>
      </div>
    );
  }

  // List view
  return (
    <div className="space-y-6">
      <button
        onClick={() => navigate("/logistics")}
        className="text-[10px] text-white/20 hover:text-white/40 transition-colors"
      >
        ← Back to Logistics Hub
      </button>

      <div className="space-y-3">
        {mockBookings.map((b) => (
          <GlassPanel
            key={b.id}
            hover
            padding="md"
            className="cursor-pointer"
            onClick={() => navigate(`/logistics/bookings/${b.id}`)}
          >
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-white/70">{b.spaceName} — {b.slot}</span>
                  <GlowBadge color={statusColor(b.status)}>{b.status.replace(/_/g, " ")}</GlowBadge>
                </div>
                <div className="text-[10px] text-white/20">{b.machine}</div>
                <div className="text-[10px] text-white/15">{b.period.start} → {b.period.end}</div>
              </div>
              <div className="text-right">
                <div className="text-xs text-green-400/60">{b.monthlyRate}/mo</div>
                <div className="text-[10px] text-white/15">Move-in: {b.moveInDate}</div>
              </div>
            </div>
          </GlassPanel>
        ))}
      </div>
    </div>
  );
}
