import React from "react";
import { GlassPanel, GlowBadge, MessageBubble, AgentAvatar } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { NotLiveState, DemoBanner } from "../components/DemoState.js";
import { isDemoMode } from "../lib/demo-mode.js";
import { DEMO_CONVERSATIONS } from "../demo/AgentLogPage.fixtures.js";

/**
 * Agent Log.
 *
 * Not live: no gateway route lists the network's agent-to-agent
 * conversations. GET /api/agents/conversations (and /:convId) answers from a
 * literal array in packages/gateway/src/routes/agents.ts and is being retired
 * (#2527). GET /api/agents/live/conversations covers only the gateway's own
 * in-process agents, whose kernel agent runs simulated devices. The A2A relay
 * keeps one connected agent's conversations in memory and cannot list them
 * all. The prototype showed three invented conversations as if they were
 * network traffic.
 *
 * Outside demo mode the page says what is missing and makes no request. In
 * demo mode (lib/demo-mode.ts) the prototype renders its sample conversations
 * under a DemoBanner.
 */

const NOT_LIVE_DETAIL =
  "No gateway route lists the network's agent conversations. GET /api/agents/conversations " +
  "returns a fixed sample list, and /api/agents/live/conversations covers only the gateway's " +
  "own in-process agents, whose kernel runs simulated devices.";

export function AgentLogPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  React.useEffect(() => { setPageMeta("Agent Log", "Agent-to-agent conversations and intent flow"); }, [setPageMeta]);

  // Sample conversations render only when the viewer asked for a demo (lib/demo-mode.ts).
  if (isDemoMode()) return <AgentLogDemo />;

  return (
    <GlassPanel padding="lg">
      <NotLiveState what="The agent log" detail={NOT_LIVE_DETAIL} hasDemo />
    </GlassPanel>
  );
}

// ── Demo: the prototype with sample conversations, under a DemoBanner ─────

function AgentLogDemo() {
  const [selectedConv, setSelectedConv] = React.useState<string>(DEMO_CONVERSATIONS[0]?.id ?? "");

  const conversation = DEMO_CONVERSATIONS.find((c) => c.id === selectedConv);

  return (
    <div className="space-y-4">
      <DemoBanner what="Agent log" />
      <div className="flex gap-4 h-[calc(100vh-208px)]">
        {/* Conversation list */}
        <div className="w-72 space-y-2 flex-shrink-0 overflow-y-auto">
          {DEMO_CONVERSATIONS.map((conv) => (
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
    </div>
  );
}
