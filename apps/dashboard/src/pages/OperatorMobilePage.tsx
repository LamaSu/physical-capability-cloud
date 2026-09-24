import React, { useRef, useState, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { JobDTO } from "../types/dto.js";
import { useAgentMe } from "../api/hooks/use-pcc-data.js";
import { useAuthStore } from "../stores/auth-store.js";
import { UnavailableState } from "../components/LiveState.js";
import { isActiveJob, mayBeTruncated } from "../lib/live-status.js";
import {
  base64FromDataUrl,
  checkPhoto,
  comparePhotos,
  kernelsOf,
  listKernelJobs,
  sendSupportReport,
  type PhotoCheck,
  type PhotoComparison,
} from "../lib/operator-api.js";

/**
 * Operator mobile page.
 *
 * Everything shown here is what the gateway returned. A failed request says
 * it failed; it never turns into a sample job, a made-up evidence reference,
 * a "match", or an "issue filed" receipt. The operator's machines and jobs
 * come from the key's own account (GET /api/agent/me), not from every job
 * the key can see.
 */

type ActiveTab = "photo" | "jobs" | "account";

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "unknown time";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "unknown time";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function statusColor(status: string): string {
  switch (status) {
    case "in_progress":
    case "queued":
    case "pending":
      return "bg-amber-500/20 text-amber-300 border border-amber-500/30";
    case "completed":
      return "bg-sky-500/20 text-sky-300 border border-sky-500/30";
    case "failed":
    case "cancelled":
      return "bg-red-500/20 text-red-300 border border-red-500/30";
    default:
      return "bg-white/10 text-white/60 border border-white/10";
  }
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the photo"));
    reader.readAsDataURL(file);
  });
}

/** The account's machines, from GET /api/agent/me. `null` while unknown. */
function useMyKernels() {
  const me = useAgentMe();
  const kernels = kernelsOf(me.data);
  return { me, kernels };
}

