import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { GlassPanel, StatusChip, DataCell, HashDisplay, AddressDisplay, GlowBadge, LoadingShell } from "@pcc/ui";
import type { JobExecutionDTO } from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { useJobExecution } from "../api/hooks/use-pcc-data.js";
import { ApiError } from "../api/gateway.js";
import {
  PHASE_VIEW,
  PAYOUT_VIEW,
  SOURCE_LABEL,
  NOTICE_TEXT,
  settlementLinkText,
  payoutBasisText,
  recordStatusBadge,
  freshness,
  evidenceSummaryText,
  jobTitle,
} from "../lib/job-execution-view.js";

/**
 * Job detail: a projection of the gateway's JobExecutionDTO (GET /api/jobs/:jobId/execution).
 *
 * Every value on this page comes from that read model. There are no fixtures and no
 * fallbacks. A job that cannot be read says so, and a read that is too old, or whose
 * refresh failed, is visibly marked stale. The four panels are independent: work
 * reported complete is not payment, and evidence received is not verification. Only the
 * payout badge can be green; the recorded escrow and milestone statuses are neutral text.
 */
export function JobDetailPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { data, error, isLoading, isFetching, refetch } = useJobExecution(jobId);

  React.useEffect(() => {
    setPageMeta(
      data ? jobTitle(data) : `Job ${jobId ?? ""}`,
      "What the executor reported, the evidence held, and what the settlement record says",
    );
  }, [setPageMeta, data, jobId]);

  const back = (
    <button onClick={() => navigate("/jobs")} className="text-xs text-white/30 hover:text-white/50 mb-2">
      ← Back to jobs
    </button>
  );

  if (isLoading) return <LoadingShell rows={6} />;

  if (!data) {
    const status = error instanceof ApiError ? error.status : null;
    const notFound = status === 404;
    const signedOut = status === 401;
    return (
      <GlassPanel padding="lg">
        {back}
        <div role="alert" className="text-center py-8">
          <div className="text-white/70">
            {notFound ? "Job not found" : signedOut ? "Sign in to see this job" : "Job details are unavailable right now"}
          </div>
          <p className="text-xs text-white/40 mt-2">
            {notFound
              ? `No job with id ${jobId} exists, or it is not visible to you.`
              : signedOut
                ? "Only the job's buyer, its operator, or an admin can read it."
                : "The gateway could not be read. Nothing is shown until it can be."}
          </p>
          {!notFound && !signedOut && (
            <button onClick={() => refetch()} className="mt-3 text-xs text-teal-300/80 hover:text-teal-300">
              Try again
            </button>
          )}
        </div>
      </GlassPanel>
    );
  }

  const phase = PHASE_VIEW[data.execution.phase];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          {back}
          <h2 className="text-xl font-semibold text-white/90">{jobTitle(data)}</h2>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-xs text-white/30 font-mono">{data.job.jobId}</span>
            {data.job.contractedTier !== null && (
              <span className="text-xs text-white/40">Contracted assurance tier {data.job.contractedTier}</span>
            )}
          </div>
        </div>
        <StatusChip status={phase.pulse} label={phase.label} />
      </div>

      <Freshness asOf={data.asOf} terminal={data.execution.terminal} refreshFailed={!!error} refreshing={isFetching} />

      {data.notices.length > 0 && (
        <GlassPanel padding="md">
          <ul role="status" className="space-y-1 text-xs text-gold-300">
            {data.notices.map((n) => (
              <li key={n}>⚠ {NOTICE_TEXT[n]}</li>
            ))}
          </ul>
        </GlassPanel>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ExecutionPanel data={data} />
        <SettlementPanel data={data} />
        <EvidencePanel data={data} />
        <VerificationPanel data={data} />
      </div>

      <InspectPanel data={data} />
    </div>
  );
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "not recorded";
}

function Freshness({
  asOf,
  terminal,
  refreshFailed,
  refreshing,
}: {
  asOf: string;
  terminal: boolean;
  refreshFailed: boolean;
  refreshing: boolean;
}) {
  // Re-evaluate the age every few seconds, so a read that stops refreshing goes stale on
  // screen even when nothing else re-renders the page.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);
  const f = freshness(asOf, now, terminal, refreshFailed);
  return (
    <div className="text-[11px] text-white/35">
      Read {new Date(asOf).toLocaleString()}
      {f.reason === "refresh_failed" ? (
        <span className="text-gold-300"> · The latest refresh failed; this is the last successful read.</span>
      ) : f.reason === "too_old" ? (
        <span className="text-gold-300"> · This read is out of date; it has not been refreshed recently.</span>
      ) : refreshing ? (
        <span> · Refreshing…</span>
      ) : null}
    </div>
  );
}

function PanelTitle({ children, source }: { children: React.ReactNode; source: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider">{children}</h3>
      <div className="text-[10px] text-white/25">Source: {source}</div>
    </div>
  );
}

function ExecutionPanel({ data }: { data: JobExecutionDTO }) {
  const e = data.execution;
  return (
    <GlassPanel padding="lg">
      <PanelTitle source={SOURCE_LABEL[e.source]}>Work</PanelTitle>
      <div className="grid grid-cols-2 gap-4">
        <DataCell label="Status" value={PHASE_VIEW[e.phase].label} />
        <DataCell
          label="Reported progress"
          value={e.progressPercent !== null ? `${e.progressPercent}%` : "none reported"}
          mono
        />
        <DataCell label="Executor" value={data.job.kernelName ?? data.job.kernelId} sub={data.job.kernelId} />
        <DataCell label="Completed" value={when(e.completedAt)} />
        <DataCell label="Job created" value={when(data.job.createdAt)} />
      </div>
    </GlassPanel>
  );
}

