import React from "react";
import { useQuery } from "@tanstack/react-query";
import { GlassPanel, DataCell, StatusChip, EmptyState, LoadingShell } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store";
import { apiGet } from "../lib/api.js";
import { UnavailableState, StaleNotice } from "../components/LiveState.js";
import { NotLiveState, DemoBanner } from "../components/DemoState.js";
import { isDemoMode } from "../lib/demo-mode.js";
import { DEMO_ORACLE_STATUS } from "../demo/SubnetStatusPage.fixtures.js";

/**
 * Verification Oracles: the UMA, Chainlink, EigenLayer verification cascade.
 *
 * Live source: GET /api/verification/subnet-status (gateway routes/zk-proofs.ts),
 * the gateway's OracleVerificationBridge. It reports whether the cascade is
 * available, each oracle's availability and counts, and the latest results.
 * The counts cover evidence submitted through POST
 * /api/verification/subnet-submit since the gateway process started; they are
 * held in memory.
 *
 * That route is real only when the gateway runs the cascade live. By default
 * (ORACLE_MOCK not set to "false") the bridge simulates UMA and Chainlink: both
 * report available with no chain connection, and each result is a local
 * evidence check labelled as an oracle verdict. The route doesn't say which
 * mode it is in. GET /api/status/live does (services.uma_oracle.mode, computed
 * by the same configFromEnv() the bridge is built from), so the page reads the
 * mode first, shows the cascade only when it is "real", and otherwise says it
 * is simulated.
 *
 * This page used to load a fixed set of sample metrics and oracles on every
 * visit and fall back to them whenever it had no oracle list or results. GET
 * /api/subnet/metrics (routes/subnet.ts) is not used: it reports in-process
 * simulated Bittensor miners, and says so. In demo mode (lib/demo-mode.ts) the
 * prototype renders sample values under a DemoBanner.
 */

export interface OracleResult {
  oracle: string;
  passed: boolean;
  score: number;
  timestamp: string;
}

export interface OracleEntry {
  name: string;
  available: boolean;
  totalVerifications: number;
  averageScore: number;
  isPrimary: boolean;
}

/** The fields of GET /api/verification/subnet-status this page renders. */
export interface OracleCascadeStatus {
  available: boolean;
  metrics: {
    totalVerifications: number;
    averageScore: number;
    activeOracles: number;
    recentResults: OracleResult[];
  };
  oracles: OracleEntry[];
}

type OracleMode = "real" | "mock";

const SIMULATED_DETAIL =
  "This gateway runs the oracle cascade in simulation mode (ORACLE_MOCK is not set to false). " +
  "In that mode GET /api/verification/subnet-status reports UMA and Chainlink as available without " +
  "any chain connection, and its results are local evidence checks, not oracle verdicts.";

// ── Reads ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 0;
}

const UNEXPECTED = "Unexpected response from /api/verification/subnet-status";

function parseResult(value: unknown): OracleResult {
  if (
    isRecord(value) &&
    typeof value.oracle === "string" &&
    typeof value.passed === "boolean" &&
    isNumber(value.score) &&
    typeof value.timestamp === "string"
  ) {
    return { oracle: value.oracle, passed: value.passed, score: value.score, timestamp: value.timestamp };
  }
  throw new Error(UNEXPECTED);
}

function parseOracle(value: unknown): OracleEntry {
  if (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.available === "boolean" &&
    isCount(value.totalVerifications) &&
    isNumber(value.averageScore) &&
    typeof value.isPrimary === "boolean"
  ) {
    return {
      name: value.name,
      available: value.available,
      totalVerifications: value.totalVerifications,
      averageScore: value.averageScore,
      isPrimary: value.isPrimary,
    };
  }
  throw new Error(UNEXPECTED);
}

/** A response that isn't the bridge's status is a failed read, never zeros. */
export function parseCascadeStatus(body: unknown): OracleCascadeStatus {
  if (!isRecord(body) || typeof body.available !== "boolean" || !isRecord(body.metrics) || !Array.isArray(body.oracles)) {
    throw new Error(UNEXPECTED);
  }
  const m = body.metrics;
  if (!isCount(m.totalVerifications) || !isNumber(m.averageScore) || !isCount(m.activeOracles) || !Array.isArray(m.recentResults)) {
    throw new Error(UNEXPECTED);
  }
  return {
    available: body.available,
    metrics: {
      totalVerifications: m.totalVerifications,
      averageScore: m.averageScore,
      activeOracles: m.activeOracles,
      recentResults: m.recentResults.map(parseResult),
    },
    oracles: body.oracles.map(parseOracle),
  };
}

