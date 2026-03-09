import React from "react";
import { useNavigate } from "react-router-dom";
import { GlassPanel, GlowBadge } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useLogisticsHubStore } from "../stores/logistics-hub-store.js";

const tabs = ["overview", "shipments", "bookings", "installations", "providers"] as const;

// Mock summary data (would come from /api/logistics/summary in production)
const summary = {
  shipments: { total: 2, inTransit: 1, delivered: 0, pending: 1 },
  bookings: { total: 2, active: 0, upcoming: 2 },
  installations: { total: 2, inProgress: 0, scheduled: 1, completed: 0 },
  providers: { total: 3 },
};

const timeline = [
  { id: "tle-05", timestamp: "2026-03-09T10:00:00Z", type: "shipment_created", title: "CNC Shipment Scheduled", description: "Haas VF-2 pickup scheduled for March 15" },
  { id: "tle-04", timestamp: "2026-03-08T16:00:00Z", type: "booking_confirmed", title: "Space Booked - Bay 5", description: "Brooklyn Maker Hub Bay 5 confirmed for CNC mill" },
  { id: "tle-03", timestamp: "2026-03-07T09:00:00Z", type: "shipment_in_transit", title: "In Transit - Chicago", description: "Prusa MK4 package cleared Chicago distribution center" },
  { id: "tle-02", timestamp: "2026-03-02T10:30:00Z", type: "shipment_picked_up", title: "Equipment Picked Up", description: "Picked up from Prusa Research HQ, Prague" },
  { id: "tle-01", timestamp: "2026-03-01T12:00:00Z", type: "shipment_created", title: "Shipment Created", description: "Prusa MK4 shipment booked from Prague to Brooklyn" },
];

const shipments = [
  { id: "shp-001", equipment: "Prusa MK4 + MMU3 + Enclosure", status: "in_transit" as const, provider: "Precision Equipment Logistics", eta: "Mar 12", origin: "Prague, CZ", destination: "Brooklyn, NY" },
  { id: "shp-002", equipment: "Haas VF-2 CNC Vertical Mill", status: "pickup_scheduled" as const, provider: "Northeast Riggers & Movers", eta: "Mar 16", origin: "Totowa, NJ", destination: "Brooklyn, NY" },
];

const bookings = [
  { id: "book-001", space: "Brooklyn Maker Hub", slot: "Bay 3", status: "equipment_arriving" as const, period: "Mar 2026 - Mar 2027", rate: "$1,200/mo", machine: "Prusa MK4" },
  { id: "book-002", space: "Brooklyn Maker Hub", slot: "Bay 5", status: "confirmed" as const, period: "Mar 2026 - Mar 2027", rate: "$1,800/mo", machine: "Haas VF-2" },
];

const installations = [
  { id: "inst-001", equipment: "Prusa MK4 + MMU3 + Enclosure", status: "scheduled" as const, date: "Mar 12", assignee: "Ryan George", stepsComplete: 0, stepsTotal: 10 },
  { id: "inst-002", equipment: "Haas VF-2 CNC Vertical Mill", status: "draft" as const, date: "Mar 17", assignee: "Haas Field Service", stepsComplete: 0, stepsTotal: 10 },
];

const providers = [
  { id: "prov-riggers", name: "Northeast Riggers & Movers", services: ["Freight", "Rigging", "Install"], rating: 4.8, jobs: 312, region: "Northeast US" },
  { id: "prov-precision", name: "Precision Equipment Logistics", services: ["White Glove", "Calibration"], rating: 4.9, jobs: 87, region: "Bay Area" },
  { id: "prov-flatbed", name: "Industrial Flatbed Express", services: ["Freight", "Warehousing"], rating: 4.3, jobs: 1240, region: "Continental US" },
];

const statusColor = (status: string): "green" | "gold" | "red" | "gray" => {
  if (["in_transit", "in_progress", "active", "equipment_arriving"].includes(status)) return "green";
  if (["pickup_scheduled", "scheduled", "confirmed", "preparing", "booked"].includes(status)) return "gold";
  if (["failed", "cancelled", "blocked"].includes(status)) return "red";
  return "gray";
};

