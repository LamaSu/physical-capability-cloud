import React, { useRef, useState, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Job {
  id: string;
  title: string;
  status: "active" | "pending" | "completed" | "failed";
  progress: number;
  startedAt: string;
  kernelId?: string;
}

interface UploadResult {
  cid: string;
  antiSpoofScore: number;
}

interface CompareResult {
  match: boolean;
  similarity: number;
}

type ActiveTab = "camera" | "jobs" | "settings";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sha256B64(dataUrl: string): Promise<string> {
  const base64 = dataUrl.split(",")[1] ?? "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function formatElapsed(isoStr: string): string {
  const ms = Date.now() - new Date(isoStr).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function statusColor(status: Job["status"]): string {
  switch (status) {
    case "active":
      return "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30";
    case "pending":
      return "bg-amber-500/20 text-amber-400 border border-amber-500/30";
    case "completed":
      return "bg-sky-500/20 text-sky-400 border border-sky-500/30";
    case "failed":
      return "bg-red-500/20 text-red-400 border border-red-500/30";
    default:
      return "bg-white/10 text-white/50";
  }
}

// ---------------------------------------------------------------------------
// Mock API fetchers (real calls would hit /api/*)
// ---------------------------------------------------------------------------

async function fetchActiveJobs(): Promise<Job[]> {
  try {
    const res = await fetch("/api/jobs?status=active");
    if (res.ok) return res.json() as Promise<Job[]>;
  } catch {
    // fall through to mock
  }
  // Mock fallback
  return [
    {
      id: "job-001",
      title: "FDM Print — Bracket v3",
      status: "active",
      progress: 62,
      startedAt: new Date(Date.now() - 1_800_000).toISOString(),
    },
    {
      id: "job-002",
      title: "CNC Mill — Plate A",
      status: "active",
      progress: 88,
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
    {
      id: "job-003",
      title: "Laser Engrave — Logo Run",
      status: "pending",
      progress: 0,
      startedAt: new Date(Date.now() - 120_000).toISOString(),
    },
  ];
}

async function uploadPhoto(
  base64: string,
  hash: string,
  notes: string
): Promise<UploadResult> {
  try {
    const res = await fetch("/api/photo/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, sha256: hash, notes }),
    });
    if (res.ok) return res.json() as Promise<UploadResult>;
  } catch {
    // fall through to mock
  }
  // Mock response
  await new Promise((r) => setTimeout(r, 600));
  return {
    cid: `bafybei${hash.slice(0, 36)}`,
    antiSpoofScore: 0.94,
  };
}

async function comparePhoto(base64: string, jobId: string): Promise<CompareResult> {
  try {
    const res = await fetch("/api/photo/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, jobId }),
    });
    if (res.ok) return res.json() as Promise<CompareResult>;
  } catch {
    // fall through to mock
  }
  await new Promise((r) => setTimeout(r, 800));
  return { match: true, similarity: 0.91 };
}

async function reportIssue(
  base64: string | null,
  text: string,
  jobId: string | null
): Promise<{ issueId: string }> {
  try {
    const res = await fetch("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, text, jobId }),
    });
    if (res.ok) return res.json() as Promise<{ issueId: string }>;
  } catch {
    // fall through
  }
  await new Promise((r) => setTimeout(r, 400));
  return { issueId: `issue-${Date.now()}` };
}

// ---------------------------------------------------------------------------
// Camera Tab
// ---------------------------------------------------------------------------

type CameraMode = "idle" | "preview" | "uploading" | "result";