/** GET /api/status/live: services.uma_oracle.mode says whether the cascade is live or simulated. */
async function readOracleMode(): Promise<OracleMode> {
  const body = await apiGet<unknown>("/status/live");
  const services = isRecord(body) && isRecord(body.services) ? body.services : undefined;
  const mode = services && isRecord(services.uma_oracle) ? services.uma_oracle.mode : undefined;
  if (mode === "real" || mode === "mock") return mode;
  throw new Error("GET /api/status/live didn't say whether the oracle cascade is live");
}

async function readCascadeStatus(): Promise<OracleCascadeStatus> {
  return parseCascadeStatus(await apiGet<unknown>("/verification/subnet-status"));
}

// ── Helpers ─────────────────────────────────────────────────────

function oracleLabel(name: string): string {
  const labels: Record<string, string> = {
    uma: "UMA Optimistic Oracle",
    chainlink: "Chainlink Functions",
    eigenlayer: "EigenLayer AVS",
    none: "None",
  };
  return labels[name] ?? name;
}

function formatTimeAgo(timestamp: string): string {
  const then = new Date(timestamp).getTime();
  if (!Number.isFinite(then)) return "—";
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ago`;
}

// ── Component ───────────────────────────────────────────────────

export function SubnetStatusPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const demo = isDemoMode();

  const modeQ = useQuery({
    queryKey: ["status", "live", "oracle-mode"],
    queryFn: readOracleMode,
    enabled: !demo,
    retry: 1,
  });
  const cascadeQ = useQuery({
    queryKey: ["verification", "subnet-status"],
    queryFn: readCascadeStatus,
    enabled: !demo && modeQ.data === "real",
    retry: 1,
  });

  React.useEffect(() => {
    setPageMeta("Verification Oracles", "Three-tier oracle cascade: UMA Optimistic Oracle, Chainlink Functions, EigenLayer AVS");
  }, [setPageMeta]);

  if (demo) {
    return (
      <div className="space-y-6">
        <DemoBanner what="Verification Oracles" />
        <CascadeView status={DEMO_ORACLE_STATUS} prototype />
      </div>
    );
  }

  if (modeQ.isPending) return <LoadingShell rows={3} />;

  if (modeQ.data === undefined) {
    return (
      <GlassPanel padding="lg">
        <UnavailableState what="oracle status" error={modeQ.error} onRetry={() => void modeQ.refetch()} />
      </GlassPanel>
    );
  }

  if (modeQ.data === "mock") {
    return (
      <GlassPanel padding="lg">
        <NotLiveState what="Oracle verification" detail={SIMULATED_DETAIL} hasDemo />
      </GlassPanel>
    );
  }

  if (cascadeQ.isPending) return <LoadingShell rows={3} />;

  if (!cascadeQ.data) {
    return (
      <GlassPanel padding="lg">
        <UnavailableState what="oracle status" error={cascadeQ.error} onRetry={() => void cascadeQ.refetch()} />
      </GlassPanel>
    );
  }

  const failedRefresh = [modeQ, cascadeQ].filter((q) => q.isError);

  return (
    <div className="space-y-6">
      {failedRefresh.length > 0 && (
        <StaleNotice
          what="oracle status"
          updatedAt={Math.min(...failedRefresh.map((q) => q.dataUpdatedAt))}
          onRetry={() => {
            void modeQ.refetch();
            void cascadeQ.refetch();
          }}
        />
      )}
      <CascadeView status={cascadeQ.data} />
    </div>
  );
}

/**
 * The cascade view. Live, it renders only what the route returned. The demo
 * prototype (`prototype`) also shows its static notes about each oracle.
 */
function CascadeView({ status, prototype = false }: { status: OracleCascadeStatus; prototype?: boolean }) {
  const { available, metrics, oracles } = status;
  const results = metrics.recentResults;

  return (
    <div className="space-y-6">
      {/* Oracle Status + KPIs */}
      <div className="grid grid-cols-4 gap-4">
        <GlassPanel padding="md" glow={available ? "green" : "none"}>
          <DataCell
            label="Oracle Cascade"
            value={
              <StatusChip
                status={available ? "online" : "offline"}
                label={available ? "Available" : "Unavailable"}
              />
            }
          />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell
            label="Verifications"
            value={metrics.totalVerifications.toLocaleString()}
            sub={prototype ? undefined : "since the gateway started"}
            mono
          />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell
            label="Average Score"
            value={metrics.totalVerifications > 0 ? metrics.averageScore.toFixed(3) : "—"}
            mono
          />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell
            label="Active Oracles"
            value={`${metrics.activeOracles} / ${oracles.length}`}
            mono
          />
        </GlassPanel>
      </div>

      {/* Oracle Status Cards */}
      {oracles.length === 0 ? (
        <GlassPanel padding="md">
          <EmptyState title="No oracles reported" description="The gateway's oracle cascade listed no oracles." />
        </GlassPanel>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {oracles.map((oracle) => (
            <GlassPanel
              key={oracle.name}
              padding="md"
              glow={oracle.available ? (oracle.isPrimary ? "green" : "none") : "none"}
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-white/60 uppercase tracking-wider">
                    {oracle.isPrimary ? "Primary" : "Fallback"}
                  </span>
                  <StatusChip
                    status={oracle.available ? "online" : "offline"}
                    label={oracle.available ? "Active" : prototype && oracle.name === "eigenlayer" ? "Stub" : "Unavailable"}
                  />
                </div>
                <div>
                  <p className="text-sm font-medium text-white/90">{oracleLabel(oracle.name)}</p>
                  <p className="text-xs text-white/40 font-mono mt-0.5">{oracle.name}</p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-[10px] text-white/40 uppercase tracking-wide">Verifications</p>
                    <p className="text-sm font-mono text-white/70">{oracle.totalVerifications.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-white/40 uppercase tracking-wide">Avg Score</p>
                    <p className="text-sm font-mono text-white/70">
                      {oracle.totalVerifications > 0 ? oracle.averageScore.toFixed(3) : "—"}
                    </p>
                  </div>
                </div>
                {prototype && oracle.name === "uma" && (
                  <p className="text-[10px] text-white/30">2hr liveness · 500 USDC bond · Base Sepolia</p>
                )}
                {prototype && oracle.name === "chainlink" && (
                  <p className="text-[10px] text-white/30">DON: fun-base-sepolia-1 · mock mode</p>
                )}
                {prototype && oracle.name === "eigenlayer" && (
                  <p className="text-[10px] text-white/30">AVS not yet deployed · future integration</p>
                )}
              </div>
            </GlassPanel>
          ))}
        </div>
      )}

      {/* Recent Verification Results */}
      <GlassPanel padding="md">
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">
          Recent Verification Results
        </h3>
        {results.length === 0 ? (
          <EmptyState
            title="No verifications yet"
            description="No evidence has been submitted to the oracle cascade since the gateway started."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-white/40 border-b border-white/[0.06]">
                  <th className="text-left py-2 px-3 font-medium">Time</th>
                  <th className="text-left py-2 px-3 font-medium">Oracle</th>
                  <th className="text-left py-2 px-3 font-medium">Result</th>
                  <th className="text-right py-2 px-3 font-medium">Score</th>
                </tr>
              </thead>
              <tbody>
                {results.map((result, idx) => (
                  <tr
                    key={idx}
                    className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="py-2.5 px-3 font-mono text-white/40 text-xs">
                      {formatTimeAgo(result.timestamp)}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-emerald-400/80 text-xs">
                      {oracleLabel(result.oracle)}
                    </td>
                    <td className="py-2.5 px-3">
                      <StatusChip
                        status={result.passed ? "online" : "offline"}
                        label={result.passed ? "PASS" : "FAIL"}
                      />
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <span
                        className={`font-mono font-medium text-sm ${
                          result.score >= 0.8
                            ? "text-emerald-400"
                            : result.score >= 0.6
                              ? "text-yellow-400"
                              : "text-red-400/70"
                        }`}
                      >
                        {result.score.toFixed(3)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassPanel>
    </div>
  );
}
