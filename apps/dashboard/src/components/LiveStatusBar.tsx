import React from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { StatusBar } from "@pcc/ui";
import { useGatewayHealth, useJobs, useKernels } from "../api/hooks/use-pcc-data.js";
import { deriveLiveStatus } from "../lib/live-status.js";

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
 * The dashboard shell's status bar, fed by the same queries (and cache) as
 * the Command Center page. There is no network label: no read model serves
 * the settlement network yet, so none is shown.
 *
 * Its counts are re-read on the same cadence as liveness, and at once when the
 * gateway answers again after a failed health check. Until that re-read lands,
 * deriveLiveStatus shows them as unavailable: a count from before the outage is
 * not certified by the recovered health check.
 */
export function LiveStatusBar() {
  const client = useQueryClient();
  React.useEffect(() => recheckHealthOnReadFailure(client), [client]);
  const health = useGatewayHealth({ refetchInterval: STATUS_BAR_HEALTH_INTERVAL_MS });
  const kernels = useKernels(undefined, { refetchInterval: STATUS_BAR_HEALTH_INTERVAL_MS });
  const jobs = useJobs(undefined, { refetchInterval: STATUS_BAR_HEALTH_INTERVAL_MS });

  const recovered = health.isSuccess && health.errorUpdatedAt > 0;
  React.useEffect(() => {
    if (!recovered) return;
    if (kernels.dataUpdatedAt <= health.errorUpdatedAt) void kernels.refetch();
    if (jobs.dataUpdatedAt <= health.errorUpdatedAt) void jobs.refetch();
    // Re-read once per recovery; the refetch functions are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recovered, health.errorUpdatedAt, health.dataUpdatedAt]);

  return <StatusBar {...deriveLiveStatus({ health, kernels, jobs }, Date.now())} />;
}
