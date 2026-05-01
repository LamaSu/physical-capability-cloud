/**
 * RateSchedulePublishPage — interactive RateSchedule builder.
 *
 * Lets a contributor (any of the 10 ContributorRole values, sans `operator`
 * which earns the residual) compose a sealed `RateSchedule`: pick role + IP
 * Asset id + wallet address, build an ordered Segment[] using the six segment
 * kinds from @pcc/spec, preview the curve over a 24-month window, compute the
 * canonical scheduleHash, and POST the result to the gateway's
 * `/api/contributors/schedules` route. On success the user is navigated to
 * the read-only view at `/contributors/schedules/:hash`.
 *
 * Scope notes (Wave 4d minimum-viable contributor UI):
 *   - This is the "publish" half. The "browse other contributors' schedules"
 *     and "see my own earnings as a contributor" pages are explicit follow-ups
 *     called out in the commit message — DO NOT build them here.
 *   - We re-import `evaluateRateSchedule` + `computeScheduleHash` from
 *     `@pcc/spec` and run them locally so the form has zero round-trip cost
 *     for the curve preview. The gateway recomputes the hash server-side
 *     anyway, so a wrong client value just causes a 400 (no security risk).
 */
import React from "react";
import { useNavigate } from "react-router-dom";
import {
  GlassPanel,
  GlowBadge,
  HashDisplay,
} from "@pcc/ui";
import {
  computeScheduleHash,
  evaluateRateSchedule,
  type RateSegment,
  type RateSegmentKind,
} from "@pcc/spec";
import { useUIStore } from "../stores/ui-store.js";
import { apiPost } from "../lib/api.js";
import { RateSchedulePreviewChart } from "../components/RateSchedulePreviewChart.js";

// ---------------------------------------------------------------------------
// Role taxonomy (10 ContributorRole values, mirrors gateway/contributors.ts).
// `operator` is excluded from this picker because operators earn the residual
// (100% minus the sum of all other contributors' bps), not via RateSchedule.
// ---------------------------------------------------------------------------

const PUBLISHER_ROLES: { value: string; label: string; description: string }[] = [
  { value: "integrator",            label: "Integrator",            description: "Adapter author / driver maintainer" },
  { value: "protocol-author",       label: "Protocol Author",       description: "CSD / capability schema author" },
  { value: "model-author",          label: "Model Author",          description: "Trained model owner (LoRA, distilled, etc.)" },
  { value: "dataset-contributor",   label: "Dataset Contributor",   description: "Training data provider" },
  { value: "verifier",              label: "Verifier",              description: "Evidence verification node" },
  { value: "insurer",               label: "Insurer",               description: "Capacity / settlement insurer" },
  { value: "curator",               label: "Curator",               description: "Community capability curator" },
  { value: "assembler",             label: "Assembler",             description: "Workflow / multi-step assembler" },
  { value: "network-treasury",      label: "Network Treasury",      description: "Protocol treasury beneficiary" },
];

// ---------------------------------------------------------------------------
// Segment defaults — one constructor per kind. Used by "Add Segment".
// ---------------------------------------------------------------------------

const SEGMENT_KINDS: { value: RateSegmentKind; label: string; hint: string }[] = [
  { value: "constant",                label: "Constant",                hint: "Flat bps over a window" },
  { value: "step",                    label: "Step",                    hint: "Single absolute bps from t0" },
  { value: "linear-decay",            label: "Linear Decay",            hint: "Interpolate startBps → endBps" },
  { value: "exponential-decay",       label: "Exponential Decay",       hint: "bps = startBps · e^(-k·Δt)" },
  { value: "adoption-indexed",        label: "Adoption-Indexed",        hint: "scale / sqrt(jobsPerDay), clamped" },
  { value: "piecewise-value",         label: "Piecewise Value",         hint: "Different bps below/above $ threshold" },
  { value: "capture-class-indexed",   label: "Capture-Class-Indexed",   hint: "bps scales with CVP capture class (CC0..CC5)" },
];

const ONE_DAY = 24 * 60 * 60;
const ONE_MONTH = 30 * ONE_DAY;
const TWO_YEARS = 24 * ONE_MONTH;

