import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { GlassPanel, GlowBadge } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { mockHostingSpaces } from "../api/mock-onboarding-data.js";

export function SpaceDetailPage() {
  const { spaceId } = useParams<{ spaceId: string }>();
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const space = mockHostingSpaces.find((s) => s.id === spaceId);

  React.useEffect(() => {
    setPageMeta(space?.name ?? "Space Detail", "Hosting location details");
  }, [setPageMeta, space]);

  if (!space) {
    return (
      <div className="text-center py-12">
        <p className="text-white/30">Space not found</p>
        <button onClick={() => navigate("/spaces")} className="text-xs text-green-400/60 mt-2">&larr; Back</button>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <button onClick={() => navigate("/spaces")} className="text-xs text-white/30 hover:text-white/50 transition-colors">
        &larr; Back to Spaces
      </button>

      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-white/90">{space.name}</h2>
        <p className="text-sm text-white/40 mt-1">{space.address}</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <GlassPanel padding="md" className="text-center">
          <div className="text-[10px] text-white/20">Monthly Price</div>
          <div className="text-lg font-mono text-green-400 mt-1">${space.monthlyPrice}</div>
        </GlassPanel>
        <GlassPanel padding="md" className="text-center">
          <div className="text-[10px] text-white/20">Available Slots</div>
          <div className="text-lg font-mono text-white/60 mt-1">{space.availableSlots}/{space.totalSlots}</div>
        </GlassPanel>
        <GlassPanel padding="md" className="text-center">
          <div className="text-[10px] text-white/20">Rating</div>
          <div className="text-lg font-mono text-yellow-400 mt-1">{space.rating.toFixed(1)}</div>
        </GlassPanel>
        <GlassPanel padding="md" className="text-center">
          <div className="text-[10px] text-white/20">Access</div>
          <div className="text-sm font-mono text-white/50 mt-1">{space.access.schedule}</div>
        </GlassPanel>
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <GlassPanel padding="md" className="space-y-3">
          <span className="text-xs font-medium text-white/50">Dimensions</span>
          <div className="text-sm text-white/40 font-mono">
            {space.dimensions.width} x {space.dimensions.depth} x {space.dimensions.height} {space.dimensions.unit}
          </div>
        </GlassPanel>

        <GlassPanel padding="md" className="space-y-3">
          <span className="text-xs font-medium text-white/50">Power</span>
          <div className="text-sm text-white/40 font-mono">
            {space.power.voltage}V / {space.power.amperage}A / {space.power.phase}-phase / {space.power.circuitCount} circuits
          </div>
        </GlassPanel>

        <GlassPanel padding="md" className="space-y-2">
          <span className="text-xs font-medium text-white/50">Amenities</span>
          <div className="flex flex-wrap gap-1">
            {space.amenities.map((a) => (
              <GlowBadge key={a} color="green">{a}</GlowBadge>
            ))}
          </div>
        </GlassPanel>

        <GlassPanel padding="md" className="space-y-2">
          <span className="text-xs font-medium text-white/50">Environmental Systems</span>
          <div className="flex flex-wrap gap-1">
            {space.environmentalSystems.map((e) => (
              <GlowBadge key={e} color="gold">{e}</GlowBadge>
            ))}
          </div>
        </GlassPanel>

        <GlassPanel padding="md" className="space-y-2">
          <span className="text-xs font-medium text-white/50">Safety Features</span>
          <div className="flex flex-wrap gap-1">
            {space.safetyFeatures.map((s) => (
              <GlowBadge key={s} color="gray">{s}</GlowBadge>
            ))}
          </div>
        </GlassPanel>

        <GlassPanel padding="md" className="space-y-2">
          <span className="text-xs font-medium text-white/50">Access Details</span>
          <div className="text-xs text-white/40 space-y-1">
            <div>Loading dock: {space.access.loadingDock ? "Yes" : "No"}</div>
            <div>Forklift: {space.access.forklift ? "Yes" : "No"}</div>
          </div>
        </GlassPanel>
      </div>

      {/* CTA */}
      <div className="text-center">
        <button className="px-6 py-2.5 rounded-lg text-sm font-medium bg-green-500/20 border border-green-500/30 text-green-400 hover:bg-green-500/30 transition-all">
          Request This Space
        </button>
      </div>
    </div>
  );
}
