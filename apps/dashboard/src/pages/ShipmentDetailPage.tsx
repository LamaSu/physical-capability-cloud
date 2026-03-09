import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { GlassPanel, GlowBadge } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";

// Mock shipment data (matches gateway mock)
const mockShipments = [
  {
    id: "shp-001",
    equipment: "Prusa MK4 + MMU3 + Enclosure",
    status: "in_transit",
    provider: "Precision Equipment Logistics",
    priority: "standard",
    origin: { label: "Prusa Research HQ", address: "Partyzánská 188/7A, Prague, CZ" },
    destination: { label: "Brooklyn Maker Hub", address: "45 Industrial Rd, Brooklyn, NY 11222", notes: "Loading dock B, ring bell" },
    package: { weightKg: 32, dimensions: "65 x 80 x 75 cm", items: 3, fragile: true, palletized: true },
    quote: { price: "$485.00", transit: "5-8 days", insurance: "$3,000" },
    eta: "2026-03-12",
    trackingEvents: [
      { time: "Mar 7, 09:00", status: "in_transit", location: "Chicago, IL", message: "In transit via Chicago distribution center" },
      { time: "Mar 4, 14:00", status: "in_transit", location: "Frankfurt, DE", message: "Cleared customs at Frankfurt hub" },
      { time: "Mar 2, 10:30", status: "picked_up", location: "Prague, CZ", message: "Package picked up from Prusa HQ" },
      { time: "Mar 1, 12:00", status: "booked", location: "—", message: "Shipment created and booked" },
    ],
    conditions: [
      { time: "Mar 7", temp: "21.3°C", humidity: "45%", shock: "0.2g", tilt: "1.5°" },
      { time: "Mar 6", temp: "19.8°C", humidity: "52%", shock: "0.8g", tilt: "2.1°" },
      { time: "Mar 5", temp: "20.1°C", humidity: "48%", shock: "0.3g", tilt: "1.2°" },
    ],
  },
  {
    id: "shp-002",
    equipment: "Haas VF-2 CNC Vertical Mill",
    status: "pickup_scheduled",
    provider: "Northeast Riggers & Movers",
    priority: "expedited",
    origin: { label: "Haas Factory Outlet - NJ", address: "100 Industrial Pkwy, Totowa, NJ 07512" },
    destination: { label: "Brooklyn Maker Hub", address: "45 Industrial Rd, Brooklyn, NY 11222", notes: "Forklift unload. Bay 5." },
    package: { weightKg: 3100, dimensions: "198 x 254 x 261 cm", items: 1, fragile: false, palletized: false },
    quote: { price: "$2,850.00", transit: "1-2 days", insurance: "$150,000" },
    eta: "2026-03-16",
    trackingEvents: [
      { time: "Mar 9, 10:00", status: "pickup_scheduled", location: "—", message: "Pickup confirmed for March 15" },
      { time: "Mar 8, 16:00", status: "booked", location: "—", message: "Shipment booked with Northeast Riggers" },
    ],
    conditions: [],
  },
];

const statusColor = (status: string): "green" | "gold" | "red" | "gray" => {
  if (["in_transit", "out_for_delivery"].includes(status)) return "green";
  if (["pickup_scheduled", "booked", "picked_up", "at_hub"].includes(status)) return "gold";
  if (["failed", "cancelled"].includes(status)) return "red";
  if (status === "delivered" || status === "inspected") return "green";
  return "gray";
};