/**
 * Make a sensible default segment of the given kind. The startTime/endTime
 * values use SECONDS-FROM-PUBLISH semantics inside the form (so segment[0]
 * starts at 0, segment[1] starts at the previous endTime, etc.), and we
 * shift everything by `publishedAt` when sending to the gateway so the
 * stored Segment[] contains absolute Unix-second offsets keyed off publish.
 *
 * The form uses MONTHS as the user-facing time unit. We multiply by
 * ONE_MONTH on the way out (segment row → spec) and divide on the way in
 * (spec → segment row). All hashing/evaluation logic uses the spec form.
 */
function defaultSegment(kind: RateSegmentKind, prevEndMonths: number | null): SegmentRow {
  const startMonths = prevEndMonths ?? 0;
  switch (kind) {
    case "constant":
      return { kind, startMonths, endMonths: startMonths + 6, bps: 500 };
    case "step":
      return { kind, startMonths, endMonths: null, bps: 250 };
    case "linear-decay":
      return { kind, startMonths, endMonths: startMonths + 12, startBps: 1000, endBps: 250 };
    case "exponential-decay":
      return {
        kind,
        startMonths,
        endMonths: null,
        startBps: 1000,
        endBps: 50,
        // ~half-life of 6 months (in seconds).
        decayPerSecond: Math.LN2 / (6 * ONE_MONTH),
      };
    case "adoption-indexed":
      return {
        kind,
        startMonths,
        endMonths: null,
        scale: 5000,
        floorBps: 25,
        capBps: 1000,
      };
    case "piecewise-value":
      return {
        kind,
        startMonths,
        endMonths: null,
        thresholdCents: 10_000, // $100
        bpsLow: 100,
        bpsHigh: 50,
      };
    case "capture-class-indexed":
      // Default ladder: more rigorous evidence (higher CC) earns more bps.
      // CC0 (self-attested) gets the floor; CC5 (sovereign-grade) the cap.
      return {
        kind,
        startMonths,
        endMonths: null,
        defaultBps: 100,
        cc0: 50,
        cc1: 100,
        cc2: 200,
        cc3: 350,
        cc4: 500,
        cc5: 750,
      };
  }
}

// ---------------------------------------------------------------------------
// Segment row — the form-friendly shape with months instead of seconds.
// ---------------------------------------------------------------------------

type SegmentRow =
  | { kind: "constant"; startMonths: number; endMonths: number | null; bps: number }
  | { kind: "step"; startMonths: number; endMonths: number | null; bps: number }
  | { kind: "linear-decay"; startMonths: number; endMonths: number; startBps: number; endBps: number }
  | { kind: "exponential-decay"; startMonths: number; endMonths: number | null; startBps: number; endBps: number; decayPerSecond: number }
  | { kind: "adoption-indexed"; startMonths: number; endMonths: number | null; scale: number; floorBps: number; capBps: number }
  | { kind: "piecewise-value"; startMonths: number; endMonths: number | null; thresholdCents: number; bpsLow: number; bpsHigh: number }
  | {
      kind: "capture-class-indexed";
      startMonths: number;
      endMonths: number | null;
      defaultBps: number;
      cc0: number;
      cc1: number;
      cc2: number;
      cc3: number;
      cc4: number;
      cc5: number;
    };

/** Convert a SegmentRow (months, no offset) to a RateSegment (seconds, absolute). */
export function rowToSegment(row: SegmentRow, publishedAtSec: number): RateSegment {
  const startTime = publishedAtSec + Math.round(row.startMonths * ONE_MONTH);
  const endTime =
    row.kind === "linear-decay"
      ? publishedAtSec + Math.round(row.endMonths * ONE_MONTH)
      : row.endMonths === null
        ? null
        : publishedAtSec + Math.round(row.endMonths * ONE_MONTH);

  switch (row.kind) {
    case "constant":
      return { kind: "constant", startTime, endTime, bps: row.bps };
    case "step":
      return { kind: "step", startTime, endTime, bps: row.bps };
    case "linear-decay":
      return {
        kind: "linear-decay",
        startTime,
        endTime: endTime as number,
        startBps: row.startBps,
        endBps: row.endBps,
      };
    case "exponential-decay":
      return {
        kind: "exponential-decay",
        startTime,
        endTime,
        startBps: row.startBps,
        endBps: row.endBps,
        decayPerSecond: row.decayPerSecond,
      };
    case "adoption-indexed":
      return {
        kind: "adoption-indexed",
        startTime,
        endTime,
        scale: row.scale,
        floorBps: row.floorBps,
        capBps: row.capBps,
      };
    case "piecewise-value":
      return {
        kind: "piecewise-value",
        startTime,
        endTime,
        thresholdCents: row.thresholdCents,
        bpsLow: row.bpsLow,
        bpsHigh: row.bpsHigh,
      };
    case "capture-class-indexed":
      return {
        kind: "capture-class-indexed",
        startTime,
        endTime,
        byClass: {
          CC0: row.cc0,
          CC1: row.cc1,
          CC2: row.cc2,
          CC3: row.cc3,
          CC4: row.cc4,
          CC5: row.cc5,
        },
        default: row.defaultBps,
      };
  }
}