function CameraTab() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<CameraMode>("idle");
  const [preview, setPreview] = useState<string | null>(null);
  const [hash, setHash] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);
  const [issueText, setIssueText] = useState("");
  const [issueJobId, setIssueJobId] = useState("");
  const [issueSent, setIssueSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMode, setActionMode] = useState<"upload" | "compare" | "issue">("upload");

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setError(null);
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const dataUrl = ev.target?.result as string;
        setPreview(dataUrl);
        const h = await sha256B64(dataUrl);
        setHash(h);
        setMode("preview");
        setUploadResult(null);
        setCompareResult(null);
        setIssueSent(false);
      };
      reader.readAsDataURL(file);
    },
    []
  );

  const handleUpload = useCallback(async () => {
    if (!preview) return;
    setMode("uploading");
    try {
      const result = await uploadPhoto(preview, hash, notes);
      setUploadResult(result);
      setMode("result");
    } catch (err) {
      setError("Upload failed. Please try again.");
      setMode("preview");
    }
  }, [preview, hash, notes]);

  const handleCompare = useCallback(async () => {
    if (!preview) return;
    setMode("uploading");
    try {
      const result = await comparePhoto(preview, issueJobId || "default-job");
      setCompareResult(result);
      setMode("result");
    } catch (err) {
      setError("Compare failed.");
      setMode("preview");
    }
  }, [preview, issueJobId]);

  const handleReportIssue = useCallback(async () => {
    if (!issueText.trim()) return;
    setMode("uploading");
    try {
      await reportIssue(preview, issueText, issueJobId || null);
      setIssueSent(true);
      setMode("result");
    } catch (err) {
      setError("Failed to send report.");
      setMode("preview");
    }
  }, [preview, issueText, issueJobId]);

  const reset = () => {
    setMode("idle");
    setPreview(null);
    setHash("");
    setNotes("");
    setUploadResult(null);
    setCompareResult(null);
    setIssueSent(false);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      {error && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Action mode selector */}
      <div className="flex gap-2">
        {(["upload", "compare", "issue"] as const).map((m) => (
          <button
            key={m}
            onClick={() => { setActionMode(m); reset(); }}
            className={`flex-1 py-2 rounded-xl text-xs font-medium transition-all ${
              actionMode === m
                ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
                : "bg-white/[0.04] text-white/40 border border-white/[0.06]"
            }`}
          >
            {m === "upload" ? "Upload Photo" : m === "compare" ? "Verify Print" : "Report Issue"}
          </button>
        ))}
      </div>

      {/* Camera input — always present for accessibility */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFileChange}
      />

      {mode === "idle" && (
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex flex-col items-center justify-center gap-3 w-full rounded-2xl
                     bg-emerald-500/10 border-2 border-dashed border-emerald-500/40
                     py-16 text-emerald-400 active:scale-[0.97] transition-transform"
        >
          <svg viewBox="0 0 24 24" className="w-12 h-12" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
          </svg>
          <span className="text-base font-semibold">Take Photo</span>
          <span className="text-xs text-emerald-400/60">Tap to open camera</span>
        </button>
      )}

      {(mode === "preview" || mode === "uploading") && preview && (
        <div className="flex flex-col gap-4">
          <div className="relative rounded-2xl overflow-hidden border border-white/[0.08]">
            <img src={preview} alt="Captured" className="w-full object-cover max-h-72" />
            {mode === "uploading" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                <div className="flex flex-col items-center gap-2">
                  <div className="w-8 h-8 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" />
                  <span className="text-xs text-white/60">Processing…</span>
                </div>
              </div>
            )}
          </div>

          {/* Hash display */}
          <div className="rounded-xl bg-white/[0.04] border border-white/[0.06] px-3 py-2">
            <div className="text-[10px] text-white/30 mb-1">SHA-256</div>
            <div className="text-[10px] font-mono text-white/50 break-all">{hash}</div>
          </div>

          {/* Action-specific inputs */}
          {actionMode === "upload" && (
            <>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Add notes (optional)…"
                rows={3}
                className="w-full rounded-xl bg-white/[0.04] border border-white/[0.06]
                           px-3 py-2 text-sm text-white/80 placeholder:text-white/20
                           resize-none focus:outline-none focus:border-emerald-500/40"
              />
              <button
                onClick={handleUpload}
                disabled={mode === "uploading"}
                className="w-full py-4 rounded-2xl bg-emerald-500 text-black font-semibold
                           text-base active:scale-[0.97] transition-transform disabled:opacity-50"
              >
                Upload to IPFS
              </button>
            </>
          )}

          {actionMode === "compare" && (
            <>
              <input
                value={issueJobId}
                onChange={(e) => setIssueJobId(e.target.value)}
                placeholder="Job ID (optional)"
                className="w-full rounded-xl bg-white/[0.04] border border-white/[0.06]
                           px-3 py-2 text-sm text-white/80 placeholder:text-white/20
                           focus:outline-none focus:border-emerald-500/40"
              />
              <button
                onClick={handleCompare}
                disabled={mode === "uploading"}
                className="w-full py-4 rounded-2xl bg-sky-500 text-black font-semibold
                           text-base active:scale-[0.97] transition-transform disabled:opacity-50"
              >
                Compare to Reference
              </button>
            </>
          )}

          {actionMode === "issue" && (
            <>
              <textarea
                value={issueText}
                onChange={(e) => setIssueText(e.target.value)}
                placeholder="Describe the issue…"
                rows={3}
                className="w-full rounded-xl bg-white/[0.04] border border-white/[0.06]
                           px-3 py-2 text-sm text-white/80 placeholder:text-white/20
                           resize-none focus:outline-none focus:border-emerald-500/40"
              />
              <button
                onClick={handleReportIssue}
                disabled={mode === "uploading" || !issueText.trim()}
                className="w-full py-4 rounded-2xl bg-amber-500 text-black font-semibold
                           text-base active:scale-[0.97] transition-transform disabled:opacity-50"
              >
                Send Report
              </button>
            </>
          )}

          <button
            onClick={reset}
            disabled={mode === "uploading"}
            className="w-full py-3 rounded-2xl bg-white/[0.04] border border-white/[0.06]
                       text-sm text-white/40 active:scale-[0.97] transition-transform disabled:opacity-30"
          >
            Retake
          </button>
        </div>
      )}

      {mode === "result" && (
        <div className="flex flex-col gap-4">
          {preview && (
            <div className="rounded-2xl overflow-hidden border border-white/[0.08]">
              <img src={preview} alt="Captured" className="w-full object-cover max-h-48" />
            </div>
          )}

          {/* Upload result */}
          {uploadResult && (
            <div className="rounded-2xl bg-emerald-500/10 border border-emerald-500/30 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center text-black text-xs font-bold">
                  ✓
                </div>
                <span className="text-sm font-semibold text-emerald-400">Uploaded</span>
              </div>
              <div>
                <div className="text-[10px] text-white/30 mb-1">IPFS CID</div>
                <div className="text-xs font-mono text-white/60 break-all">{uploadResult.cid}</div>
              </div>
              <div>
                <div className="text-[10px] text-white/30 mb-1">Anti-spoof Score</div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-2 rounded-full bg-white/10">
                    <div
                      className="h-2 rounded-full bg-emerald-500"
                      style={{ width: `${uploadResult.antiSpoofScore * 100}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono text-emerald-400">
                    {(uploadResult.antiSpoofScore * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Compare result */}
          {compareResult && (
            <div
              className={`rounded-2xl p-4 space-y-3 ${
                compareResult.match
                  ? "bg-emerald-500/10 border border-emerald-500/30"
                  : "bg-red-500/10 border border-red-500/30"
              }`}
            >
              <div className="flex items-center gap-2">
                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-black text-xs font-bold ${
                    compareResult.match ? "bg-emerald-500" : "bg-red-500"
                  }`}
                >
                  {compareResult.match ? "✓" : "✗"}
                </div>
                <span
                  className={`text-sm font-semibold ${
                    compareResult.match ? "text-emerald-400" : "text-red-400"
                  }`}
                >
                  {compareResult.match ? "Matches Reference" : "Mismatch Detected"}
                </span>
              </div>
              <div>
                <div className="text-[10px] text-white/30 mb-1">Similarity</div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-2 rounded-full bg-white/10">
                    <div
                      className={`h-2 rounded-full ${compareResult.match ? "bg-emerald-500" : "bg-red-500"}`}
                      style={{ width: `${compareResult.similarity * 100}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono text-white/60">
                    {(compareResult.similarity * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Issue sent */}
          {issueSent && (
            <div className="rounded-2xl bg-amber-500/10 border border-amber-500/30 p-4">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded-full bg-amber-500 flex items-center justify-center text-black text-xs font-bold">
                  ✓
                </div>
                <span className="text-sm font-semibold text-amber-400">Issue Reported</span>
              </div>
              <p className="text-xs text-white/40 mt-2">
                Your report has been sent to the agent.
              </p>
            </div>
          )}

          <button
            onClick={reset}
            className="w-full py-4 rounded-2xl bg-white/[0.04] border border-white/[0.06]
                       text-sm text-white/60 font-medium active:scale-[0.97] transition-transform"
          >
            Take Another Photo
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Jobs Tab
// ---------------------------------------------------------------------------

function JobCard({ job, onTap }: { job: Job; onTap: (id: string) => void }) {
  return (
    <button
      onClick={() => onTap(job.id)}
      className="w-full text-left rounded-2xl bg-white/[0.03] border border-white/[0.06]
                 p-4 flex flex-col gap-3 active:scale-[0.97] transition-transform"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-white/80 leading-tight">{job.title}</span>
        <span className={`shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full ${statusColor(job.status)}`}>
          {job.status}
        </span>
      </div>
      {/* Progress bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-[10px] text-white/30">
          <span>Progress</span>
          <span className="font-mono">{job.progress}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-white/[0.06]">
          <div
            className="h-1.5 rounded-full bg-emerald-500 transition-all"
            style={{ width: `${job.progress}%` }}
          />
        </div>
      </div>
      {/* Timer */}
      <div className="text-[10px] text-white/30">
        Elapsed: <span className="font-mono text-white/50">{formatElapsed(job.startedAt)}</span>
      </div>
    </button>
  );
}

function JobsTab() {
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const { data: jobs, isLoading, error } = useQuery({
    queryKey: ["mobile-active-jobs"],
    queryFn: fetchActiveJobs,
    refetchInterval: 15_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="w-8 h-8 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 py-4">
        <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400">
          Failed to load jobs.
        </div>
      </div>
    );
  }

  if (!jobs?.length) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-2">
        <div className="text-3xl opacity-40">📭</div>
        <div className="text-sm text-white/30">No active jobs</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="text-xs text-white/30 mb-1">
        {jobs.length} active job{jobs.length !== 1 ? "s" : ""}
      </div>
      {jobs.map((job) => (
        <div key={job.id}>
          <JobCard
            job={job}
            onTap={(id) => setExpandedJob(expandedJob === id ? null : id)}
          />
          {expandedJob === job.id && (
            <div className="mt-1 ml-4 rounded-b-2xl bg-white/[0.02] border border-t-0 border-white/[0.06] p-4 space-y-2">
              <div className="text-[10px] text-white/30 uppercase tracking-wider mb-2">
                Evidence Timeline
              </div>
              {[
                { label: "Job queued", time: "0s" },
                { label: "Material loaded", time: "+2m" },
                { label: "Printing started", time: "+3m" },
                { label: "Layer 42 snapshot", time: "+12m" },
                { label: "Layer 88 snapshot", time: "+24m" },
              ].map((evt, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-500/60 shrink-0" />
                  <div className="flex-1 text-xs text-white/50">{evt.label}</div>
                  <div className="text-[10px] font-mono text-white/30">{evt.time}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings Tab
// ---------------------------------------------------------------------------

function SettingsTab() {
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] divide-y divide-white/[0.04]">
        {[
          { label: "Kernel ID", value: "kern-alpha-01" },
          { label: "Operator", value: "op-9f3a2b" },
          { label: "Network", value: "Base Sepolia" },
          { label: "Agent Status", value: "Online" },
          { label: "App Version", value: "v0.1.0-pwa" },
        ].map(({ label, value }) => (
          <div key={label} className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-white/40">{label}</span>
            <span className="text-sm font-mono text-white/70">{value}</span>
          </div>
        ))}
      </div>

      <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-4 space-y-3">
        <div className="text-xs text-white/30 uppercase tracking-wider">Quick Links</div>
        {[
          { label: "Full Operator Dashboard", href: "/operator" },
          { label: "Job History", href: "/jobs" },
          { label: "Evidence Explorer", href: "/evidence" },
          { label: "Sensor Live View", href: "/sensors" },
        ].map(({ label, href }) => (
          <a
            key={href}
            href={href}
            className="flex items-center justify-between py-2 border-b border-white/[0.04] last:border-0"
          >
            <span className="text-sm text-white/60">{label}</span>
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-white/20">
              <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clipRule="evenodd" />
            </svg>
          </a>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function OperatorMobilePage() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("camera");

  // Prevent zoom on double-tap (PWA best practice)
  useEffect(() => {
    const handler = (e: TouchEvent) => {
      if (e.touches.length > 1) e.preventDefault();
    };
    document.addEventListener("touchstart", handler, { passive: false });
    return () => document.removeEventListener("touchstart", handler);
  }, []);

  const tabConfig: { id: ActiveTab; label: string; icon: React.ReactNode }[] = [
    {
      id: "camera",
      label: "Camera",
      icon: (
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
        </svg>
      ),
    },
    {
      id: "jobs",
      label: "Jobs",
      icon: (
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z" />
        </svg>
      ),
    },
    {
      id: "settings",
      label: "Settings",
      icon: (
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </svg>
      ),
    },
  ];

  return (
    <div
      className="flex flex-col h-screen"
      style={{ background: "#0A1A0F" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]"
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-emerald-500/20 flex items-center justify-center">
            <svg viewBox="0 0 16 16" fill="none" className="w-4 h-4">
              <circle cx="8" cy="8" r="4" fill="#10B981" opacity="0.9" />
              <circle cx="8" cy="8" r="7" stroke="#10B981" strokeWidth="1.5" opacity="0.4" />
            </svg>
          </div>
          <span className="text-sm font-semibold text-white/80">PCC Operator</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[10px] text-emerald-400/70">Live</span>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {activeTab === "camera" && <CameraTab />}
        {activeTab === "jobs" && <JobsTab />}
        {activeTab === "settings" && <SettingsTab />}
      </div>

      {/* Bottom nav */}
      <div
        className="flex border-t border-white/[0.06] bg-black/40 backdrop-blur-xl"
        style={{ paddingBottom: "max(0px, env(safe-area-inset-bottom))" }}
      >
        {tabConfig.map(({ id, label, icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex-1 flex flex-col items-center justify-center gap-1 py-3 min-h-[56px]
                        transition-colors ${
                          activeTab === id
                            ? "text-emerald-400"
                            : "text-white/30 active:text-white/50"
                        }`}
          >
            {icon}
            <span className="text-[10px] font-medium">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
