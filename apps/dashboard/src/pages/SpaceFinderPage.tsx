import React from "react";
import { useNavigate } from "react-router-dom";
import { SpaceCard, GlassPanel } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useSpaceFinderStore } from "../stores/space-finder-store.js";
import { mockHostingSpaces } from "../api/mock-onboarding-data.js";

const baseInput = "w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 placeholder:text-white/20 focus:border-green-500/30 focus:outline-none transition-colors";

export function SpaceFinderPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { searchQuery, maxPrice, accessFilter, sortBy, setSearch, setMaxPrice, setAccessFilter, setSortBy } =
    useSpaceFinderStore();

  React.useEffect(() => {
    setPageMeta("Find a Space", "Browse hosting locations for your machines");
  }, [setPageMeta]);

  let spaces = mockHostingSpaces.filter((s) => {
    if (searchQuery && !s.name.toLowerCase().includes(searchQuery.toLowerCase()) && !s.address.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (accessFilter !== "all" && s.access.schedule !== accessFilter) return false;
    if (maxPrice > 0 && s.sqft && s.sqft > maxPrice) return false;
    return true;
  });

  spaces = [...spaces].sort((a, b) => {
    if (sortBy === "sqft") return (a.sqft ?? 0) - (b.sqft ?? 0);
    if (sortBy === "rating") return b.rating - a.rating;
    if (sortBy === "slots") return b.availableSlots - a.availableSlots;
    return b.rating - a.rating; // default "match"
  });

  return (
    <div className="space-y-6">
      {/* Filters */}
      <GlassPanel padding="md" className="flex items-end gap-4 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <label className="text-[10px] text-white/20 mb-1 block">Search</label>
          <input
            className={baseInput}
            placeholder="Location or name..."
            value={searchQuery}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="w-32">
          <label className="text-[10px] text-white/20 mb-1 block">Max Sqft</label>
          <input
            className={baseInput}
            type="number"
            placeholder="Any size"
            value={maxPrice || ""}
            onChange={(e) => setMaxPrice(+e.target.value)}
          />
        </div>
        <div>
          <label className="text-[10px] text-white/20 mb-1 block">Access</label>
          <div className="flex gap-1">
            {(["all", "24/7", "business-hours", "scheduled"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setAccessFilter(f)}
                className={`px-2 py-1.5 rounded text-[10px] ${
                  accessFilter === f ? "bg-green-500/15 text-green-400 border border-green-500/20" : "text-white/20 hover:text-white/40"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-[10px] text-white/20 mb-1 block">Sort</label>
          <div className="flex gap-1">
            {(["match", "sqft", "rating", "slots"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSortBy(s)}
                className={`px-2 py-1.5 rounded text-[10px] ${
                  sortBy === s ? "bg-white/[0.06] text-white/50" : "text-white/20"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </GlassPanel>

      {/* Results */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {spaces.map((s) => (
          <SpaceCard
            key={s.id}
            name={s.name}
            address={s.address}
            monthlyPrice={s.pricingPhase === "free" ? "Free" : s.monthlyPrice}
            currency={s.pricingPhase === "free" ? "" : s.currency}
            availableSlots={s.availableSlots}
            totalSlots={s.totalSlots}
            amenities={s.amenities}
            power={s.power}
            rating={s.rating}
            matchScore={Math.round(70 + Math.random() * 25)}
            accessSchedule={s.access.schedule}
            onClick={() => navigate(`/spaces/${s.id}`)}
          />
        ))}
      </div>

      {spaces.length === 0 && (
        <div className="text-center py-12 text-white/20 text-sm">
          No spaces match your filters
        </div>
      )}
    </div>
  );
}