function SettlementPanel({ data }: { data: JobExecutionDTO }) {
  const s = data.settlement;
  const payout = PAYOUT_VIEW[s.payout];
  const linkText = settlementLinkText(s);
  const basis = payoutBasisText(s);
  const r = s.record;
  return (
    <GlassPanel padding="lg">
      <PanelTitle source={SOURCE_LABEL[s.source]}>Payment</PanelTitle>
      <div className="flex items-center gap-2 mb-2">
        <GlowBadge color={payout.color}>{payout.label}</GlowBadge>
      </div>
      {basis && <div className="text-xs text-white/40 mb-3">{basis}</div>}
      {linkText && <div className="text-xs text-white/50">{linkText}</div>}
      {r && (
        <div className="grid grid-cols-2 gap-4 mt-2">
          {r.milestone && (
            <DataCell
              label="This job's milestone (record)"
              value={<RecordBadge {...recordStatusBadge(r.milestone.status, r.simulated)} />}
              sub={`${r.milestone.amount} ${r.escrowTotal.currency} (recorded, not paid)`}
            />
          )}
          <DataCell
            label="Escrow (record)"
            value={<RecordBadge {...recordStatusBadge(r.escrow, r.simulated)} />}
            sub={`${r.escrowTotal.amount} ${r.escrowTotal.currency} total (recorded)`}
          />
          {r.milestone?.challengeWindowEnd && (
            <DataCell label="Challenge window ends" value={when(r.milestone.challengeWindowEnd)} />
          )}
          <DataCell label="Deadline" value={when(r.deadline)} />
        </div>
      )}
    </GlassPanel>
  );
}

/** A recorded status: always neutral (see recordStatusBadge). */
function RecordBadge({ color, label }: { color: "green" | "gold" | "red" | "gray"; label: string }) {
  return <GlowBadge color={color}>{label}</GlowBadge>;
}

function EvidencePanel({ data }: { data: JobExecutionDTO }) {
  const e = data.evidence;
  return (
    <GlassPanel padding="lg">
      <PanelTitle source={SOURCE_LABEL[e.source]}>Evidence</PanelTitle>
      <div className="text-xs text-white/60 mb-3">{evidenceSummaryText(e)}</div>
      {(e.fabricatedEventCount ?? 0) > 0 && (
        <div className="text-xs text-gold-300 mb-3">
          {e.fabricatedEventCount} of {e.eventCount} events are from simulated or mock sources.
        </div>
      )}
      {e.bundles.length > 0 && (
        <ul className="space-y-2">
          {e.bundles.map((b) => (
            <li key={b.bundleId} className="flex items-center justify-between gap-3 text-xs">
              <span className="text-white/50">{when(b.storedAt)}</span>
              <span className="text-white/40">
                {b.eventCount} event{b.eventCount === 1 ? "" : "s"} · claims tier {b.claimedTier}
              </span>
              <HashDisplay hash={b.bundleHash} />
            </li>
          ))}
        </ul>
      )}
      {e.truncated && <div className="text-[11px] text-white/30 mt-2">Showing the newest {e.bundles.length} of {e.bundleCount}.</div>}
    </GlassPanel>
  );
}

function VerificationPanel({ data }: { data: JobExecutionDTO }) {
  const v = data.verification;
  const cc = v.captureChecks;
  return (
    <GlassPanel padding="lg">
      <PanelTitle source={SOURCE_LABEL[cc.source]}>Verification</PanelTitle>
      <div className="text-xs text-white/60 mb-3">No outcome verification is published for this job.</div>
      <div className="text-xs text-white/50">
        {cc.state === "unavailable"
          ? "Capture checks could not be read."
          : cc.state === "none"
            ? "No capture checks are recorded."
            : `Capture checks: ${cc.pass} passed · ${cc.partial} partial · ${cc.fail} failed${cc.unrecognized ? ` · ${cc.unrecognized} unrecognized` : ""}`}
      </div>
      <div className="text-[10px] text-white/25 mt-2">
        A capture check grades a photo or recording's authenticity class. It does not verify the job outcome
        or release payment.
      </div>
    </GlassPanel>
  );
}

function InspectPanel({ data }: { data: JobExecutionDTO }) {
  const r = data.settlement.record;
  const rows: Array<[string, React.ReactNode]> = [
    ["schema", data.schemaId],
    ["job id", data.job.jobId],
    ["step id", data.job.stepId],
    ["capability id", data.job.capabilityId],
    ["kernel id", data.job.kernelId],
    ["job row status", data.execution.sourceStatus],
    ["settlement link", `${data.settlement.link}${data.settlement.linkBasis ? ` (${data.settlement.linkBasis})` : ""}`],
  ];
  if (r) {
    rows.push(
      ["escrow id", r.escrowId],
      ["escrow contract", r.simulated ? `${r.contractAddress} (simulated)` : <AddressDisplay address={r.contractAddress} />],
      ["escrow record status", r.escrow.sourceStatus],
      ["milestone match", r.milestoneMatch],
    );
    if (r.milestone) rows.push(["milestone record status", r.milestone.status.sourceStatus]);
  }
  return (
    <GlassPanel padding="md">
      <details>
        <summary className="text-[10px] text-white/30 uppercase tracking-wider cursor-pointer">Inspect raw record</summary>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 mt-3 text-xs">
          {rows.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt className="text-white/30">{k}</dt>
              <dd className="text-white/60 font-mono break-all">{v}</dd>
            </React.Fragment>
          ))}
        </dl>
      </details>
    </GlassPanel>
  );
}
