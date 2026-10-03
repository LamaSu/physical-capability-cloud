/**
 * Find a Space: not live.
 *
 * The page listed hosting spaces from api/mock-onboarding-data.ts, which is
 * empty, so it always said "No spaces match your filters": a claim about the
 * network the dashboard can't make. Its cards also carried a match score made
 * with Math.random. No gateway route serves real hosting spaces: GET
 * /api/spaces, GET /api/spaces/:id and POST /api/spaces/match
 * (routes/spaces.ts) answer with two spaces written as literals, the match
 * with a random score, and no route reads the hosting_spaces table.
 *
 * The page now says so and requests nothing. It offers no search, filters or
 * sorting over data it doesn't have. There are no sample spaces to show, so it
 * has no demo version.
 */

import React from "react";
import { GlassPanel } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { NotLiveState } from "../components/DemoState.js";

const SPACES_NOT_LIVE_DETAIL =
  "No gateway route serves real hosting spaces yet. GET /api/spaces and POST /api/spaces/match return " +
  "fixed sample spaces (the match with a random score), not listings, so nothing is shown here.";

export function SpaceFinderPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  React.useEffect(() => {
    setPageMeta("Find a Space", "Hosting locations for your machines");
  }, [setPageMeta]);

  return (
    <GlassPanel padding="lg">
      <NotLiveState what="The hosting-space directory" detail={SPACES_NOT_LIVE_DETAIL} />
    </GlassPanel>
  );
}
