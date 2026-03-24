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

    case "wallet_balance": {
      const bal = card.data as Record<string, unknown>;
      return (
        <GlassPanel className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-white/40">Agent Wallet</span>
            <GlowBadge color="green">Connected</GlowBadge>
          </div>
          <div className="text-3xl font-mono text-emerald-400 drop-shadow-[0_0_12px_rgba(16,185,129,0.4)]">
            ${String(bal.balanceUsd ?? bal.balance ?? "0.00")}
          </div>
          <div className="text-xs text-white/40 font-mono">{String(bal.address ?? "").slice(0, 6)}...{String(bal.address ?? "").slice(-4)}</div>
          <div className="grid grid-cols-3 gap-2 pt-2 border-t border-white/[0.06]">
            <DataCell label="USDC" value={String(bal.usdc ?? "0")} />
            <DataCell label="Pending" value={String(bal.pending ?? "0")} />
            <DataCell label="Credits" value={String(bal.credits ?? "0")} />
          </div>
        </GlassPanel>
      );
    }

    case "fund_options": {
      const opts = card.data as Record<string, unknown>;
      const providers = (opts.providers ?? []) as Array<Record<string, unknown>>;
      return (
        <div className="grid grid-cols-2 gap-3">
          {providers.map((p, i) => (
            <GlassPanel key={i} className="p-4 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-white/80">{String(p.name)}</span>
                <GlowBadge color={p.name === "Stripe" ? "teal" : "gold"}>{String(p.region ?? "")}</GlowBadge>
              </div>
              <div className="text-xs text-white/40">{String(p.methods ?? "")}</div>
              <div className="text-[10px] text-emerald-400/60 flex items-center gap-1">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" /></svg>
                {String(p.trust ?? "Secure")}
              </div>
            </GlassPanel>
          ))}
        </div>
      );
    }

    case "onramp_session": {
      const sess = card.data as Record<string, unknown>;
      const session = sess.session as Record<string, unknown> | undefined;
      return (
        <GlassPanel className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-white/70">Funding Session Created</span>
            <GlowBadge color="teal">{String(sess.provider ?? "stripe")}</GlowBadge>
          </div>
          <div className="text-xs text-white/40 space-y-1">
            <div>Session: <span className="font-mono text-white/60">{String(session?.id ?? sess.sessionId ?? "").slice(0, 20)}...</span></div>
            <div>Amount: <span className="text-emerald-400">${String(session?.fiatAmount ?? sess.sourceAmount ?? "—")}</span></div>
            <div>Destination: <span className="text-teal-400">{String(session?.cryptoCurrency ?? "USDC")} on {String(session?.cryptoNetwork ?? "Base")}</span></div>
          </div>
          {sess.publishableKey ? (
            <div className="text-[10px] text-white/20 pt-2 border-t border-white/[0.06]">
              Complete payment in the Stripe widget above. Crypto will arrive in your wallet automatically.
            </div>
          ) : null}
        </GlassPanel>
      );
    }

    case "withdraw_form": {
      const wd = card.data as Record<string, unknown>;
      const submitted = wd.submitted as boolean;
      if (submitted) {
        const session = wd.session as Record<string, unknown> | undefined;
        return (
          <GlassPanel className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-white/70">Withdrawal Submitted</span>
              <StatusChip status="executing" label="Processing" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <DataCell label="Amount" value={`$${String(session?.cryptoAmount ?? wd.amountUsd ?? "0")}`} />
              <DataCell label="To" value={String(session?.fiatCurrency ?? wd.fiatCurrency ?? "—")} />
              <DataCell label="Rate" value={String(session?.rate ?? wd.rate ?? "—")} />
              <DataCell label="Reference" value={String(wd.reference ?? "—").slice(0, 12)} mono />
            </div>
            {wd.depositAddress ? (
              <div className="text-[10px] text-white/30 pt-2 border-t border-white/[0.06]">
                Send crypto to: <span className="font-mono text-white/50">{String(wd.depositAddress)}</span>
              </div>
            ) : null}
          </GlassPanel>
        );
      }
      // Not yet submitted — show available channels
      const channels = (wd.channels ?? []) as Array<Record<string, unknown>>;
      return (
        <GlassPanel className="p-4 space-y-3">
          <span className="text-[10px] uppercase tracking-wider text-white/40">Withdrawal Channels</span>
          <div className="space-y-2">
            {channels.map((ch, i) => (
              <div key={i} className="flex items-center gap-3 p-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                <span className="text-sm text-white/70">{String(ch.name)}</span>
                <GlowBadge color="gray">{String(ch.type)}</GlowBadge>
                <span className="text-xs text-white/30 ml-auto">{String(ch.currency)}</span>
              </div>
            ))}
          </div>
          <div className="text-[10px] text-white/20">Tell your agent the amount and destination to proceed.</div>
        </GlassPanel>
      );
    }

    case "provider_rates": {
      const rd = card.data as Record<string, unknown>;
      const rates = (rd.rates ?? []) as Array<Record<string, unknown>>;
      return (
        <GlassPanel className="p-4 space-y-3">
          <span className="text-[10px] uppercase tracking-wider text-white/40">Live Rates</span>
          <div className="space-y-1.5">
            {rates.map((r, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-white/60">{String(r.currency)}</span>
                <span className="font-mono text-white/80">1 USD = {String(r.buy ?? r.rate)} {String(r.currency)}</span>
              </div>
            ))}
          </div>
        </GlassPanel>
      );
    }

    case "ramp_activity": {
      const act = card.data as Record<string, unknown>;
      const sessions = (act.sessions ?? []) as Array<Record<string, unknown>>;
      return (
        <GlassPanel className="p-4 space-y-3">
          <span className="text-[10px] uppercase tracking-wider text-white/40">Recent Activity</span>
          <div className="space-y-2">
            {sessions.slice(0, 5).map((s, i) => (
              <div key={i} className="flex items-center gap-3 p-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                <span className={`text-sm ${s.direction === "onramp" ? "text-emerald-400" : "text-amber-400"}`}>
                  {s.direction === "onramp" ? "↓" : "↑"}
                </span>
                <GlowBadge color={s.provider === "stripe" ? "teal" : s.provider === "yellowcard" ? "gold" : "cyan"}>
                  {String(s.provider)}
                </GlowBadge>
                <span className="text-sm text-white/70 ml-auto">${String(s.fiatAmount ?? s.cryptoAmount ?? "0")}</span>
                <StatusChip status={toStatus(s.status === "completed" ? "completed" : s.status === "failed" ? "failed" : "executing")} />
              </div>
            ))}
          </div>
        </GlassPanel>
      );
    }

    case "credit_balance": {
      const cr = card.data as Record<string, unknown>;
      const balance = cr.balance as Record<string, unknown> | undefined;
      return (
        <GlassPanel className="p-4 space-y-3">
          <span className="text-[10px] uppercase tracking-wider text-white/40">API Credits</span>
          <div className="text-2xl font-mono text-emerald-400">
            {String(balance?.credits ?? cr.credits ?? "0")} credits
          </div>
          <div className="grid grid-cols-2 gap-2 pt-2 border-t border-white/[0.06]">
            <DataCell label="Deposited" value={`$${String(balance?.totalDeposited ?? "0")}`} />
            <DataCell label="Spent" value={String(balance?.totalSpent ?? "0")} />
          </div>
          <div className="text-[10px] text-white/20">100 credits = $1 USD. Ask your agent to top up.</div>
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
