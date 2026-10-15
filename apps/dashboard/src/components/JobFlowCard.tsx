import React from "react";
import { GlowBadge } from "@pcc/ui";
import type { EvidenceAxisState, JobExecutionDTO, PayoutState, SettlementLink } from "@pcc/spec";
import { PHASE_VIEW, NOTICE_TEXT } from "../lib/job-execution-view.js";
import { moneyToneColor } from "../lib/money-badge.js";

const EVIDENCE_COPY: Record<EvidenceAxisState, string> = {
  none: "No evidence received",
  received: "Evidence received (not verified here)",
  unavailable: "Evidence could not be read",
};
const PAYOUT_COPY: Record<PayoutState, string> = {
  paid: "Paid",
  reported_released: "Reported released (payment not confirmed)",
  refunded: "Refunded to the payer (operator not paid)",
  not_paid: "Not paid: no release in the settlement record",
  simulated: "Simulated settlement: no money moved",
  unknown: "Payment status unknown",
};
const LINK_COPY: Record<SettlementLink, string> = {
  linked: "Settlement record linked",
  not_linked: "No settlement record linked",
  ambiguous: "Settlement link ambiguous",
  conflicting: "Settlement links conflict",
  unavailable: "Settlement record could not be read",
};
const CAPTURE_COPY = {
  none: "No capture checks recorded",
  present: "Capture-check counts",
  unavailable: "Capture checks could not be read",
};

/** Steward R15(b): this exception is exactly these three clauses. */
export function isFailedPrintWithNoRelease(dto: JobExecutionDTO): boolean {
  return dto.execution.phase === "failed"
    && dto.settlement.payout === "unknown"
    && dto.settlement.link === "not_linked";
}

function fixed<T extends string>(copy: Record<T, string>, value: string, fallback: string): string {
  return Object.prototype.hasOwnProperty.call(copy, value) ? copy[value as T] : fallback;
}

function traceHref(jobId: string): string | null {
  const template: unknown = import.meta.env.VITE_DEMO_TRACE_URL_TEMPLATE;
  if (typeof template !== "string" || !template.includes("{jobId}") || /[\\\u0000-\u0020\u007f]/.test(template)) return null;
  const href = template.replaceAll("{jobId}", encodeURIComponent(jobId));
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  if (!href.startsWith("https://")) return null;
  try {
    return new URL(href).protocol === "https:" ? href : null;
  } catch {
    return null;
  }
}

function explorerHref(dto: JobExecutionDTO): string | null {
  const hex: unknown = dto.settlement.record?.contractAddress ?? import.meta.env.VITE_VNEXT_ESCROW_ADDRESS;
  if (typeof hex !== "string") return null;
  const kind = /^0x[0-9a-fA-F]{40}$/.test(hex) ? "address" : /^0x[0-9a-fA-F]{64}$/.test(hex) ? "tx" : null;
  return kind ? `https://sepolia.basescan.org/${kind}/${hex}` : null;
}

function Trace({ href }: { href: string | null }) {
  return href ? <a className="underline" href={href}>Trace JSON</a> : <span>trace not linked</span>;
}

function count(value: number | null): string | number {
  return value === null ? "could not be read" : value;
}

function short(value: string): string {
  return value.length > 16 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value;
}

function Row({ label, children, tone }: { label: string; children: React.ReactNode; tone?: string }) {
  return <section aria-label={label} data-tone={tone} className="border-b border-white/10 p-4 last:border-0">
    <h3 className="font-semibold text-white/80 mb-2">{label}</h3>
    <div className="space-y-1 text-sm text-white/60 break-words [overflow-wrap:anywhere]">{children}</div>
  </section>;
}

