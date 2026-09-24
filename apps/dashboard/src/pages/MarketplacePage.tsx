/**
 * Equipment Marketplace: one live section, and a market overview that isn't live.
 *
 * Live: TemplateMatchFinder ranks the onboarding templates against what the
 * viewer types, through POST /api/capabilities/templates/match (a keyword
 * matcher over the template directory in routes/orchestrator-templates.ts).
 *
 * Not live: equipment classes, demand and supply, the demand map, capability
 * trends and price history. The page used to take all of them from
 * api/mock-onboarding-data.ts, whose exports are empty, so it showed a market
 * with nothing in it ("Equipment Classes (0)"): a claim about the network,
 * not a fact. No gateway route serves real market data. GET
 * /api/marketplace/classes returns six classes and snapshots written as
 * literals in routes/marketplace.ts, GET /api/marketplace/demand-supply returns
 * a curve generated from Math.sin, and nothing serves a demand map or
 * capability trends. That section now says so and requests nothing. There
 * are no sample values to show, so it has no demo version.
 */

import React from "react";
import { useNavigate } from "react-router-dom";
import { GlassPanel } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { NotLiveState } from "../components/DemoState.js";
import { TemplateMatchFinder } from "../components/marketplace/TemplateMatchFinder.js";

const MARKET_NOT_LIVE_DETAIL =
  "No gateway route serves real equipment classes, demand, supply or prices yet. " +
  "GET /api/marketplace/classes and /api/marketplace/demand-supply return fixed sample records " +
  "and a generated curve, not network state, so nothing is shown here.";

export function MarketplacePage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  React.useEffect(() => {
    setPageMeta("Equipment Marketplace", "Demand, supply, and pricing insights");
  }, [setPageMeta]);

  return (
    <div className="space-y-6">
      {/* Live: ranks the onboarding templates against the viewer's description */}
      <TemplateMatchFinder />

      {/* Not live: equipment classes, demand, supply, trends and prices */}
      <GlassPanel padding="lg">
        <NotLiveState what="The equipment market overview" detail={MARKET_NOT_LIVE_DETAIL} />
      </GlassPanel>

      {/* ROI link: a planning tool over the viewer's own numbers */}
      <div className="text-center">
        <button
          onClick={() => navigate("/marketplace/roi")}
          className="px-4 py-2 rounded-lg text-xs font-medium bg-green-500/10 border border-green-500/20 text-green-400/70 hover:bg-green-500/20 transition-all"
        >
          ROI Calculator &rarr;
        </button>
      </div>
    </div>
  );
}