// ---------------------------------------------------------------------------
// Validation helpers (pure — exported for tests)
// ---------------------------------------------------------------------------

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const IP_ID_RE = /^0x[a-fA-F0-9]{40}$/;

export interface RowValidation {
  valid: boolean;
  message?: string;
}

export function validateRows(rows: SegmentRow[]): RowValidation {
  if (rows.length === 0) return { valid: false, message: "Add at least one segment" };
  let prevEnd: number | null = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.startMonths < 0) return { valid: false, message: `Segment ${i + 1}: startMonths must be ≥ 0` };
    if (prevEnd !== null && r.startMonths < prevEnd) {
      return { valid: false, message: `Segment ${i + 1} starts before previous segment ends (${prevEnd}mo)` };
    }
    if (r.kind === "linear-decay") {
      if (r.endMonths <= r.startMonths) {
        return { valid: false, message: `Segment ${i + 1}: linear-decay endMonths must exceed startMonths` };
      }
      if (r.startBps < 0 || r.startBps > 10000) {
        return { valid: false, message: `Segment ${i + 1}: startBps must be 0-10000` };
      }
      if (r.endBps < 0 || r.endBps > 10000) {
        return { valid: false, message: `Segment ${i + 1}: endBps must be 0-10000` };
      }
    } else if (r.endMonths !== null && r.endMonths < r.startMonths) {
      return { valid: false, message: `Segment ${i + 1}: endMonths cannot precede startMonths` };
    }
    if (r.kind === "constant" || r.kind === "step") {
      if (r.bps < 0 || r.bps > 10000) {
        return { valid: false, message: `Segment ${i + 1}: bps must be 0-10000` };
      }
    }
    if (r.kind === "capture-class-indexed") {
      const fields = [
        ["defaultBps", r.defaultBps],
        ["CC0", r.cc0],
        ["CC1", r.cc1],
        ["CC2", r.cc2],
        ["CC3", r.cc3],
        ["CC4", r.cc4],
        ["CC5", r.cc5],
      ] as const;
      for (const [name, val] of fields) {
        if (val < 0 || val > 10000) {
          return { valid: false, message: `Segment ${i + 1}: ${name} must be 0-10000` };
        }
      }
    }
    prevEnd = r.kind === "linear-decay" ? r.endMonths : r.endMonths;
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Onramp helper — inline "Add USDC" button for the wallet address row.
//
// Calls POST /api/fiat-ramp/onramp/session with the wallet address as the
// destination. On a Stripe-keyed gateway this returns a checkout URL; on a
// mock-keyed gateway (no STRIPE_SECRET_KEY) it returns a stub that we surface
// as an inline tip rather than a broken link.
// ---------------------------------------------------------------------------

const ADDRESS_RE_INLINE = /^0x[a-fA-F0-9]{40}$/;