/** A text-only projection. No fetching, side effects, raw status claims or DTO-provided links. */
export function JobFlowCard({ dto, stale }: { dto: JobExecutionDTO; stale: boolean }) {
  const trace = traceHref(dto.job.jobId);
  const explorer = explorerHref(dto);
  const noRelease = isFailedPrintWithNoRelease(dto);
  const tone = stale || noRelease ? "unknown" : (dto.settlement.record?.escrow?.tone ?? "unknown");
  const phase = Object.prototype.hasOwnProperty.call(PHASE_VIEW, dto.execution.phase)
    ? PHASE_VIEW[dto.execution.phase].label : "Print phase unknown";
  const cc = dto.verification.captureChecks;
  return <article aria-label="Job flow" className="rounded-xl border border-white/10 bg-white/[0.03] [&_p]:line-clamp-3 [&_li]:line-clamp-3">
    <Row label="Job">
      <p>Job id: {dto.job.jobId} · Step id: {dto.job.stepId}</p>
      <p>Capability id: {dto.job.capabilityId} · Kernel id: {dto.job.kernelId}</p>
      <p>Capability name: {dto.job.capabilityName ?? "not recorded"} · Capability type: {dto.job.capabilityType ?? "not recorded"}</p>
      <p>Kernel name: {dto.job.kernelName ?? "not recorded"}</p>
      <p>Contracted tier: {dto.job.contractedTier ?? "not recorded"}</p>
      <p>created: {dto.job.createdAt ?? "not recorded"}</p>
    </Row>
    <Row label="Print">
      <p>{dto.execution.phase === "unknown" ? "Print phase unknown" : phase}</p>
      {dto.execution.progressPercent !== null && <p>Reported progress: {dto.execution.progressPercent}%</p>}
      <p>Source completion time: {dto.execution.completedAt ?? "not recorded"}</p>
      <p>read at {dto.asOf}</p>
    </Row>
    <Row label="Evidence">
      <p>{fixed(EVIDENCE_COPY, dto.evidence.state, "Evidence state unknown")}</p>
      <p>Bundles: {count(dto.evidence.bundleCount)} · Events: {count(dto.evidence.eventCount)} · Fabricated events: {count(dto.evidence.fabricatedEventCount)}</p>
      {dto.evidence.error && <p>Evidence could not be read</p>}
      <ul className="space-y-1">
        {dto.evidence.bundles.slice(0, 20).map((bundle, index) => <li key={index}>
          Bundle id: {short(bundle.bundleId)} · Hash: {short(bundle.bundleHash)} · claimed tier: {bundle.claimedTier} · stored at {bundle.storedAt}
        </li>)}
      </ul>
      {dto.evidence.truncated && <p>Evidence list truncated (up to 20 bundles shown)</p>}
    </Row>
    <Row label="Outcome verdict">
      <p>{dto.verification.outcome.state === "not_available" ? "Outcome verdict: not available in this view" : "Outcome verdict: unknown"} · <Trace href={trace} /></p>
      <p>{fixed(CAPTURE_COPY, cc.state, "Capture-check state unknown")}</p>
      <p>Capture-check counts: pass {count(cc.pass)} · partial {count(cc.partial)} · fail {count(cc.fail)} · unrecognized {count(cc.unrecognized)}</p>
      {cc.error && <p>Capture checks could not be read</p>}
    </Row>
    <Row label="Money" tone={tone}>
      <div className="flex flex-wrap items-center gap-2">
        <GlowBadge color={moneyToneColor(tone)}>{noRelease ? "Not paid: no release recorded" : fixed(PAYOUT_COPY, dto.settlement.payout, "Payment status unknown")}</GlowBadge>
        {noRelease && <Trace href={trace} />}
        {explorer ? <a className="underline" href={explorer}>Base Sepolia explorer</a> : <span>explorer link not configured</span>}
      </div>
      <p>{fixed(LINK_COPY, dto.settlement.link, "Settlement link unknown")}</p>
      {dto.settlement.error && <p>Settlement record could not be read</p>}
    </Row>
    <Row label="Notices">
      <ul>{dto.notices.map((notice, index) => <li key={index}>{notice === "unknown_execution_status"
        ? "Print phase unknown"
        : fixed(NOTICE_TEXT, notice, "Notice unknown")}</li>)}</ul>
      {dto.notices.length === 0 && <p>No notices reported</p>}
    </Row>
  </article>;
}