function NotSent({ reason, children }: { reason: string; children?: React.ReactNode }) {
  return (
    <div role="alert" className="rounded-2xl bg-red-500/10 border border-red-500/40 p-4 space-y-2">
      <div className="text-sm font-semibold text-red-300">Not sent</div>
      <p className="text-xs text-red-200/80">{reason}</p>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Photo tab
// ---------------------------------------------------------------------------

type PhotoMode = "check" | "compare" | "issue";

function PhotoTab() {
  const { me, kernels } = useMyKernels();
  const captureRef = useRef<HTMLInputElement>(null);
  const referenceRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<PhotoMode>("check");
  const [photo, setPhoto] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkResult, setCheckResult] = useState<PhotoCheck | null>(null);
  const [compareResult, setCompareResult] = useState<PhotoComparison | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [issueKernel, setIssueKernel] = useState("");
  const [issueJob, setIssueJob] = useState("");
  const [issueText, setIssueText] = useState("");
  const [issueThread, setIssueThread] = useState<string | null>(null);

  const reset = () => {
    setPhoto(null);
    setReference(null);
    setCheckResult(null);
    setCompareResult(null);
    setFailure(null);
    setIssueThread(null);
    if (captureRef.current) captureRef.current.value = "";
    if (referenceRef.current) referenceRef.current.value = "";
  };

  const onPick = useCallback(
    (setter: (v: string) => void) => async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setFailure(null);
      setCheckResult(null);
      setCompareResult(null);
      try {
        setter(await readDataUrl(file));
      } catch (err) {
        setFailure(err instanceof Error ? err.message : "Could not read the photo.");
      }
    },
    [],
  );

  const runCheck = useCallback(async () => {
    if (!photo) return;
    setBusy(true);
    setFailure(null);
    const r = await checkPhoto(base64FromDataUrl(photo));
    setBusy(false);
    if (r.ok) setCheckResult(r.data);
    else setFailure(r.reason);
  }, [photo]);

  const runCompare = useCallback(async () => {
    if (!photo || !reference) return;
    setBusy(true);
    setFailure(null);
    const r = await comparePhotos(base64FromDataUrl(photo), base64FromDataUrl(reference));
    setBusy(false);
    if (r.ok) setCompareResult(r.data);
    else setFailure(r.reason);
  }, [photo, reference]);

  const runIssue = useCallback(async () => {
    const kernelId = issueKernel || (kernels && kernels.length === 1 ? kernels[0]!.id : "");
    if (!kernelId || !issueText.trim()) return;
    setBusy(true);
    setFailure(null);
    const lines = [issueText.trim()];
    if (issueJob.trim()) lines.push(`Job: ${issueJob.trim()}`);
    const r = await sendSupportReport({ kernelId, message: lines.join("\n"), subject: issueText.trim().slice(0, 80) });
    setBusy(false);
    if (r.ok) setIssueThread(r.data.threadId);
    else setFailure(r.reason);
  }, [issueKernel, issueJob, issueText, kernels]);

  const modeButton = (m: PhotoMode, label: string) => (
    <button
      key={m}
      onClick={() => { setMode(m); reset(); }}
      className={`flex-1 py-2 rounded-xl text-xs font-medium transition-all ${
        mode === m
          ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
          : "bg-white/[0.04] text-white/40 border border-white/[0.06]"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex gap-2">
        {modeButton("check", "Photo check")}
        {modeButton("compare", "Compare")}
        {modeButton("issue", "Report issue")}
      </div>

      <input ref={captureRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onPick(setPhoto)} />
      <input ref={referenceRef} type="file" accept="image/*" className="hidden" onChange={onPick(setReference)} />

      {mode !== "issue" && (
        <>
          <p className="text-[11px] leading-relaxed text-white/40">
            {mode === "check"
              ? "Sends one photo to PCC's photo check (hash and anti-spoof heuristics). It is not attached to any job and is not job evidence."
              : "Asks an AI model to compare your photo with a reference image. Its answer is advisory: it is not PCC verification and does not affect payment."}
          </p>

          {!photo ? (
            <button
              onClick={() => captureRef.current?.click()}
              className="flex flex-col items-center justify-center gap-2 w-full rounded-2xl bg-emerald-500/10 border-2 border-dashed border-emerald-500/40 py-12 text-emerald-400 active:scale-[0.97] transition-transform"
            >
              <span className="text-base font-semibold">Take photo</span>
              <span className="text-xs text-emerald-400/60">Tap to open camera</span>
            </button>
          ) : (
            <div className="rounded-2xl overflow-hidden border border-white/[0.08]">
              <img src={photo} alt="Your photo" className="w-full object-cover max-h-64" />
            </div>
          )}

          {mode === "compare" && photo && (
            reference ? (
              <div className="rounded-2xl overflow-hidden border border-sky-500/30">
                <div className="px-3 py-1 text-[10px] text-sky-300/70 bg-sky-500/10">Reference image</div>
                <img src={reference} alt="Reference" className="w-full object-cover max-h-40" />
              </div>
            ) : (
              <button
                onClick={() => referenceRef.current?.click()}
                className="w-full py-3 rounded-2xl bg-sky-500/10 border border-sky-500/30 text-sm text-sky-300"
              >
                Choose the reference image
              </button>
            )
          )}

          {photo && mode === "check" && !checkResult && (
            <button
              onClick={runCheck}
              disabled={busy}
              className="w-full py-4 rounded-2xl bg-emerald-500 text-black font-semibold text-base active:scale-[0.97] transition-transform disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send for photo check"}
            </button>
          )}

          {photo && mode === "compare" && reference && !compareResult && (
            <button
              onClick={runCompare}
              disabled={busy}
              className="w-full py-4 rounded-2xl bg-sky-500 text-black font-semibold text-base active:scale-[0.97] transition-transform disabled:opacity-50"
            >
              {busy ? "Comparing…" : "Compare"}
            </button>
          )}

          {checkResult && (
            <div data-testid="photo-check-result" className="rounded-2xl bg-white/[0.04] border border-white/[0.08] p-4 space-y-3">
              <div className="text-sm font-semibold text-white/80">Received by PCC</div>
              <div>
                <div className="text-[10px] text-white/30 mb-1">Image hash (from PCC)</div>
                <div className="text-[11px] font-mono text-white/60 break-all">{checkResult.imageHash}</div>
              </div>
              <div>
                <div className="text-[10px] text-white/30 mb-1">Reference</div>
                <div className="text-[11px] font-mono text-white/60 break-all">{checkResult.cid}</div>
                <div className="text-[10px] text-white/40 mt-1">
                  {checkResult.stored
                    ? "Stored by PCC's evidence storage."
                    : "Not stored: PCC kept a hash reference only."}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-white/30 mb-1">Anti-spoof heuristic (advisory)</div>
                <div className="text-xs font-mono text-white/60">
                  {checkResult.antiSpoofScore === null ? "Not reported" : `${Math.round(checkResult.antiSpoofScore * 100)}%`}
                </div>
              </div>
            </div>
          )}

          {compareResult && (
            <div data-testid="photo-compare-result" className="rounded-2xl bg-white/[0.04] border border-white/[0.08] p-4 space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-white/35">
                AI comparison (advisory){compareResult.modelUsed ? ` · ${compareResult.modelUsed}` : ""}
              </div>
              <div className="text-sm font-semibold text-white/80">{compareResult.verdict ?? "No verdict returned"}</div>
              {compareResult.matchScore !== null && (
                <div className="text-xs text-white/50">Match score: <span className="font-mono">{compareResult.matchScore}</span></div>
              )}
              {compareResult.discrepancies.length > 0 && (
                <ul className="list-disc pl-4 text-xs text-white/50 space-y-1">
                  {compareResult.discrepancies.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
              )}
              {compareResult.reasoning && <p className="text-[11px] text-white/40">{compareResult.reasoning}</p>}
            </div>
          )}
        </>
      )}

      {mode === "issue" && (
        <div className="flex flex-col gap-3">
          <p className="text-[11px] leading-relaxed text-white/40">
            Sends a message to PCC support about one of your machines. If anyone is at risk, stop the machine with its own
            emergency stop first.
          </p>
          {me.isLoading && <div className="text-xs text-white/40">Loading your machines…</div>}
          {me.isError && <UnavailableState what="your machines" error={me.error} onRetry={() => void me.refetch()} />}
          {kernels && kernels.length === 0 && (
            <div className="text-xs text-white/50">No machines are registered to this key, so there is nothing to report against.</div>
          )}
          {kernels && kernels.length > 0 && (
            <>
              <label className="text-[10px] text-white/40">
                Machine
                <select
                  value={issueKernel || (kernels.length === 1 ? kernels[0]!.id : "")}
                  onChange={(e) => setIssueKernel(e.target.value)}
                  className="mt-1 w-full rounded-xl bg-white/[0.04] border border-white/[0.06] px-3 py-2 text-sm text-white/80"
                >
                  {kernels.length > 1 && <option value="">Choose a machine</option>}
                  {kernels.map((k) => <option key={k.id} value={k.id}>{k.name || k.id}</option>)}
                </select>
              </label>
              <input
                value={issueJob}
                onChange={(e) => setIssueJob(e.target.value)}
                placeholder="Job ID (optional)"
                className="w-full rounded-xl bg-white/[0.04] border border-white/[0.06] px-3 py-2 text-sm text-white/80 placeholder:text-white/20"
              />
              <textarea
                value={issueText}
                onChange={(e) => setIssueText(e.target.value)}
                placeholder="What happened?"
                rows={4}
                className="w-full rounded-xl bg-white/[0.04] border border-white/[0.06] px-3 py-2 text-sm text-white/80 placeholder:text-white/20 resize-none"
              />
              {!issueThread && (
                <button
                  onClick={runIssue}
                  disabled={busy || !issueText.trim() || !(issueKernel || kernels.length === 1)}
                  className="w-full py-4 rounded-2xl bg-amber-500 text-black font-semibold text-base active:scale-[0.97] transition-transform disabled:opacity-50"
                >
                  {busy ? "Sending…" : "Send to support"}
                </button>
              )}
            </>
          )}
          {issueThread && (
            <div data-testid="issue-sent" className="rounded-2xl bg-amber-500/10 border border-amber-500/30 p-4 space-y-1">
              <div className="text-sm font-semibold text-amber-300">Sent to PCC support</div>
              <div className="text-[11px] text-white/50">
                Thread <span className="font-mono">{issueThread}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {failure && (
        <NotSent reason={failure}>
          {mode === "issue" && (
            <p className="text-xs text-red-200/80">
              Your report did not reach PCC. If anyone is at risk, stop the machine with its own emergency stop and call your
              site contact.
            </p>
          )}
        </NotSent>
      )}

      {(photo || checkResult || compareResult || issueThread || failure) && (
        <button
          onClick={reset}
          disabled={busy}
          className="w-full py-3 rounded-2xl bg-white/[0.04] border border-white/[0.06] text-sm text-white/50 disabled:opacity-30"
        >
          Start over
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Jobs tab
// ---------------------------------------------------------------------------

function JobCard({ job }: { job: JobDTO }) {
  const reported = isActiveJob(job) && typeof job.progress === "number" && job.progress > 0;
  return (
    <a
      href={`/jobs/${encodeURIComponent(job.id)}`}
      className="block w-full text-left rounded-2xl bg-white/[0.03] border border-white/[0.06] p-4 space-y-2 active:scale-[0.97] transition-transform"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-white/80 leading-tight">{job.capabilityType ?? job.capabilityId}</span>
        <span className={`shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full ${statusColor(String(job.status))}`}>
          {String(job.status).replace(/_/g, " ")}
        </span>
      </div>
      {reported && (
        <div className="space-y-1">
          <div className="flex justify-between text-[10px] text-white/30">
            <span>Reported progress</span>
            <span className="font-mono">{job.progress}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-white/[0.06]">
            <div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${Math.min(100, job.progress ?? 0)}%` }} />
          </div>
        </div>
      )}
      <div className="text-[10px] text-white/30">
        <span className="font-mono">{job.id}</span> · created {timeAgo(job.createdAt)}
      </div>
    </a>
  );
}

