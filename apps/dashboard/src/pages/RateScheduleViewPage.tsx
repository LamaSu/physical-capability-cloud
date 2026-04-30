/**
 * RateScheduleViewPage — read-only view of a sealed RateSchedule.
 *
 * Route: /contributors/schedules/:hash
 *
 * Fetches a published schedule from the gateway, renders its segments,
 * shows the same SVG curve preview as the publish page, and offers a
 * tiny "evaluate at this moment" sandbox that runs evaluateRateSchedule
 * locally so users can poke at individual moments without round-tripping
 * to the gateway's POST /evaluate endpoint.
 *
 * Layout closely mirrors IPDetailPage.tsx (the closest cousin in this
 * dashboard): GlassPanel header with back-link + hash + meta, then a
 * stack of GlassPanels for each section.
 */
import React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  GlassPanel,
  GlowBadge,
  HashDisplay,
  AddressDisplay,
  DataCell,
  EmptyState,
  Skeleton,
} from "@pcc/ui";
import {
  evaluateRateSchedule,
  type RateSchedule,
  type RateSegment,
} from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { apiGet } from "../lib/api.js";
import { RateSchedulePreviewChart } from "../components/RateSchedulePreviewChart.js";

interface ScheduleResponse {
  schedule: RateSchedule;
  publishedBy: string;
}

const ONE_MONTH_SEC = 30 * 86_400;
const TWO_YEARS_SEC = 24 * ONE_MONTH_SEC;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Render a single segment row with kind-specific param chips.
 * Pure formatting; matches the publish page's tone (minimal, mono numbers).
 */
function SegmentSummary({
  index,
  segment,
  publishedAtSec,
}: {
  index: number;
  segment: RateSegment;
  publishedAtSec: number;
}) {
  const startMonths = ((segment.startTime - publishedAtSec) / ONE_MONTH_SEC).toFixed(1);
  const endMonths =
    segment.kind === "linear-decay"
      ? ((segment.endTime - publishedAtSec) / ONE_MONTH_SEC).toFixed(1)
      : segment.endTime !== null
        ? ((segment.endTime - publishedAtSec) / ONE_MONTH_SEC).toFixed(1)
        : "∞";

  return (
    <tr className="border-b border-white/[0.04] hover:bg-white/[0.02]">
      <td className="py-2 px-3 text-[10px] text-white/40 font-mono">#{index + 1}</td>
      <td className="py-2 px-3">
        <GlowBadge color="green">{segment.kind}</GlowBadge>
      </td>
      <td className="py-2 px-3 text-xs font-mono text-white/60">{startMonths}mo</td>
      <td className="py-2 px-3 text-xs font-mono text-white/60">{endMonths}mo</td>
      <td className="py-2 px-3 text-xs font-mono text-white/60">
        <SegmentParams segment={segment} />
      </td>
    </tr>
  );
}

function SegmentParams({ segment }: { segment: RateSegment }) {
  switch (segment.kind) {
    case "constant":
    case "step":
      return <span>{segment.bps} bps</span>;
    case "linear-decay":
      return (
        <span>
          {segment.startBps} → {segment.endBps} bps
        </span>
      );
    case "exponential-decay":
      return (
        <span>
          {segment.startBps} → ≥{segment.endBps} bps · k={segment.decayPerSecond.toExponential(2)}
        </span>
      );
    case "adoption-indexed":
      return (
        <span>
          scale={segment.scale} · floor={segment.floorBps} · cap={segment.capBps}
        </span>
      );
    case "piecewise-value":
      return (
        <span>
          {"<"}${(segment.thresholdCents / 100).toFixed(0)}: {segment.bpsLow} bps; ≥: {segment.bpsHigh} bps
        </span>
      );
    case "capture-class-indexed":
      return (
        <span>
          default={segment.default}; pinned=
          {Object.entries(segment.byClass)
            .map(([cc, bps]) => `${cc}:${bps}`)
            .join(", ") || "none"}
        </span>
      );
  }
}

// ---------------------------------------------------------------------------
// Evaluate sandbox
// ---------------------------------------------------------------------------

