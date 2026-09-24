import React from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { StatusBar } from "@pcc/ui";
import { useGatewayHealth, useJobs, useKernels } from "../api/hooks/use-pcc-data.js";
import { deriveLiveStatus } from "../lib/live-status.js";

/** How often the always-visible bar re-checks gateway liveness. */
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
 */
export function LiveStatusBar() {
  const client = useQueryClient();
  React.useEffect(() => recheckHealthOnReadFailure(client), [client]);
  const health = useGatewayHealth({ refetchInterval: STATUS_BAR_HEALTH_INTERVAL_MS });
  const kernels = useKernels();
  const jobs = useJobs();
  return <StatusBar {...deriveLiveStatus({ health, kernels, jobs })} />;
}
