/**
 * Equipment class detail: not live.
 *
 * The page looked its class up in api/mock-onboarding-data.ts, which is
 * empty, so every class read "Equipment class not found": a claim the
 * dashboard can't make. GET /api/marketplace/classes/:id is not a source: it
 * answers with six classes and snapshots written as literals in
 * routes/marketplace.ts and a price history generated from Math.sin. The page
 * now says the view isn't connected to live data and requests nothing. There
 * are no sample values to show, so it has no demo version.
 */

import React from "react";
import { useNavigate } from "react-router-dom";
import { GlassPanel } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { NotLiveState } from "../components/DemoState.js";

const CLASS_NOT_LIVE_DETAIL =
  "No gateway route serves real equipment classes yet. GET /api/marketplace/classes/:id returns fixed sample " +
  "classes and a generated price history, not network state, so nothing is shown here.";

export function MarketplaceDetailPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  React.useEffect(() => {
    setPageMeta("Equipment Class", "Market detail");
  }, [setPageMeta]);

  return (
    <div className="space-y-6 max-w-4xl">
      <button onClick={() => navigate("/marketplace")} className="text-xs text-white/30 hover:text-white/50 transition-colors">
        &larr; Back to Marketplace
      </button>

      <GlassPanel padding="lg">
        <NotLiveState what="Equipment class detail" detail={CLASS_NOT_LIVE_DETAIL} />
      </GlassPanel>
    </div>
  );
}
