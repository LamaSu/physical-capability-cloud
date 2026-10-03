import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { GlassPanel, EmptyState } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { APP_HOME } from "../lib/workspaces.js";

/** Shown for an app path that matches no page, instead of a blank content area. */
export function NotFoundPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  React.useEffect(() => { setPageMeta("Not found", pathname); }, [setPageMeta, pathname]);

  return (
    <GlassPanel padding="lg">
      <EmptyState
        title="Page not found"
        description={`Nothing lives at ${pathname}. It may have moved, or the link may be wrong.`}
        action={{ label: "Go to the Command Center", onClick: () => navigate(APP_HOME) }}
      />
    </GlassPanel>
  );
}