export function ShipmentDetailPage() {
  const { shipmentId } = useParams();
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const shipment = mockShipments.find((s) => s.id === shipmentId);

  React.useEffect(() => {
    setPageMeta("Shipment Detail", shipment?.equipment ?? "Unknown");
  }, [setPageMeta, shipment]);

  if (!shipment) {
    return (
      <div className="text-center py-12 text-white/20 text-sm">
        Shipment not found.{" "}
        <button onClick={() => navigate("/logistics")} className="text-green-400/60 underline">
          Back to Logistics
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <button
        onClick={() => navigate("/logistics")}
        className="text-[10px] text-white/20 hover:text-white/40 transition-colors"
      >
        ← Back to Logistics Hub
      </button>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-lg text-white/80">{shipment.equipment}</span>
            <GlowBadge color={statusColor(shipment.status)}>{shipment.status.replace(/_/g, " ")}</GlowBadge>
            <GlowBadge color={shipment.priority === "rush" ? "red" : shipment.priority === "expedited" ? "gold" : "gray"}>
              {shipment.priority}
            </GlowBadge>
          </div>
          <div className="text-xs text-white/20 mt-1">{shipment.id} · via {shipment.provider}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-white/20">Estimated Delivery</div>
          <div className="text-sm text-white/60">{shipment.eta}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Route */}
        <GlassPanel padding="md">
          <div className="text-xs text-white/30 mb-3">Route</div>
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-3 h-3 rounded-full bg-green-500/40 mt-0.5 shrink-0" />
              <div>
                <div className="text-xs text-white/60">{shipment.origin.label}</div>
                <div className="text-[10px] text-white/20">{shipment.origin.address}</div>
              </div>
            </div>
            <div className="ml-1.5 border-l border-dashed border-white/10 h-6" />
            <div className="flex items-start gap-3">
              <div className="w-3 h-3 rounded-full bg-blue-500/40 mt-0.5 shrink-0" />
              <div>
                <div className="text-xs text-white/60">{shipment.destination.label}</div>
                <div className="text-[10px] text-white/20">{shipment.destination.address}</div>
                {shipment.destination.notes && (
                  <div className="text-[10px] text-yellow-400/40 mt-0.5">{shipment.destination.notes}</div>
                )}
              </div>
            </div>
          </div>
        </GlassPanel>

        {/* Package Details */}
        <GlassPanel padding="md">
          <div className="text-xs text-white/30 mb-3">Package Details</div>
          <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-[10px]">
            <div>
              <span className="text-white/20">Weight</span>
              <div className="text-white/50">{shipment.package.weightKg} kg</div>
            </div>
            <div>
              <span className="text-white/20">Dimensions</span>
              <div className="text-white/50">{shipment.package.dimensions}</div>
            </div>
            <div>
              <span className="text-white/20">Items</span>
              <div className="text-white/50">{shipment.package.items}</div>
            </div>
            <div>
              <span className="text-white/20">Handling</span>
              <div className="text-white/50">
                {[shipment.package.fragile && "Fragile", shipment.package.palletized && "Palletized"].filter(Boolean).join(", ") || "Standard"}
              </div>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-white/[0.06]">
            <div className="text-xs text-white/30 mb-2">Quote</div>
            <div className="grid grid-cols-3 gap-2 text-[10px]">
              <div>
                <span className="text-white/20">Price</span>
                <div className="text-green-400/70">{shipment.quote.price}</div>
              </div>
              <div>
                <span className="text-white/20">Transit</span>
                <div className="text-white/50">{shipment.quote.transit}</div>
              </div>
              <div>
                <span className="text-white/20">Insurance</span>
                <div className="text-white/50">{shipment.quote.insurance}</div>
              </div>
            </div>
          </div>
        </GlassPanel>
      </div>

      {/* Tracking Timeline */}
      <GlassPanel padding="md">
        <div className="text-xs text-white/30 mb-3">Tracking Timeline</div>
        <div className="space-y-0">
          {shipment.trackingEvents.map((e, i) => (
            <div key={i} className="flex items-start gap-3 py-2">
              <div className="flex flex-col items-center">
                <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${i === 0 ? "bg-green-500/60" : "bg-white/10"}`} />
                {i < shipment.trackingEvents.length - 1 && (
                  <div className="w-px h-full bg-white/[0.06] min-h-[20px]" />
                )}
              </div>
              <div className="flex-1 min-w-0 -mt-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-white/60">{e.message}</span>
                  <GlowBadge color={statusColor(e.status)}>{e.status.replace(/_/g, " ")}</GlowBadge>
                </div>
                <div className="text-[10px] text-white/15 mt-0.5">{e.time} · {e.location}</div>
              </div>
            </div>
          ))}
        </div>
      </GlassPanel>

      {/* Condition Readings */}
      {shipment.conditions.length > 0 && (
        <GlassPanel padding="md">
          <div className="text-xs text-white/30 mb-3">Condition Monitoring</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-white/20 text-left">
                  <th className="pb-2 pr-4">Date</th>
                  <th className="pb-2 pr-4">Temp</th>
                  <th className="pb-2 pr-4">Humidity</th>
                  <th className="pb-2 pr-4">Shock</th>
                  <th className="pb-2">Tilt</th>
                </tr>
              </thead>
              <tbody>
                {shipment.conditions.map((c, i) => (
                  <tr key={i} className="text-white/40">
                    <td className="py-1 pr-4">{c.time}</td>
                    <td className="py-1 pr-4">{c.temp}</td>
                    <td className="py-1 pr-4">{c.humidity}</td>
                    <td className={`py-1 pr-4 ${parseFloat(c.shock) > 0.5 ? "text-yellow-400/60" : ""}`}>{c.shock}</td>
                    <td className="py-1">{c.tilt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GlassPanel>
      )}
    </div>
  );
}