function JobsTab() {
  const { me, kernels } = useMyKernels();
  const kernelIds = kernels ? kernels.map((k) => k.id) : [];
  const jobs = useQuery({
    queryKey: ["operator-mobile-jobs", kernelIds],
    queryFn: async () => {
      const r = await listKernelJobs(kernelIds);
      if (!r.ok) throw new Error(r.reason);
      return r.data;
    },
    enabled: kernels !== null && kernelIds.length > 0,
    refetchInterval: 15_000,
    retry: 1,
  });

  if (me.isLoading) return <Spinner />;
  if (me.isError || (me.data && kernels === null)) {
    return <UnavailableState what="your machines" error={me.error ?? me.data?.kernels?.unavailable ?? "unexpected response from /api/agent/me"} onRetry={() => void me.refetch()} />;
  }
  if (kernels && kernels.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-2 px-6 text-center">
        <div className="text-sm text-white/50">No machines are registered to this key yet.</div>
        {me.data?.next?.[0] && <div className="text-xs text-white/30">{me.data.next[0]}</div>}
      </div>
    );
  }
  if (jobs.isLoading) return <Spinner />;
  if (jobs.isError || !jobs.data) {
    return <UnavailableState what="your jobs" error={jobs.error} onRetry={() => void jobs.refetch()} />;
  }
  if (jobs.data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-2">
        <div className="text-sm text-white/40">No jobs on your machines yet.</div>
      </div>
    );
  }

  const active = jobs.data.filter(isActiveJob);
  const rest = jobs.data.filter((j) => !isActiveJob(j));
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="text-xs text-white/30">
        {active.length} in progress · {rest.length} other
        {mayBeTruncated(jobs.data) ? " · showing the latest page only" : ""}
      </div>
      {[...active, ...rest].map((job) => <JobCard key={job.id} job={job} />)}
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="w-8 h-8 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account tab
// ---------------------------------------------------------------------------

