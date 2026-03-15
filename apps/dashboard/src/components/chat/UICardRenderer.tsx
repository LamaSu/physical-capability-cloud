import React from "react";
import type { UICard } from "../../agent/agent-types.js";
import {
  GlassPanel,
  CapabilityCard,
  KernelCard,
  ContractSummary,
  MilestoneTimeline,
  EvidenceTimeline,
  PriceBreakdownChart,
  ProgressArc,
  StatusChip,
  BondDisplay,
  ChallengeWindowBar,
  GlowBadge,
  DataCell,
} from "@pcc/ui";

interface UICardRendererProps {
  card: UICard;
}

type ValidStatus = "online" | "executing" | "completed" | "failed" | "offline";
const validStatuses: ValidStatus[] = ["online", "executing", "completed", "failed", "offline"];
function toStatus(s: unknown): ValidStatus {
  if (typeof s === "string" && validStatuses.includes(s as ValidStatus)) return s as ValidStatus;
  return "offline";
}

export function UICardRenderer({ card }: UICardRendererProps) {
  switch (card.type) {
    case "capability_card":
      return (
        <GlassPanel className="p-3">
          <CapabilityCard capability={card.data.capability as never ?? card.data.options as never} />
        </GlassPanel>
      );

    case "capability_grid": {
      const items = (card.data.capabilities ?? card.data.types ?? []) as unknown[];
      return (
        <div className="grid grid-cols-2 gap-2">
          {items.slice(0, 6).map((item, i) => (
            <GlassPanel key={i} className="p-2">
              {typeof item === "string" ? (
                <div className="text-sm text-teal-300/80 font-mono">{item}</div>
              ) : (
                <CapabilityCard capability={item as never} />
              )}
            </GlassPanel>
          ))}
        </div>
      );
    }

    case "kernel_card":
      return (
        <GlassPanel className="p-3">
          <KernelCard kernel={card.data.kernel as never} />
        </GlassPanel>
      );

    case "contract_summary":
      return (
        <GlassPanel className="p-3">
          <ContractSummary contract={card.data.contract as never} />
        </GlassPanel>
      );

    case "milestone_timeline":
      return (
        <GlassPanel className="p-3">
          <MilestoneTimeline milestones={card.data.milestones as never[]} />
        </GlassPanel>
      );

    case "evidence_timeline":
      return (
        <GlassPanel className="p-3">
          <EvidenceTimeline events={card.data.events as never[]} />
        </GlassPanel>
      );

    case "price_breakdown": {
      const pricing = card.data.pricing as Record<string, unknown> | undefined;
      return (
        <GlassPanel className="p-3">
          <PriceBreakdownChart
            breakdown={(pricing?.breakdown as never[]) ?? []}
            basePrice={String(pricing?.basePrice ?? "0")}
            totalPrice={String(pricing?.totalPrice ?? "0")}
          />
        </GlassPanel>
      );
    }

    case "job_progress": {
      const job = card.data.job as Record<string, unknown>;
      return (
        <GlassPanel className="p-3 flex items-center gap-3">
          <ProgressArc progress={(job?.progress as number) ?? 0} size={48} />
          <div className="flex-1 min-w-0">
            <div className="text-sm text-white/80 font-medium truncate">
              {String(job?.name ?? job?.id ?? "Job")}
            </div>
            <div className="text-xs text-white/40">{String(job?.type ?? "unknown")}</div>
          </div>
          <StatusChip status={toStatus(job?.status)} />
        </GlassPanel>
      );
    }

    case "escrow_summary": {
      const escrow = card.data.escrow as Record<string, unknown>;
      return (
        <GlassPanel className="p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-white/70">{String(escrow?.id ?? "Escrow")}</span>
            <StatusChip status={toStatus(escrow?.status)} />
          </div>
          {escrow?.bond ? <BondDisplay config={escrow.bond as never} /> : null}
          {escrow?.challengeWindow ? (
            <ChallengeWindowBar
              start={String((escrow.challengeWindow as Record<string, unknown>)?.start ?? "")}
              end={String((escrow.challengeWindow as Record<string, unknown>)?.end ?? "")}
            />
          ) : null}
        </GlassPanel>
      );
    }

    case "wallet_connect":
      return (
        <GlassPanel className="p-4 text-center space-y-2">
          <div className="text-sm text-white/60">Connect your wallet to interact with the PCC network</div>
          <GlowBadge color="teal">Wallet Required</GlowBadge>
        </GlassPanel>
      );

    case "sensor_chart":
      return (
        <GlassPanel className="p-3">
          <DataCell label="Sensor Data" value="View live sensor dashboard for real-time charts" />
        </GlassPanel>
      );

    case "depin_stats": {
      const stats = card.data as Record<string, unknown>;
      return (
        <GlassPanel className="p-3 grid grid-cols-3 gap-3">
          <DataCell label="Treasury" value={String(stats.treasury ?? "—")} />
          <DataCell label="Certificates" value={String(stats.certificates ?? "—")} />
          <DataCell label="Reward Epochs" value={String(stats.epochs ?? "—")} />
        </GlassPanel>
      );
    }

    default:
      return (
        <GlassPanel className="p-3 text-xs text-white/40">
          Unknown card type: {card.type}
        </GlassPanel>
      );
  }
}
