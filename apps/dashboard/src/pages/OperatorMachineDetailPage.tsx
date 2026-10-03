import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { GlassPanel, GlowBadge } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { UnavailableState } from "../components/LiveState.js";
import { NotRecordedState } from "../components/operator/NotRecordedState.js";
import { DiscoverabilityPanel } from "../components/operator/DiscoverabilityPanel.js";
import { RatingsPanel } from "../components/operator/RatingsPanel.js";
import { RateSubmitForm } from "../components/operator/RateSubmitForm.js";
import { EditDeleteBar } from "../components/operator/EditDeleteBar.js";
import { readRegistration } from "../lib/operator-api.js";

/**
 * One machine registration (GET /api/onboard/registrations/:id).
 *
 * The header comes from the real registration. Utilization, uptime, earnings
 * and maintenance are not recorded anywhere yet, so they say so. The four
 * panels below read and write the gateway directly.
 */

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

export function OperatorMachineDetailPage() {
  const { machineId } = useParams<{ machineId: string }>();
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const reg = useQuery({
    queryKey: ["operator-registration", machineId],
    queryFn: async () => {
      const r = await readRegistration(machineId!);
      if (!r.ok) throw new Error(r.reason);
      return r.data;
    },
    enabled: !!machineId,
    retry: 1,
  });

  const registration = reg.data && reg.data.found ? reg.data.registration : null;
  const name = registration ? text(registration.name) ?? machineId ?? "" : null;

  React.useEffect(() => {
    setPageMeta(name ?? "Machine detail", "Machine management");
  }, [setPageMeta, name]);

  const back = (
    <button onClick={() => navigate("/operator")} className="text-xs text-white/30 hover:text-white/50 transition-colors">
      &larr; Back to Operator Dashboard
    </button>
  );

  if (!machineId) return <div className="text-center py-12 text-white/30">No machine selected.</div>;
  if (reg.isLoading) return <div className="space-y-6 max-w-4xl">{back}<GlassPanel padding="lg" className="text-center text-xs text-white/30">Loading…</GlassPanel></div>;
  if (reg.isError || !reg.data) {
    return (
      <div className="space-y-6 max-w-4xl">
        {back}
        <GlassPanel padding="lg">
          <UnavailableState what="this machine" error={reg.error} onRetry={() => void reg.refetch()} />
        </GlassPanel>
      </div>
    );
  }
  if (!registration) {
    return (
      <div className="text-center py-12 space-y-2">
        <p className="text-white/40">No machine registration with id <span className="font-mono">{machineId}</span>.</p>
        <button onClick={() => navigate("/operator")} className="text-xs text-green-400/60">&larr; Back</button>
      </div>
    );
  }

  const manufacturer = text(registration.manufacturer);
  const model = text(registration.model);
  const category = text(registration.category);
  const status = text(registration.status);

  return (
    <div className="space-y-6 max-w-4xl">
      {back}

      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-semibold text-white/90">{name}</h2>
            {category && <GlowBadge color="green">{category}</GlowBadge>}
            {status && <GlowBadge color="gold">{status}</GlowBadge>}
          </div>
          {(manufacturer || model) && <p className="text-sm text-white/40 mt-1">{[manufacturer, model].filter(Boolean).join(" ")}</p>}
        </div>
      </div>

      <GlassPanel padding="md">
        <NotRecordedState
          what="utilization, uptime or completed-job counts for this machine"
          detail="Your in-flight work is listed on the operator dashboard and in Jobs."
        />
      </GlassPanel>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <DiscoverabilityPanel operatorId={machineId} />
        <RatingsPanel operatorId={machineId} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <RateSubmitForm operatorId={machineId} />
        <EditDeleteBar
          operatorId={machineId}
          initialDescription={text(registration.description) ?? [manufacturer, model].filter(Boolean).join(" ")}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <GlassPanel padding="md">
          <NotRecordedState what="earnings for this machine" detail="A job's own payment state is shown on its job page, from the escrow record." />
        </GlassPanel>
        <GlassPanel padding="md">
          <NotRecordedState what="maintenance windows" detail="Nothing records maintenance events yet." />
        </GlassPanel>
      </div>
    </div>
  );
}