function AccountTab() {
  const { me } = useMyKernels();
  if (me.isLoading) return <Spinner />;
  if (me.isError || !me.data) {
    return <UnavailableState what="your account" error={me.error} onRetry={() => void me.refetch()} />;
  }
  const { identity } = me.data;
  const kernels = kernelsOf(me.data);
  const wildcardKeys = me.data.keys?.wildcard_keys ?? 0;
  const wildcard = identity.scopes.includes("*");
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] divide-y divide-white/[0.04]">
        {[
          { label: "Operator", value: identity.operator },
          { label: "Key", value: identity.key_name ?? identity.key_id },
          { label: "As of", value: new Date(me.data.as_of).toLocaleTimeString() },
        ].map(({ label, value }) => (
          <div key={label} className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-sm text-white/40">{label}</span>
            <span className="text-sm font-mono text-white/70 truncate">{value}</span>
          </div>
        ))}
      </div>

      {wildcard && (
        <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 px-4 py-3 text-xs text-amber-200/80">
          This key has every permission (wildcard). {wildcardKeys > 1 ? `${wildcardKeys} of your keys do.` : ""}
        </div>
      )}

      <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-4 space-y-2">
        <div className="text-xs text-white/30 uppercase tracking-wider">Your machines</div>
        {kernels === null && (
          <div className="text-xs text-amber-300/80">Unavailable: {me.data.kernels?.unavailable ?? "unexpected response"}</div>
        )}
        {kernels !== null && kernels.length === 0 && <div className="text-xs text-white/40">None registered.</div>}
        {(kernels ?? []).map((k) => (
          <div key={k.id} className="flex items-center justify-between text-xs">
            <span className="text-white/60">{k.name || k.id}</span>
            <span className="text-white/40">
              {k.status} · heartbeat {k.last_heartbeat ? timeAgo(k.last_heartbeat) : "never"}
            </span>
          </div>
        ))}
      </div>

      <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-4 space-y-3">
        <div className="text-xs text-white/30 uppercase tracking-wider">Quick links</div>
        {[
          { label: "Full operator dashboard", href: "/operator" },
          { label: "Job history", href: "/jobs" },
        ].map(({ label, href }) => (
          <a key={href} href={href} className="flex items-center justify-between py-2 border-b border-white/[0.04] last:border-0">
            <span className="text-sm text-white/60">{label}</span>
            <span className="text-white/20">›</span>
          </a>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function ConnectionBadge() {
  const signedIn = useAuthStore((s) => !!s.apiKey || !!s.sessionToken);
  const me = useAgentMe();
  let label = "Connecting…";
  let tone = "text-white/40";
  let dot = "bg-white/30";
  if (!signedIn && !me.isSuccess) {
    label = "Not signed in";
  } else if (me.isSuccess) {
    label = "Connected";
    tone = "text-emerald-400/80";
    dot = "bg-emerald-400";
  } else if (me.isError) {
    label = "Can't reach PCC";
    tone = "text-amber-300/80";
    dot = "bg-amber-400";
  }
  return (
    <div className="flex items-center gap-1.5" data-testid="connection-badge">
      <div className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      <span className={`text-[10px] ${tone}`}>{label}</span>
    </div>
  );
}

export function OperatorMobilePage() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("jobs");

  // Prevent pinch zoom (PWA)
  useEffect(() => {
    const handler = (e: TouchEvent) => {
      if (e.touches.length > 1) e.preventDefault();
    };
    document.addEventListener("touchstart", handler, { passive: false });
    return () => document.removeEventListener("touchstart", handler);
  }, []);

  const tabs: { id: ActiveTab; label: string }[] = [
    { id: "jobs", label: "My jobs" },
    { id: "photo", label: "Photo" },
    { id: "account", label: "Account" },
  ];

  return (
    <div className="flex flex-col h-screen" style={{ background: "#0A1A0F" }}>
      <div
        className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]"
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        <span className="text-sm font-semibold text-white/80">PCC Operator</span>
        <ConnectionBadge />
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {activeTab === "jobs" && <JobsTab />}
        {activeTab === "photo" && <PhotoTab />}
        {activeTab === "account" && <AccountTab />}
      </div>

      <div
        className="flex border-t border-white/[0.06] bg-black/40 backdrop-blur-xl"
        style={{ paddingBottom: "max(0px, env(safe-area-inset-bottom))" }}
      >
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex-1 flex flex-col items-center justify-center gap-1 py-3 min-h-[56px] transition-colors ${
              activeTab === id ? "text-emerald-400" : "text-white/30 active:text-white/50"
            }`}
          >
            <span className="text-xs font-medium">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
