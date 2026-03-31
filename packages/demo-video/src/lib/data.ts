/**
 * Video data — all numbers from CLAUDE.md ground truth
 * HARD RULE: These must match SUBMISSION_SUMMARY.md exactly
 */
export const METRICS = {
  packages: 25,
  tests: 3300,
  endpoints: 347,
  agentTools: 154,
  mcpTools: 49,
  a2aIntents: 34,
  routes: 54,
  sseStreams: 6,
} as const;

export const SIX_PHASES = [
  { name: "DISCOVER", color: "#00d4ff", desc: "Agents find capabilities" },
  { name: "BID",      color: "#ffaa00", desc: "Operators compete on price" },
  { name: "ESCROW",   color: "#ff0066", desc: "Funds lock per milestone" },
  { name: "EXECUTE",  color: "#00ff88", desc: "Physical work runs" },
  { name: "VERIFY",   color: "#00ff88", desc: "Evidence scored on-chain" },
  { name: "SETTLE",   color: "#ffaa00", desc: "Funds release automatically" },
] as const;

export const SPONSORS = [
  { name: "Storacha",     status: "LIVE — UCAN evidence uploads",     real: true },
  { name: "Flow EVM",     status: "LIVE — MilestoneEscrow deployed",  real: true },
  { name: "NEAR",         status: "LIVE — 1Click cross-chain solver", real: true },
  { name: "Lit Protocol", status: "Chipotle v3 encryption wired",     real: true },
  { name: "Starknet",     status: "ZK proof anchoring architecture",  real: false },
] as const;

export const A2A_FLOW = [
  { from: "USER AGENT",   to: "BROKER",       intent: "CAPABILITY_QUERY",  color: "#00d4ff" },
  { from: "BROKER",       to: "KERNEL",       intent: "JOB_OFFER",         color: "#ffaa00" },
  { from: "KERNEL",       to: "BROKER",       intent: "JOB_ACCEPTED",      color: "#00ff88" },
  { from: "BROKER",       to: "USER AGENT",   intent: "JOB_CONFIRMED",     color: "#00ff88" },
  { from: "KERNEL",       to: "GATEWAY",      intent: "EVIDENCE_SUBMITTED", color: "#00ff88" },
  { from: "GATEWAY",      to: "ESCROW",       intent: "MILESTONE_COMPLETE", color: "#ffaa00" },
] as const;

export const SETTLEMENT_MATH = {
  jobValue: 500,
  protocolFee: 7.50,
  operatorReceives: 492.50,
  xitomeryOperatorReceives: 325,
  xitomeryFee: "30-35%",
  pccFee: "1.5%",
} as const;
