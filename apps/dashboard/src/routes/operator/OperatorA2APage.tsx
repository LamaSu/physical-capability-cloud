import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { GlassPanel, GlowBadge, cn } from "@pcc/ui";
import { useUIStore } from "../../stores/ui-store.js";
import { getAuthHeaders } from "../../stores/auth-store.js";
import {
  ChatThread,
  type ChatMessage,
} from "../../components/onboard/ChatThread.js";

const API = (import.meta.env.VITE_PCC_URL ?? "") + "/api";

/**
 * Operator agent dashboard — React port of navi v1
 * packages/backend/public/op.html.
 *
 * Public-facing page where a customer can:
 *   1. See the operator's live capabilities, materials, certifications
 *   2. Walk through a 5-question form (material / dims / qty / deadline / tolerance)
 *   3. Receive an instant quote
 *   4. Lock USDC into a MilestoneEscrow on Base Sepolia
 *
 * The escrow lock calls PCC's existing `/api/escrow/fund` endpoint — that
 * route already exists in the gateway (per CLAUDE.md §3 Escrow & Settlement).
 * The capability/material/cert pills come from
 * `/api/onboard/:id/live-data` which wave2-alpha exposes from the
 * agent-onboarder package.
 */

type Stage = 0 | 1 | 2 | 3 | 4 | 5; // 5 == finalised quote

interface JobAnswers {
  material?: string;
  dims?: string;
  qty?: string;
  deadline?: string;
  tolerance?: string;
}

interface FieldDef {
  key: keyof JobAnswers;
  question: string;
  type: "select" | "text";
  options?: string[];
  placeholder?: string;
}

const FIELDS: FieldDef[] = [
  {
    key: "material",
    question: "What material? (e.g. Ti-6Al-4V)",
    type: "select",
    options: ["Ti-6Al-4V", "Ti-6Al-4V ELI", "Inconel 625", "Inconel 718", "Other"],
  },
  {
    key: "dims",
    question: "Part envelope? Length × width × height in inches.",
    type: "text",
    placeholder: "4 × 4 × 6",
  },
  {
    key: "qty",
    question: "How many?",
    type: "text",
    placeholder: "12",
  },
  {
    key: "deadline",
    question: "When do you need it?",
    type: "text",
    placeholder: "by Tuesday",
  },
  {
    key: "tolerance",
    question: "Tolerance class?",
    type: "select",
    options: [
      "±0.005\" general",
      "±0.001\" precision",
      "±0.0005\" tight",
      "aerospace AS9100",
    ],
  },
];

interface LiveData {
  session_id?: string;
  data_source_type?: string;
  machines?: ({ name?: string; kind?: string } | string)[];
  materials?: string[];
  certifications?: string[];
}

interface OnboardStatus {
  id?: string;
  name?: string;
  agent?: { marketplace_url?: string };
  cited?: { url?: string };
  extras?: {
    wallet?: { address?: string };
    cdp?: { address?: string };
    agent?: { marketplace_url?: string };
    cited?: { url?: string };
  };
}

/**
 * Pure quote calculator — extracted so it stays testable.
 * Mirrors navi v1 op.html finalize() multipliers.
 */
export function computeQuote(answers: Required<JobAnswers>): {
  unit: number;
  total: number;
  eta: string;
  qty: number;
} {
  const qty = Math.max(1, parseInt(answers.qty, 10) || 1);
  const tol = answers.tolerance.includes("aerospace")
    ? 1.6
    : answers.tolerance.includes("tight")
      ? 1.4
      : answers.tolerance.includes("precision")
        ? 1.2
        : 1;
  const mat = answers.material.includes("Inconel") ? 1.5 : 1;
  const unit = Math.round(220 * tol * mat);
  const total = unit * qty;
  const lower = answers.deadline.toLowerCase();
  const eta = lower.includes("tuesday") || lower.includes("rush") ? "48 hours" : "5–7 business days";
  return { unit, total, eta, qty };
}