function EvaluateSandbox({ schedule }: { schedule: RateSchedule }) {
  const publishedAtSec = Math.floor(Date.parse(schedule.publishedAt) / 1000);
  const [whenIso, setWhenIso] = React.useState<string>(
    new Date().toISOString().slice(0, 16), // "YYYY-MM-DDTHH:mm" for datetime-local
  );
  const [jobValueCents, setJobValueCents] = React.useState<number>(10_000);
  const [jobsPerDay, setJobsPerDay] = React.useState<number>(100);

  const result = React.useMemo(() => {
    const nowSec = Math.floor(Date.parse(whenIso) / 1000);
    if (!Number.isFinite(nowSec)) return null;
    try {
      return evaluateRateSchedule(schedule, {
        now: nowSec,
        jobValueCents,
        jobsPerDay,
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [schedule, whenIso, jobValueCents, jobsPerDay]);

  const offsetMonths =
    Number.isFinite(Date.parse(whenIso))
      ? ((Math.floor(Date.parse(whenIso) / 1000) - publishedAtSec) / ONE_MONTH_SEC).toFixed(1)
      : "?";

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className="block text-[10px] text-white/40 uppercase tracking-wider mb-1">
            Evaluate at (datetime)
          </label>
          <input
            type="datetime-local"
            value={whenIso}
            onChange={(e) => setWhenIso(e.target.value)}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1.5 text-xs font-mono text-white/80 focus:border-white/20 outline-none"
          />
          <div className="text-[10px] text-white/30 mt-1">
            {offsetMonths}mo after publish
          </div>
        </div>
        <div>
          <label className="block text-[10px] text-white/40 uppercase tracking-wider mb-1">
            Job value (cents)
          </label>
          <input
            type="number"
            value={jobValueCents}
            onChange={(e) => setJobValueCents(parseFloat(e.target.value) || 0)}
            min={0}
            step={100}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1.5 text-xs font-mono text-white/80 focus:border-white/20 outline-none"
          />
          <div className="text-[10px] text-white/30 mt-1">
            ${(jobValueCents / 100).toFixed(2)} reference job
          </div>
        </div>
        <div>
          <label className="block text-[10px] text-white/40 uppercase tracking-wider mb-1">
            Jobs / day
          </label>
          <input
            type="number"
            value={jobsPerDay}
            onChange={(e) => setJobsPerDay(parseFloat(e.target.value) || 0)}
            min={0}
            step={10}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1.5 text-xs font-mono text-white/80 focus:border-white/20 outline-none"
          />
          <div className="text-[10px] text-white/30 mt-1">
            Used by adoption-indexed segments
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <span className="text-[10px] text-white/40 uppercase tracking-wider">
          Result
        </span>
        {result === null ? (
          <span className="text-xs text-white/30">— invalid datetime —</span>
        ) : "error" in result ? (
          <span className="text-xs text-red-400/80">{result.error}</span>
        ) : (
          <>
            <GlowBadge color={result.bps > 0 ? "green" : "gray"}>
              {result.bps} bps
            </GlowBadge>
            <span className="text-[10px] text-white/40">
              ({(result.bps / 100).toFixed(2)}%) · matched segment{" "}
              {result.segmentIndex < 0 ? (
                <span className="text-white/30">none (gap)</span>
              ) : (
                <>
                  #{result.segmentIndex + 1} · {result.kind}
                </>
              )}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function RateScheduleViewPage() {
  const { hash } = useParams<{ hash: string }>();
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const [data, setData] = React.useState<ScheduleResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    setPageMeta(
      "Rate Schedule",
      hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : "view",
    );
  }, [setPageMeta, hash]);

  React.useEffect(() => {
    if (!hash) {
      setError("missing schedule hash");
      setLoading(false);
      return;
    }
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiGet<ScheduleResponse>(
          `/api/contributors/schedules/${hash}`,
        );
        if (!cancelled) setData(res);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "fetch failed");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [hash]);

  async function handleCopyHash() {
    if (!hash) return;
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore — clipboard might be denied; UI just won't flash "Copied" */
    }
  }

  // ── Loading ───────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-6 max-w-5xl">
        {[1, 2, 3].map((n) => (
          <GlassPanel key={n} padding="md">
            <Skeleton className="h-24" />
          </GlassPanel>
        ))}
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────
  if (error || !data) {
    return (
      <div className="space-y-6 max-w-5xl">
        <GlassPanel padding="lg">
          <EmptyState
            title="Schedule not available"
            description={
              error
                ? `${error}. The schedule may not exist, or the gateway is unreachable.`
                : "No data returned for this schedule hash."
            }
            action={{
              label: "Publish a new schedule",
              onClick: () => navigate("/contributors/schedules/publish"),
            }}
          />
        </GlassPanel>
      </div>
    );
  }

  const { schedule, publishedBy } = data;
  const publishedAtSec = Math.floor(Date.parse(schedule.publishedAt) / 1000);

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <GlassPanel padding="md">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div className="space-y-1.5">
            <div className="text-[10px] text-white/40 uppercase tracking-wider">
              Schedule Hash
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <HashDisplay hash={schedule.scheduleHash} chars={10} />
              <button
                onClick={handleCopyHash}
                className="px-2 py-0.5 text-[10px] rounded bg-white/[0.04] hover:bg-white/[0.08] text-white/50 hover:text-white/80 border border-white/[0.08] transition-colors"
                title="Copy full hash"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/contributors/schedules/publish"
              className="px-3 py-1.5 text-xs rounded bg-white/[0.06] text-white/60 hover:bg-white/[0.10] hover:text-white/80 border border-white/[0.08]"
            >
              + Publish New
            </Link>
          </div>
        </div>
      </GlassPanel>

      {/* Meta */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <GlassPanel padding="md">
          <DataCell label="Version" value={`v${schedule.version}`} mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell label="Segments" value={schedule.segments.length} mono />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell
            label="Published"
            value={
              <span className="text-xs text-white/70">
                {new Date(schedule.publishedAt).toLocaleDateString()}
              </span>
            }
          />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell
            label="Published By"
            value={<AddressDisplay address={publishedBy} />}
          />
        </GlassPanel>
      </div>

      {/* Segments table */}
      <GlassPanel padding="lg">
        <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-3">
          Segments
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-white/40 border-b border-white/[0.06]">
                <th className="text-left py-2 px-3 font-medium text-[10px] uppercase tracking-wider w-12">
                  #
                </th>
                <th className="text-left py-2 px-3 font-medium text-[10px] uppercase tracking-wider">
                  Kind
                </th>
                <th className="text-left py-2 px-3 font-medium text-[10px] uppercase tracking-wider">
                  Start
                </th>
                <th className="text-left py-2 px-3 font-medium text-[10px] uppercase tracking-wider">
                  End
                </th>
                <th className="text-left py-2 px-3 font-medium text-[10px] uppercase tracking-wider">
                  Params
                </th>
              </tr>
            </thead>
            <tbody>
              {schedule.segments.map((seg, i) => (
                <SegmentSummary
                  key={i}
                  index={i}
                  segment={seg}
                  publishedAtSec={publishedAtSec}
                />
              ))}
            </tbody>
          </table>
        </div>
      </GlassPanel>

      {/* Curve preview */}
      <GlassPanel padding="lg">
        <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-3">
          Curve — bps over 24 months
        </h3>
        <RateSchedulePreviewChart
          segments={schedule.segments}
          publishedAtSec={publishedAtSec}
          horizonSec={TWO_YEARS_SEC}
        />
        <div className="text-[10px] text-white/30 mt-2">
          Curve is evaluated locally with `evaluateRateSchedule` from @pcc/spec.
          Adoption-indexed and piecewise-value segments use synthetic context
          (jobsPerDay=100, jobValueCents=10000) for the preview. Use the
          sandbox below to evaluate at any specific moment.
        </div>
      </GlassPanel>

      {/* Evaluate sandbox */}
      <GlassPanel padding="lg">
        <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-3">
          Evaluate at this moment
        </h3>
        {schedule.notes && (
          <div className="text-[11px] text-white/40 italic border-l-2 border-white/[0.08] pl-3 mb-4">
            {schedule.notes}
          </div>
        )}
        <EvaluateSandbox schedule={schedule} />
      </GlassPanel>
    </div>
  );
}
