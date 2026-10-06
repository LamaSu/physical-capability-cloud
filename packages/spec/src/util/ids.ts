/**
 * ID generation utilities.
 * Prefixed IDs for readability: cwm_xxx, step_xxx, kernel_xxx, etc.
 */

import { uncurryThis } from "./primordials.js";

// Captured when this module loads (steward DECISIONS 04:06): the kernel's evidence emitter calls
// ids.evidence and ids.bundle, so a Date, Math or toString replaced after load is never consulted.
const DateNow = Date.now;
const MathRandom = Math.random;
const NumberPrototypeToString = uncurryThis(Number.prototype.toString) as (n: number, radix?: number) => string;
const StringPrototypeSubstring = uncurryThis(String.prototype.substring) as (s: string, start: number, end?: number) => string;

export function generateId(prefix: string): string {
  const timestamp = NumberPrototypeToString(DateNow(), 36);
  const random = StringPrototypeSubstring(NumberPrototypeToString(MathRandom(), 36), 2, 10);
  return `${prefix}_${timestamp}${random}`;
}

export const ids = {
  cwm: () => generateId("cwm"),
  step: () => generateId("step"),
  kernel: () => generateId("kernel"),
  capability: () => generateId("cap"),
  job: () => generateId("job"),
  evidence: () => generateId("ev"),
  bundle: () => generateId("bun"),
  escrow: () => generateId("esc"),
  dispute: () => generateId("dis"),
  verifier: () => generateId("ver"),
  verification: () => generateId("vreq"),
  attestation: () => generateId("att"),
  custody: () => generateId("cust"),
  slot: () => generateId("slot"),
  device: () => generateId("dev"),
  sensor: () => generateId("sens"),
  reading: () => generateId("rdg"),
  channel: () => generateId("ch"),
  aggregate: () => generateId("agg"),
  anomaly: () => generateId("anom"),
  batch: () => generateId("batch"),
  sample: () => generateId("samp"),
  processLog: () => generateId("plog"),
  stream: () => generateId("strm"),
  commitment: () => generateId("cmt"),
  proof: () => generateId("proof"),
  capsule: () => generateId("cap"),
  grant: () => generateId("grt"),
  shipment: () => generateId("shp"),
  booking: () => generateId("book"),
  installation: () => generateId("inst"),
  provider: () => generateId("prov"),
  quote: () => generateId("quot"),
  trackingEvent: () => generateId("trk"),
  installStep: () => generateId("istep"),
  installNote: () => generateId("inote"),
  timelineEvent: () => generateId("tle"),
  transferNode: () => generateId("tnode"),
  transferEdge: () => generateId("tedge"),
  transferGraph: () => generateId("tgraph"),
  sampleMovement: () => generateId("smov"),
  instrumentWorkflow: () => generateId("iwf"),
  resourceClaim: () => generateId("rclaim"),
  orchestratorEvent: () => generateId("oevt"),
  protocolTemplate: () => generateId("ptpl"),
  protocolStep: () => generateId("pstep"),
  protocolTransfer: () => generateId("ptxfr"),
  protocolFork: () => generateId("pfork"),
  protocolRun: () => generateId("prun"),
  protocolRunStep: () => generateId("prstep"),
  protocolRunTransfer: () => generateId("prtxfr"),
  protocolEvent: () => generateId("pevt"),
  transferAgent: () => generateId("tagent"),
  automationStatus: () => generateId("astat"),
  capabilityCertificate: () => generateId("cnft"),
  epoch: () => generateId("epoch"),
  rewardClaim: () => generateId("claim"),
  fundingProposal: () => generateId("fund"),
} as const;
