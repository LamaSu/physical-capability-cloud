import React from "react";
import { StatusBar } from "@pcc/ui";
import { useGatewayHealth, useJobs, useKernels } from "../api/hooks/use-pcc-data.js";
import { deriveLiveStatus } from "../lib/live-status.js";

/** How often the always-visible bar re-checks gateway liveness. */
export const STATUS_BAR_HEALTH_INTERVAL_MS = 30_000;

/**
 * The dashboard shell's status bar, fed by the same queries (and cache) as
 * the Command Center page. There is no network label: no read model serves
 * the settlement network yet, so none is shown.
 */
export function LiveStatusBar() {
  const health = useGatewayHealth({ refetchInterval: STATUS_BAR_HEALTH_INTERVAL_MS });
  const kernels = useKernels();
  const jobs = useJobs();
  return <StatusBar {...deriveLiveStatus({ health, kernels, jobs })} />;
}
