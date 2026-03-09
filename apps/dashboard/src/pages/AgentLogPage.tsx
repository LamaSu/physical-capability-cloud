import React from "react";
import { GlassPanel, GlowBadge, MessageBubble, AgentAvatar } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";

interface MockConversation {
  id: string;
  topic: string;
  participants: string[];
  messages: Array<{
    from: string;
    role: "user" | "broker" | "kernel";
    intent: string;
    content: string;
    timestamp: string;
  }>;
}

const mockConversations: MockConversation[] = [
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

export function AgentLogPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [selectedConv, setSelectedConv] = React.useState<string>("conv-001");

  React.useEffect(() => { setPageMeta("Agent Log", "Agent-to-agent conversations and intent flow"); }, [setPageMeta]);

  const conversation = mockConversations.find((c) => c.id === selectedConv);

  return (
    <div className="flex gap-4 h-[calc(100vh-160px)]">
      {/* Conversation list */}
      <div className="w-72 space-y-2 flex-shrink-0 overflow-y-auto">
        {mockConversations.map((conv) => (
          <GlassPanel
            key={conv.id}
            hover
            padding="md"
            glow={conv.id === selectedConv ? "green" : "none"}
            onClick={() => setSelectedConv(conv.id)}
          >
            <div className="text-sm font-medium text-white/70">{conv.topic}</div>
            <div className="flex items-center gap-2 mt-1.5">
              {conv.participants.map((p) => (
                <AgentAvatar
                  key={p}
                  role={p.toLowerCase() as "user" | "broker" | "kernel"}
                  size="sm"
                />
              ))}
              <span className="text-[10px] text-white/20 font-mono ml-auto">{conv.messages.length} msgs</span>
            </div>
          </GlassPanel>
        ))}
      </div>

      {/* Message thread */}
      <GlassPanel padding="lg" className="flex-1 overflow-y-auto">
        {conversation ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 pb-3 border-b border-white/[0.06]">
              <h3 className="text-sm font-semibold text-white/70">{conversation.topic}</h3>
              <GlowBadge color="green">{conversation.messages.length} messages</GlowBadge>
            </div>
            {conversation.messages.map((msg, i) => (
              <MessageBubble key={i} {...msg} />
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-white/30 text-sm">
            Select a conversation
          </div>
        )}
      </GlassPanel>
    </div>
  );
}