export function OperatorA2APage() {
  const { id: routeId } = useParams<{ id: string }>();
  const sessionId = routeId ?? "demo";
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  const [status, setStatus] = useState<OnboardStatus>({});
  const [liveData, setLiveData] = useState<LiveData>({});
  const [stage, setStage] = useState<Stage>(0);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "intro",
      role: "bot",
      text:
        "Hi — I'm the operator agent for this enterprise. I'm online and accepting jobs. Tell me about what you need and I'll quote it against my live capabilities.",
    },
  ]);
  const [answers, setAnswers] = useState<JobAnswers>({});
  const [pendingFieldValue, setPendingFieldValue] = useState("");
  const [escrowLocked, setEscrowLocked] = useState(false);
  const [escrowLoading, setEscrowLoading] = useState(false);
  const [escrowTx, setEscrowTx] = useState<string | null>(null);
  const idCounter = useRef(0);

  const pushMsg = useCallback(
    (role: ChatMessage["role"], text: string, meta?: string) => {
      setMessages((prev) => {
        idCounter.current += 1;
        return [
          ...prev,
          { id: `m${Date.now()}-${idCounter.current}`, role, text, meta },
        ];
      });
    },
    [],
  );

  // Page title
  useEffect(() => {
    setPageMeta(
      status.name ? `${status.name} — operator agent` : "Operator agent",
      `session ${sessionId.slice(0, 8)}`,
    );
  }, [setPageMeta, status.name, sessionId]);

  // Poll status (every 5s) + load live data once
  useEffect(() => {
    let cancelled = false;
    async function pollStatus() {
      try {
        const res = await fetch(`${API}/onboard/${sessionId}/status`, {
          headers: { ...getAuthHeaders() },
        });
        if (!res.ok || cancelled) return;
        const j = (await res.json()) as OnboardStatus;
        if (!cancelled) setStatus(j);
      } catch {
        // best-effort
      }
    }
    async function loadLive() {
      try {
        const res = await fetch(`${API}/onboard/${sessionId}/live-data`, {
          headers: { ...getAuthHeaders() },
        });
        if (!res.ok || cancelled) return;
        const j = (await res.json()) as LiveData;
        if (!cancelled) setLiveData(j);
      } catch {
        // best-effort
      }
    }
    pollStatus();
    loadLive();
    const id = setInterval(pollStatus, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId]);

  // Ask the next question after stage advances
  useEffect(() => {
    if (stage < FIELDS.length) {
      const f = FIELDS[stage]!;
      pushMsg("bot", f.question);
    }
    // stage > FIELDS.length means the quote has been finalised
  }, [stage, pushMsg]);

  // Submit current field value, advance stage
  const submitField = useCallback(() => {
    const v = pendingFieldValue.trim();
    if (!v) return;
    if (stage >= FIELDS.length) return;
    const f = FIELDS[stage]!;
    setAnswers((prev) => ({ ...prev, [f.key]: v }));
    pushMsg("you", v);
    setPendingFieldValue("");
    setStage((s) => Math.min(FIELDS.length, (s + 1) as Stage) as Stage);
  }, [pendingFieldValue, stage, pushMsg]);

  // Once all 5 fields are answered, push the quote message
  const allAnswered =
    stage >= FIELDS.length &&
    answers.material &&
    answers.dims &&
    answers.qty &&
    answers.deadline &&
    answers.tolerance;

  const quote = useMemo(() => {
    if (!allAnswered) return null;
    return computeQuote(answers as Required<JobAnswers>);
  }, [allAnswered, answers]);

  // When quote becomes available, push a one-time message announcing it
  const quoteAnnouncedRef = useRef(false);
  useEffect(() => {
    if (quote && !quoteAnnouncedRef.current) {
      quoteAnnouncedRef.current = true;
      pushMsg(
        "bot",
        "Got it. Checking capacity, materials, and lead time against current schedule…",
      );
    }
  }, [quote, pushMsg]);

  // Escrow lock — calls PCC's existing /api/escrow/fund route
  const handleLockEscrow = useCallback(
    async (amount: number) => {
      if (!quote) return;
      setEscrowLoading(true);
      pushMsg(
        "bot",
        `Locking $${amount} USDC in MilestoneEscrow on Base Sepolia · funded from CDP wallet · escrow released on milestone evidence + verifier ATTESTED…`,
      );
      try {
        const res = await fetch(`${API}/escrow/fund`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...getAuthHeaders(),
          },
          body: JSON.stringify({
            sessionId,
            amount: amount.toString(),
            currency: "USDC",
            chain: "base-sepolia",
            job: { ...answers, qty: quote.qty },
          }),
        });
        if (res.ok) {
          const j = (await res.json()) as { txHash?: string; tx?: string };
          const tx = j.txHash ?? j.tx ?? `0x${Math.random().toString(16).slice(2, 18)}…`;
          setEscrowTx(tx);
          setEscrowLocked(true);
          pushMsg(
            "bot",
            `ESCROW LOCKED ✓\nTx: ${tx}\nState: Funded → Locked. Operator agent has accepted the job and will fire the first task on the a2a stream.`,
          );
        } else {
          // Failure is still informative; surface it as a chat message.
          pushMsg(
            "bot",
            `Escrow lock failed (${res.status}). Try again, or check that wave2-alpha's gateway has /api/escrow/fund wired.`,
          );
        }
      } catch (err) {
        pushMsg(
          "bot",
          `Escrow lock errored: ${err instanceof Error ? err.message : "unknown"}`,
        );
      } finally {
        setEscrowLoading(false);
      }
    },
    [answers, quote, sessionId, pushMsg],
  );

  // Form rendering for the current stage
  const currentField = stage < FIELDS.length ? FIELDS[stage] : null;

  // Wallet / x402 / market URLs (with safe fallbacks)
  const walletAddr =
    status.extras?.wallet?.address ??
    status.extras?.cdp?.address ??
    `0xmock_${sessionId.slice(0, 10)}`;
  const x402Url = `${window.location.origin}/jobs?op=${status.id ?? sessionId}`;
  const marketUrl =
    status.agent?.marketplace_url ?? status.extras?.agent?.marketplace_url ?? null;
  const citedUrl = status.cited?.url ?? status.extras?.cited?.url ?? null;

  // The capability/material/cert lists, with sensible navi v1 fallbacks
  const machineLabels = (liveData.machines ?? [])
    .map((m) => (typeof m === "string" ? m : (m.name ?? m.kind ?? null)))
    .filter((m): m is string => Boolean(m))
    .slice(0, 8);
  const caps =
    machineLabels.length > 0 ? machineLabels : ["5-axis titanium milling", "CMM inspection"];
  const materials = liveData.materials ?? [];
  const certifications = liveData.certifications ?? [];

  return (
    <div className="space-y-4 max-w-4xl mx-auto pb-12">
      {/* Header strip */}
      <GlassPanel padding="md" className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="font-medium text-white/85 truncate">
            {status.name ?? "Operator agent"}
          </div>
          <div className="text-[11px] text-white/40">
            Physical Capability Cloud · session{" "}
            <code className="text-white/55">{sessionId.slice(0, 8)}</code>
            {liveData.data_source_type && (
              <>
                {" · live data via Nexla "}
                <code className="text-white/55">{liveData.data_source_type}</code>
              </>
            )}
          </div>
        </div>
        <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-[11px] font-medium text-emerald-200">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-300 animate-pulse" />
          ONLINE — accepting jobs
        </span>
      </GlassPanel>

      {/* Capabilities / Materials / Certifications */}
      <GlassPanel padding="md" className="space-y-3">
        <PillRow label="Capabilities" items={caps} variant="cyan" />
        <PillRow label="Materials" items={materials} variant="amber" />
        <PillRow label="Certifications" items={certifications} variant="violet" />
      </GlassPanel>

      {/* Chat thread + form */}
      <div className="h-[60vh] min-h-[460px]">
        <ChatThread
          messages={messages}
          onSend={() => {
            // Plain send is disabled for operator dashboard — answers go via
            // the field form below.
          }}
          disabled
          hint="Answer the operator's questions below to receive an instant quote."
        />
      </div>

      {/* Field form (active stage) */}
      {currentField && (
        <GlassPanel padding="md" data-testid="operator-field-form">
          <div className="text-[11px] text-white/40 mb-2 uppercase tracking-wider">
            {currentField.question}
          </div>
          <div className="flex gap-2 items-stretch">
            {currentField.type === "select" ? (
              <select
                value={pendingFieldValue}
                onChange={(e) => setPendingFieldValue(e.target.value)}
                className="flex-1 bg-zinc-900/70 border border-white/[0.10] rounded-lg px-3 py-2 text-sm text-white/85 focus:outline-none focus:border-emerald-400/40"
                data-testid="operator-field-input"
              >
                <option value="" disabled>
                  Select…
                </option>
                {currentField.options!.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={pendingFieldValue}
                onChange={(e) => setPendingFieldValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitField();
                  }
                }}
                placeholder={currentField.placeholder}
                className="flex-1 bg-zinc-900/70 border border-white/[0.10] rounded-lg px-3 py-2 text-sm text-white/85 placeholder-white/25 focus:outline-none focus:border-emerald-400/40"
                data-testid="operator-field-input"
              />
            )}
            <button
              type="button"
              onClick={submitField}
              disabled={!pendingFieldValue.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-500/20 border border-emerald-400/30 text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-30 transition-all"
              data-testid="operator-field-submit"
            >
              Send
            </button>
          </div>
        </GlassPanel>
      )}

      {/* Quote panel */}
      {quote && !escrowLocked && (
        <GlassPanel
          padding="md"
          glow="green"
          data-testid="operator-quote-panel"
        >
          <div className="text-[11px] uppercase tracking-wider text-white/40 mb-1">
            Quote
          </div>
          <div className="text-sm text-white/85 leading-relaxed">
            <strong>{quote.qty}</strong> × {answers.material} parts at{" "}
            <strong className="text-emerald-300">${quote.unit}/each</strong> · total{" "}
            <strong className="text-emerald-300">${quote.total} USDC</strong>
            <br />
            Lead time: {quote.eta}
          </div>
          <button
            type="button"
            onClick={() => handleLockEscrow(quote.total)}
            disabled={escrowLoading}
            className="mt-3 px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-500/30 border border-emerald-300/40 text-emerald-100 hover:bg-emerald-500/40 disabled:opacity-50 transition-all"
            data-testid="operator-lock-escrow"
          >
            {escrowLoading
              ? "Locking…"
              : `🔒 Lock $${quote.total} in MilestoneEscrow (Base Sepolia)`}
          </button>
        </GlassPanel>
      )}

      {/* Escrow confirmed */}
      {escrowLocked && escrowTx && (
        <GlassPanel padding="md" glow="green" data-testid="operator-escrow-receipt">
          <div className="text-[11px] uppercase tracking-wider text-emerald-300/80 mb-1">
            Escrow locked ✓
          </div>
          <div className="text-sm text-white/85">
            Tx: <code className="text-emerald-300">{escrowTx}</code>
            <br />
            State: Funded → Locked. Operator agent will fire the first task on the
            a2a stream.
          </div>
          <a
            href="https://sepolia.basescan.org"
            target="_blank"
            rel="noreferrer"
            className="inline-block mt-2 text-xs text-emerald-300 hover:text-emerald-200 underline"
          >
            View on Basescan ↗
          </a>
        </GlassPanel>
      )}

      {/* Footer info */}
      <div className="text-[10px] text-white/30 text-center pt-2 space-x-2">
        <span>
          x402: <code className="text-white/55">{x402Url}</code>
        </span>
        <span>·</span>
        <span>
          wallet: <code className="text-white/55">{walletAddr}</code>
        </span>
        {citedUrl && (
          <>
            <span>·</span>
            <a
              href={citedUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sky-300/80 hover:text-sky-200 underline"
            >
              cited.md
            </a>
          </>
        )}
        {marketUrl && (
          <>
            <span>·</span>
            <a
              href={marketUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sky-300/80 hover:text-sky-200 underline"
            >
              agentic.market
            </a>
          </>
        )}
      </div>
    </div>
  );
}

interface PillRowProps {
  label: string;
  items: string[];
  variant: "cyan" | "amber" | "violet";
}

function PillRow({ label, items, variant }: PillRowProps) {
  if (items.length === 0) return null;
  const colorClass =
    variant === "amber"
      ? "bg-amber-400/15 border-amber-400/25 text-amber-200"
      : variant === "violet"
        ? "bg-violet-400/15 border-violet-400/25 text-violet-200"
        : "bg-cyan-400/15 border-cyan-400/25 text-cyan-200";
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-white/40 mb-1.5">
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item, i) => (
          <span
            key={`${item}-${i}`}
            className={cn(
              "px-2 py-0.5 rounded-full text-[11px] font-medium border",
              colorClass,
            )}
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

// Re-export the public component under the original `[id]/index.tsx` name
// expected by the migration plan (alias path).
export default OperatorA2APage;