function OnrampButton({ walletAddress }: { walletAddress: string }) {
  const [busy, setBusy] = React.useState(false);
  const [tip, setTip] = React.useState<string | null>(null);
  const valid = ADDRESS_RE_INLINE.test(walletAddress);

  async function open() {
    if (!valid || busy) return;
    setBusy(true);
    setTip(null);
    try {
      const res = await apiPost<{ url?: string; sessionUrl?: string; clientSecret?: string }>(
        "/api/fiat-ramp/onramp/session",
        { destinationAddress: walletAddress, amountUsd: 20, currency: "USDC" },
      );
      const url = res.url ?? res.sessionUrl;
      if (url) {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        setTip("Onramp is in mock mode (no STRIPE_SECRET_KEY on gateway). Real onramp activates in production.");
      }
    } catch (err) {
      setTip(err instanceof Error ? err.message : "onramp request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {tip && <span className="text-[10px] text-amber-400/70">{tip}</span>}
      <button
        type="button"
        onClick={open}
        disabled={!valid || busy}
        className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-white/[0.1] text-white/60 hover:text-white hover:border-white/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
        title={valid ? "Open Stripe to add USDC to this wallet" : "Enter a valid wallet address first"}
      >
        {busy ? "…" : "+ $20 USDC"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

interface PublishResponse {
  scheduleHash: string;
  canonicalBytes?: string;
  alreadyPublished?: boolean;
}

export function RateSchedulePublishPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const [role, setRole] = React.useState<string>("integrator");
  const [ipId, setIpId] = React.useState<string>("");
  const [walletAddress, setWalletAddress] = React.useState<string>("");
  const [notes, setNotes] = React.useState<string>("");
  const [rows, setRows] = React.useState<SegmentRow[]>([
    { kind: "linear-decay", startMonths: 0, endMonths: 12, startBps: 1000, endBps: 250 },
    { kind: "constant",     startMonths: 12, endMonths: null, bps: 250 },
  ]);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitErr, setSubmitErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    setPageMeta(
      "Publish RateSchedule",
      "Compose a sealed contributor rate curve",
    );
  }, [setPageMeta]);

  // ── Rows → spec segments → hash ───────────────────────────────────────
  // We use a stable publish anchor of 0 in months for the *preview*, then
  // a real ISO publish timestamp at submit. The hash is over {version, segments}
  // only (publishedAt is metadata, not part of the canonical hash) so the
  // preview hash remains stable as the user edits the form.

  const publishedAtSec = 0; // preview anchor — segments start at 0 seconds

  const previewSegments: RateSegment[] = React.useMemo(
    () => rows.map((r) => rowToSegment(r, publishedAtSec)),
    [rows],
  );

  const validation = React.useMemo(() => validateRows(rows), [rows]);

  const previewHash = React.useMemo(() => {
    if (!validation.valid) return null;
    try {
      return computeScheduleHash({
        version: 1,
        segments: previewSegments,
        publishedAt: "",
      });
    } catch {
      return null;
    }
  }, [previewSegments, validation.valid]);

  // ── Mutators ──────────────────────────────────────────────────────────

  function addSegment(kind: RateSegmentKind) {
    const last = rows[rows.length - 1];
    const prevEnd = last
      ? (last.kind === "linear-decay"
          ? last.endMonths
          : last.endMonths)
      : null;
    setRows([...rows, defaultSegment(kind, prevEnd)]);
  }

  function removeSegment(idx: number) {
    setRows(rows.filter((_, i) => i !== idx));
  }

  function updateRow(idx: number, patch: Partial<SegmentRow>) {
    setRows(
      rows.map((r, i) => (i === idx ? ({ ...r, ...patch } as SegmentRow) : r)),
    );
  }

  // ── Submit ────────────────────────────────────────────────────────────

  async function handlePublish() {
    setSubmitErr(null);
    if (!validation.valid) {
      setSubmitErr(validation.message ?? "schedule is invalid");
      return;
    }
    if (!ADDRESS_RE.test(walletAddress)) {
      setSubmitErr("walletAddress must be 0x + 40 hex chars");
      return;
    }
    if (ipId && !IP_ID_RE.test(ipId)) {
      setSubmitErr("ipId, when set, must be 0x + 40 hex chars");
      return;
    }

    setSubmitting(true);
    try {
      // Re-anchor segments to a real Unix timestamp at publish-time. The
      // gateway will canonicalize + recompute the hash itself; we send our
      // computed hash for gate-checking but the server is authoritative.
      const publishedAtIso = new Date().toISOString();
      const publishedAtAnchor = Math.floor(Date.parse(publishedAtIso) / 1000);
      const realSegments = rows.map((r) => rowToSegment(r, publishedAtAnchor));
      const realHash = computeScheduleHash({
        version: 1,
        segments: realSegments,
        publishedAt: publishedAtIso,
      });

      const result = await apiPost<PublishResponse>(
        "/api/contributors/schedules",
        {
          publishedBy: walletAddress,
          schedule: {
            version: 1,
            segments: realSegments,
            notes: notes || undefined,
            scheduleHash: realHash,
            publishedAt: publishedAtIso,
          },
        },
      );

      // Optionally register the contributor profile so the new schedule is
      // discoverable by role/address. Failures here are non-fatal — the
      // schedule is already on-record.
      if (ipId) {
        try {
          await apiPost("/api/contributors", {
            address: walletAddress,
            role,
            scheduleHash: result.scheduleHash,
            ipId,
          });
        } catch {
          /* swallow — the schedule itself is published; profile is best-effort */
        }
      }

      navigate(`/contributors/schedules/${result.scheduleHash}`);
    } catch (err) {
      setSubmitErr(err instanceof Error ? err.message : "publish failed");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Identity + role */}
      <GlassPanel padding="lg">
        <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-3">
          Contributor Identity
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-[10px] text-white/40 uppercase tracking-wider mb-1">
              Role
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded px-3 py-2 text-sm text-white/80 focus:border-white/20 outline-none"
            >
              {PUBLISHER_ROLES.map((r) => (
                <option key={r.value} value={r.value} className="bg-black">
                  {r.label}
                </option>
              ))}
            </select>
            <div className="text-[10px] text-white/30 mt-1">
              {PUBLISHER_ROLES.find((r) => r.value === role)?.description}
            </div>
          </div>
          <div>
            <label className="block text-[10px] text-white/40 uppercase tracking-wider mb-1">
              IP Asset ID (optional)
            </label>
            <input
              type="text"
              placeholder="0x… (40 hex)"
              value={ipId}
              onChange={(e) => setIpId(e.target.value.trim())}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded px-3 py-2 text-sm font-mono text-white/80 focus:border-white/20 outline-none"
            />
            <div className="text-[10px] text-white/30 mt-1">
              Story Protocol IPAsset id. Used to register a profile entry too.
            </div>
          </div>
          <div>
            <label className="block text-[10px] text-white/40 uppercase tracking-wider mb-1">
              Wallet Address
            </label>
            <input
              type="text"
              placeholder="0x… (40 hex)"
              value={walletAddress}
              onChange={(e) => setWalletAddress(e.target.value.trim())}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded px-3 py-2 text-sm font-mono text-white/80 focus:border-white/20 outline-none"
            />
            <div className="flex items-center justify-between mt-1 gap-2">
              <div className="text-[10px] text-white/30">
                The publishedBy address. Required.
              </div>
              <OnrampButton walletAddress={walletAddress} />
            </div>
          </div>
        </div>
      </GlassPanel>

      {/* Segment builder */}
      <GlassPanel padding="lg">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider">
            Rate Schedule Segments
          </h3>
          <div className="flex items-center gap-2 flex-wrap">
            {SEGMENT_KINDS.map((k) => (
              <button
                key={k.value}
                onClick={() => addSegment(k.value)}
                title={k.hint}
                className="px-2 py-1 rounded text-[10px] bg-white/[0.04] border border-white/[0.08] text-white/50 hover:bg-white/[0.08] hover:text-white/70 transition-all"
              >
                + {k.label}
              </button>
            ))}
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="text-xs text-white/30 py-4 text-center">
            No segments — add one to begin.
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((row, i) => (
              <SegmentEditor
                key={i}
                index={i}
                row={row}
                onChange={(patch) => updateRow(i, patch)}
                onRemove={() => removeSegment(i)}
              />
            ))}
          </div>
        )}

        {!validation.valid && (
          <div className="mt-3 text-xs text-red-400/80">
            {validation.message}
          </div>
        )}
      </GlassPanel>

      {/* Live preview */}
      <GlassPanel padding="lg">
        <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-3">
          Live Preview — bps over 24 months
        </h3>
        <RateSchedulePreviewChart
          segments={previewSegments}
          publishedAtSec={publishedAtSec}
          horizonSec={TWO_YEARS}
        />
        <div className="text-[10px] text-white/30 mt-2">
          Curve is evaluated locally with `evaluateRateSchedule` from @pcc/spec.
          Adoption-indexed and piecewise-value segments use synthetic context
          (jobsPerDay=100, jobValueCents=10000) for the preview.
        </div>
      </GlassPanel>

      {/* Hash + notes + submit */}
      <GlassPanel padding="lg">
        <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-3">
          Seal &amp; Publish
        </h3>
        <div className="space-y-4">
          <div>
            <label className="block text-[10px] text-white/40 uppercase tracking-wider mb-1">
              Author Notes (optional)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Why this curve? Who's it for? What changes between versions?"
              rows={2}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded px-3 py-2 text-xs text-white/80 focus:border-white/20 outline-none resize-y"
            />
          </div>

          <div className="flex items-start gap-3 flex-wrap">
            <div className="flex-1 min-w-[280px]">
              <div className="text-[10px] text-white/40 uppercase tracking-wider mb-1">
                Computed Hash (preview)
              </div>
              {previewHash ? (
                <HashDisplay hash={previewHash} />
              ) : (
                <span className="text-xs text-white/30">— invalid schedule —</span>
              )}
              <div className="text-[10px] text-white/30 mt-1">
                Server recomputes this on publish; mismatch = 400.
              </div>
            </div>
            <button
              onClick={handlePublish}
              disabled={!validation.valid || !walletAddress || submitting}
              className="px-6 py-2.5 rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed font-medium text-sm transition-colors"
            >
              {submitting ? "Publishing…" : "Publish Schedule"}
            </button>
          </div>

          {submitErr && (
            <div className="text-xs text-red-400/80 p-2 rounded bg-red-500/[0.06] border border-red-500/20">
              {submitErr}
            </div>
          )}

          <div className="text-[10px] text-white/30 pt-2 border-t border-white/[0.06]">
            <GlowBadge color="green">Next wave</GlowBadge>{" "}
            Browse other contributors' schedules + Earnings dashboard. Out of
            scope for this MVP page.
          </div>
        </div>
      </GlassPanel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SegmentEditor — one row per segment, kind-specific param fields.
// Kept inline so the page is self-contained and easy to navigate.
// ---------------------------------------------------------------------------

interface SegmentEditorProps {
  index: number;
  row: SegmentRow;
  onChange: (patch: Partial<SegmentRow>) => void;
  onRemove: () => void;
}

function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-[10px] text-white/40 uppercase tracking-wider mb-1">
        {label}
      </label>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-full bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1.5 text-xs font-mono text-white/80 focus:border-white/20 outline-none"
      />
      {hint && <div className="text-[10px] text-white/25 mt-0.5">{hint}</div>}
    </div>
  );
}

