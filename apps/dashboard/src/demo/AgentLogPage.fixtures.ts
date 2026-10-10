/**
 * AgentLogPage demo fixtures: sample conversations, not live PCC traffic.
 *
 * Rendered only in demo mode (lib/demo-mode.ts), under a DemoBanner. No
 * gateway route lists the network's agent-to-agent conversations:
 *   - GET /api/agents/conversations and /api/agents/conversations/:convId
 *     answer from a literal array (packages/gateway/src/routes/agents.ts);
 *     the shell lane is retiring that route (#2527);
 *   - GET /api/agents/live/conversations lists only the conversations of the
 *     gateway's own in-process agents (packages/gateway/src/agent-bridge.ts),
 *     whose kernel agent is built without device adapters and so runs the
 *     simulated FDM printer, power monitor and camera;
 *   - the A2A relay (GET /api/a2a/conversations/:agentId) keeps one connected
 *     agent's conversations in memory and has no route that lists them all.
 * pages/AgentLogPage.tsx says this on screen when demo mode is off.
 */

export interface DemoConversationMessage {
  from: string;
  role: "user" | "broker" | "kernel";
  intent: string;
  content: string;
  timestamp: string;
}

export interface DemoConversation {
  id: string;
  topic: string;
  participants: Array<"User" | "Broker" | "Kernel">;
  messages: DemoConversationMessage[];
}

export const DEMO_CONVERSATIONS: DemoConversation[] = [
  {
    id: "conv-001",
    topic: "FDM Capability Discovery + Quote",
    participants: ["User", "Broker", "Kernel"],
    messages: [
      { from: "User", role: "user", intent: "DiscoverCapabilities", content: "What FDM printers support PLA?", timestamp: "14:32:01" },
      { from: "Broker", role: "broker", intent: "CapabilitiesResponse", content: "Found 2 FDM capabilities matching PLA: Prusa MK4 at NYC MakerSpace (queue: 1, $12 base) and Ender 3 at LA Fab Lab (offline).", timestamp: "14:32:02" },
      { from: "User", role: "user", intent: "RequestQuote", content: "Quote for FDM print in PLA, 40% infill, 0.20mm layer height, tree supports, 1 unit.", timestamp: "14:32:15" },
      { from: "Broker", role: "broker", intent: "RequestQuote", content: "Forwarding quote request to kernel-nyc for Prusa MK4 FDM capability.", timestamp: "14:32:16" },
      { from: "Kernel", role: "kernel", intent: "QuoteResponse", content: "Quote: $45.00 USDC. Estimated time: 3h. Queue depth: 1. Operator bond: $2.25 (Tier 1, 5%).", timestamp: "14:32:17" },
      { from: "Broker", role: "broker", intent: "QuoteResponse", content: "Best quote: $45.00 USDC from NYC MakerSpace Prusa MK4. Score: 87/100 (30% price + 30% queue + 30% reputation + 10% location).", timestamp: "14:32:17" },
    ],
  },
  {
    id: "conv-002",
    topic: "Workflow Submission + Escrow",
    participants: ["User", "Broker"],
    messages: [
      { from: "User", role: "user", intent: "SubmitWorkflow", content: "Submitting CWM with 2 steps: FDM print (gear housing) + laser cut (panel). Settlement: $63.50 USDC, escrow payer 0x1234...5678.", timestamp: "14:35:01" },
      { from: "Broker", role: "broker", intent: "WorkflowAccepted", content: "Workflow compiled. Execution plan: step-1 → kernel-nyc (FDM, $45.00), step-3 → kernel-nyc (laser, $18.50). Total: $63.50. Escrow contract deployed at 0xEscrow...1111.", timestamp: "14:35:03" },
      { from: "User", role: "user", intent: "PaymentConfirmation", content: "Escrow funded with $63.50 USDC + bonds. Transaction confirmed.", timestamp: "14:35:10" },
      { from: "Broker", role: "broker", intent: "TextMessage", content: "Jobs dispatched to NYC MakerSpace. FDM job starting immediately, laser cut queued for after FDM completion.", timestamp: "14:35:12" },
    ],
  },
  {
    id: "conv-003",
    topic: "Job Completion + Evidence",
    participants: ["Broker", "Kernel"],
    messages: [
      { from: "Kernel", role: "kernel", intent: "JobCompleted", content: "Job job-004 (FDM Print — Enclosure Base) completed. Evidence bundle: 6 events, bundle hash sha256:abc...def. Tier 1 requirements met.", timestamp: "14:40:01" },
      { from: "Broker", role: "broker", intent: "TextMessage", content: "Evidence verified. Challenge window opened: 4 hours (Tier 1). Milestone releasing $32.00 to operator.", timestamp: "14:40:03" },
    ],
  },
];
