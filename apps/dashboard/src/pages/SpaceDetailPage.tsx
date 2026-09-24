/**
 * Space detail: not live.
 *
 * The page looked its space up in api/mock-onboarding-data.ts, which is
 * empty, so every space read "Space not found": a claim the dashboard can't
 * make. Its "Request This Space" button had no handler, so a click did
 * nothing while looking like a request. GET /api/spaces/:id is not a source:
 * it answers with the two spaces written as literals in routes/spaces.ts, and
 * no gateway route accepts a request for a space.
 *
 * The page now says the view isn't connected to live data, requests nothing,
 * and offers no request action. There are no sample spaces to show, so it has
 * no demo version.
 */

import React from "react";
import { useNavigate } from "react-router-dom";
import { GlassPanel } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { NotLiveState } from "../components/DemoState.js";

const SPACE_NOT_LIVE_DETAIL =
  "No gateway route serves real hosting spaces yet: GET /api/spaces/:id returns fixed sample spaces, not " +
  "listings, and no route accepts a request for a space. Nothing is shown here, and no request can be sent from this page.";

export function SpaceDetailPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  React.useEffect(() => {
    setPageMeta("Space Detail", "Hosting location details");
  }, [setPageMeta]);

  return (
    <div className="space-y-6 max-w-4xl">
      <button onClick={() => navigate("/spaces")} className="text-xs text-white/30 hover:text-white/50 transition-colors">
        &larr; Back to Spaces
      </button>

      <GlassPanel padding="lg">
        <NotLiveState what="Hosting-space detail" detail={SPACE_NOT_LIVE_DETAIL} />
      </GlassPanel>
    </div>
  );
}