export function LogisticsHubPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { activeTab, setActiveTab } = useLogisticsHubStore();

  React.useEffect(() => {
    setPageMeta("Logistics Hub", "Equipment shipping, space bookings & installations");
  }, [setPageMeta]);

  return (
    <div className="space-y-6">
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-white/[0.06] pb-1">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-4 py-2 rounded-t-lg text-xs capitalize transition-all ${
              activeTab === t
                ? "bg-white/[0.04] text-green-400 border-b-2 border-green-400/30"
                : "text-white/30 hover:text-white/50"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Overview Tab */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <GlassPanel padding="md" glow="green" className="text-center cursor-pointer" onClick={() => setActiveTab("shipments")}>
              <div className="text-[10px] text-white/20">In Transit</div>
              <div className="text-2xl font-mono text-green-400 mt-1">{summary.shipments.inTransit}</div>
              <div className="text-[10px] text-white/15 mt-0.5">{summary.shipments.total} total shipments</div>
            </GlassPanel>
            <GlassPanel padding="md" className="text-center cursor-pointer" onClick={() => setActiveTab("bookings")}>
              <div className="text-[10px] text-white/20">Space Bookings</div>
              <div className="text-2xl font-mono text-white/70 mt-1">{summary.bookings.upcoming}</div>
              <div className="text-[10px] text-white/15 mt-0.5">upcoming</div>
            </GlassPanel>
            <GlassPanel padding="md" className="text-center cursor-pointer" onClick={() => setActiveTab("installations")}>
              <div className="text-[10px] text-white/20">Installations</div>
              <div className="text-2xl font-mono text-white/70 mt-1">{summary.installations.scheduled}</div>
              <div className="text-[10px] text-white/15 mt-0.5">scheduled</div>
            </GlassPanel>
            <GlassPanel padding="md" className="text-center cursor-pointer" onClick={() => setActiveTab("providers")}>
              <div className="text-[10px] text-white/20">Providers</div>
              <div className="text-2xl font-mono text-white/70 mt-1">{summary.providers.total}</div>
              <div className="text-[10px] text-white/15 mt-0.5">available</div>
            </GlassPanel>
          </div>

          {/* Activity Timeline */}
          <div className="space-y-2">
            <span className="text-xs text-white/30">Recent Activity</span>
            <div className="space-y-1">
              {timeline.map((e) => (
                <GlassPanel key={e.id} padding="sm" className="flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-green-500/50 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs text-white/60">{e.title}</span>
                    <div className="text-[10px] text-white/20 truncate">{e.description}</div>
                  </div>
                  <span className="text-[10px] text-white/15 shrink-0">
                    {new Date(e.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </span>
                </GlassPanel>
              ))}
            </div>
          </div>

          {/* Quick Actions */}
          <div className="flex gap-3">
            <button
              onClick={() => navigate("/logistics/shipments")}
              className="px-4 py-2 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-xs hover:bg-green-500/15 transition-colors"
            >
              Track Shipments
            </button>
            <button
              onClick={() => navigate("/logistics/bookings")}
              className="px-4 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white/50 text-xs hover:text-white/70 transition-colors"
            >
              Manage Bookings
            </button>
            <button
              onClick={() => navigate("/logistics/installations")}
              className="px-4 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white/50 text-xs hover:text-white/70 transition-colors"
            >
              View Installations
            </button>
          </div>
        </div>
      )}

      {/* Shipments Tab */}
      {activeTab === "shipments" && (
        <div className="space-y-3">
          {shipments.map((s) => (
            <GlassPanel
              key={s.id}
              hover
              padding="md"
              className="cursor-pointer"
              onClick={() => navigate(`/logistics/shipments/${s.id}`)}
            >
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-white/70">{s.equipment}</span>
                    <GlowBadge color={statusColor(s.status)}>{s.status.replace(/_/g, " ")}</GlowBadge>
                  </div>
                  <div className="text-[10px] text-white/20">{s.origin} → {s.destination}</div>
                  <div className="text-[10px] text-white/15">{s.provider}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-white/20">ETA</div>
                  <div className="text-xs text-white/50">{s.eta}</div>
                </div>
              </div>
            </GlassPanel>
          ))}
        </div>
      )}

      {/* Bookings Tab */}
      {activeTab === "bookings" && (
        <div className="space-y-3">
          {bookings.map((b) => (
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
                    <span className="text-sm text-white/70">{b.space} — {b.slot}</span>
                    <GlowBadge color={statusColor(b.status)}>{b.status.replace(/_/g, " ")}</GlowBadge>
                  </div>
                  <div className="text-[10px] text-white/20">{b.machine}</div>
                  <div className="text-[10px] text-white/15">{b.period}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-white/50">{b.rate}</div>
                </div>
              </div>
            </GlassPanel>
          ))}
        </div>
      )}

      {/* Installations Tab */}
      {activeTab === "installations" && (
        <div className="space-y-3">
          {installations.map((inst) => (
            <GlassPanel
              key={inst.id}
              hover
              padding="md"
              className="cursor-pointer"
              onClick={() => navigate(`/logistics/installations/${inst.id}`)}
            >
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-white/70">{inst.equipment}</span>
                    <GlowBadge color={statusColor(inst.status)}>{inst.status.replace(/_/g, " ")}</GlowBadge>
                  </div>
                  <div className="text-[10px] text-white/20">Assigned: {inst.assignee}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-white/20">Scheduled</div>
                  <div className="text-xs text-white/50">{inst.date}</div>
                  <div className="text-[10px] text-white/15 mt-1">{inst.stepsComplete}/{inst.stepsTotal} steps</div>
                </div>
              </div>
            </GlassPanel>
          ))}
        </div>
      )}

      {/* Providers Tab */}
      {activeTab === "providers" && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {providers.map((p) => (
            <GlassPanel key={p.id} hover padding="md">
              <div className="space-y-2">
                <div className="text-sm text-white/70">{p.name}</div>
                <div className="flex flex-wrap gap-1">
                  {p.services.map((s) => (
                    <GlowBadge key={s} color="gray">{s}</GlowBadge>
                  ))}
                </div>
                <div className="flex items-center justify-between text-[10px] text-white/20">
                  <span>{p.region}</span>
                  <span>{p.jobs} jobs</span>
                  <span className="text-yellow-400/60">{"*".repeat(Math.round(p.rating))} {p.rating}</span>
                </div>
              </div>
            </GlassPanel>
          ))}
        </div>
      )}
    </div>
  );
}
