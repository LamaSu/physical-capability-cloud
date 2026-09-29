import React from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { StatusBar } from "@pcc/ui";
import { useGatewayHealth, useProductHome } from "../api/hooks/use-pcc-data.js";
import { deriveHomeStatus } from "../lib/live-status.js";

/** How often the always-visible bar re-checks gateway liveness and re-reads its counts. */
export const STATUS_BAR_HEALTH_INTERVAL_MS = 30_000;

/**
 * Re-check gateway liveness as soon as any gateway read fails, instead of
 * waiting for the next poll. Without this, the bar could say "Gateway online"
 * for up to 30 s into an outage (operator-ux #2800). Returns the unsubscribe.
 */
export function recheckHealthOnReadFailure(client: QueryClient): () => void {
  return client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "error") return;
    if (event.query.queryKey[0] === "health") return;
    void client.invalidateQueries({ queryKey: ["health"] });
  });
}

/**
 * The dashboard shell's status bar. Its counts come from ProductHomeDTO
 * (readmodels #409), which the gateway counts over its own records, so the
 * active-job count is exact rather than a lower bound over one page. The
 * network label is the settlement network the gateway is configured for,
 * labelled as such.
 *
 * ProductHome is re-read on the same cadence as liveness, and at once when the
 * gateway answers again after a failed health check. Until that re-read lands,
 * deriveHomeStatus shows the counts as unavailable: a count from before the
 * outage is not certified by the recovered health check.
 */
export function LiveStatusBar() {
  const client = useQueryClient();
  React.useEffect(() => recheckHealthOnReadFailure(client), [client]);
  const health = useGatewayHealth({ refetchInterval: STATUS_BAR_HEALTH_INTERVAL_MS });
  const home = useProductHome({ refetchInterval: STATUS_BAR_HEALTH_INTERVAL_MS });

  const recovered = health.isSuccess && health.errorUpdatedAt > 0;
  React.useEffect(() => {
    if (recovered && home.dataUpdatedAt <= health.errorUpdatedAt) void home.refetch();
    // Re-read once per recovery; refetch is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recovered, health.errorUpdatedAt, health.dataUpdatedAt]);

  return <StatusBar {...deriveHomeStatus({ health, home }, Date.now())} />;
}