function NullableMonthsField({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const [forever, setForever] = React.useState(value === null);
  React.useEffect(() => {
    setForever(value === null);
  }, [value]);
  return (
    <div>
      <label className="block text-[10px] text-white/40 uppercase tracking-wider mb-1">
        End (months)
      </label>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={value ?? 0}
          step={1}
          min={0}
          disabled={forever}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-full bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1.5 text-xs font-mono text-white/80 focus:border-white/20 outline-none disabled:opacity-40"
        />
        <label className="flex items-center gap-1 text-[10px] text-white/50">
          <input
            type="checkbox"
            checked={forever}
            onChange={(e) => {
              setForever(e.target.checked);
              onChange(e.target.checked ? null : 12);
            }}
          />
          ∞
        </label>
      </div>
    </div>
  );
}

function SegmentEditor({ index, row, onChange, onRemove }: SegmentEditorProps) {
  const kindLabel = SEGMENT_KINDS.find((k) => k.value === row.kind)?.label ?? row.kind;

  return (
    <div className="rounded border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-white/40">#{index + 1}</span>
          <GlowBadge color="green">{kindLabel}</GlowBadge>
        </div>
        <button
          onClick={onRemove}
          className="text-white/30 hover:text-red-400/70 text-sm leading-none"
          title="Remove segment"
        >
          ×
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <NumberField
          label="Start (months)"
          value={row.startMonths}
          onChange={(v) => onChange({ startMonths: v } as Partial<SegmentRow>)}
          step={1}
          min={0}
        />

        {row.kind === "linear-decay" ? (
          <NumberField
            label="End (months)"
            value={row.endMonths}
            onChange={(v) => onChange({ endMonths: v } as Partial<SegmentRow>)}
            step={1}
            min={0}
          />
        ) : (
          <NullableMonthsField
            value={row.endMonths}
            onChange={(v) => onChange({ endMonths: v } as Partial<SegmentRow>)}
          />
        )}

        {/* Kind-specific fields */}
        {(row.kind === "constant" || row.kind === "step") && (
          <NumberField
            label="bps"
            value={row.bps}
            onChange={(v) => onChange({ bps: v } as Partial<SegmentRow>)}
            min={0}
            max={10000}
          />
        )}

        {row.kind === "linear-decay" && (
          <>
            <NumberField
              label="Start bps"
              value={row.startBps}
              onChange={(v) => onChange({ startBps: v } as Partial<SegmentRow>)}
              min={0}
              max={10000}
            />
            <NumberField
              label="End bps"
              value={row.endBps}
              onChange={(v) => onChange({ endBps: v } as Partial<SegmentRow>)}
              min={0}
              max={10000}
            />
          </>
        )}

        {row.kind === "exponential-decay" && (
          <>
            <NumberField
              label="Start bps"
              value={row.startBps}
              onChange={(v) => onChange({ startBps: v } as Partial<SegmentRow>)}
              min={0}
              max={10000}
            />
            <NumberField
              label="Floor bps"
              value={row.endBps}
              onChange={(v) => onChange({ endBps: v } as Partial<SegmentRow>)}
              min={0}
              max={10000}
            />
            <NumberField
              label="Decay /sec"
              value={row.decayPerSecond}
              onChange={(v) =>
                onChange({ decayPerSecond: Math.max(1e-12, v) } as Partial<SegmentRow>)
              }
              step={1e-9}
              min={1e-12}
              hint={`half-life ≈ ${(Math.LN2 / row.decayPerSecond / ONE_MONTH).toFixed(1)}mo`}
            />
          </>
        )}

        {row.kind === "adoption-indexed" && (
          <>
            <NumberField
              label="Scale"
              value={row.scale}
              onChange={(v) => onChange({ scale: Math.max(0.001, v) } as Partial<SegmentRow>)}
              step={0.1}
              min={0.001}
            />
            <NumberField
              label="Floor bps"
              value={row.floorBps}
              onChange={(v) => onChange({ floorBps: v } as Partial<SegmentRow>)}
              min={0}
              max={10000}
            />
            <NumberField
              label="Cap bps"
              value={row.capBps}
              onChange={(v) => onChange({ capBps: v } as Partial<SegmentRow>)}
              min={0}
              max={10000}
            />
          </>
        )}

        {row.kind === "piecewise-value" && (
          <>
            <NumberField
              label="Threshold (¢)"
              value={row.thresholdCents}
              onChange={(v) =>
                onChange({ thresholdCents: Math.max(0, v) } as Partial<SegmentRow>)
              }
              min={0}
            />
            <NumberField
              label="bps low"
              value={row.bpsLow}
              onChange={(v) => onChange({ bpsLow: v } as Partial<SegmentRow>)}
              min={0}
              max={10000}
            />
            <NumberField
              label="bps high"
              value={row.bpsHigh}
              onChange={(v) => onChange({ bpsHigh: v } as Partial<SegmentRow>)}
              min={0}
              max={10000}
            />
          </>
        )}

        {row.kind === "capture-class-indexed" && (
          <>
            <NumberField
              label="Default bps"
              value={row.defaultBps}
              onChange={(v) => onChange({ defaultBps: v } as Partial<SegmentRow>)}
              min={0}
              max={10000}
              hint="Used when captureClass missing"
            />
            <NumberField
              label="CC0 bps"
              value={row.cc0}
              onChange={(v) => onChange({ cc0: v } as Partial<SegmentRow>)}
              min={0}
              max={10000}
            />
            <NumberField
              label="CC1 bps"
              value={row.cc1}
              onChange={(v) => onChange({ cc1: v } as Partial<SegmentRow>)}
              min={0}
              max={10000}
            />
            <NumberField
              label="CC2 bps"
              value={row.cc2}
              onChange={(v) => onChange({ cc2: v } as Partial<SegmentRow>)}
              min={0}
              max={10000}
            />
            <NumberField
              label="CC3 bps"
              value={row.cc3}
              onChange={(v) => onChange({ cc3: v } as Partial<SegmentRow>)}
              min={0}
              max={10000}
            />
            <NumberField
              label="CC4 bps"
              value={row.cc4}
              onChange={(v) => onChange({ cc4: v } as Partial<SegmentRow>)}
              min={0}
              max={10000}
            />
            <NumberField
              label="CC5 bps"
              value={row.cc5}
              onChange={(v) => onChange({ cc5: v } as Partial<SegmentRow>)}
              min={0}
              max={10000}
            />
          </>
        )}
      </div>
    </div>
  );
}
