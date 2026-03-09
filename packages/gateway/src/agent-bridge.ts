/**
 * Agent Bridge — connects gateway HTTP routes to the live agent swarm.
 *
 * Provides a lazy-initialized agent constellation (UserAgent, BrokerAgent,
 * KernelAgent) that persists for the gateway's lifetime. Routes call
 * bridge methods instead of using hardcoded mock data.
 *
 * The bridge gracefully falls back to mock data when agents aren't
 * initialized (e.g., missing env config).
 */

import { MessageBus } from "@pcc/a2a";
import type { A2AMessage, Conversation, AgentCard } from "@pcc/a2a";
import { UserAgent } from "@pcc/agent-user";
import { BrokerAgent } from "@pcc/agent-broker";
import { KernelAgent } from "@pcc/agent-kernel";
import type { Capability } from "@pcc/spec";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _initialized = false;
let _bus: MessageBus | null = null;
let _userAgent: UserAgent | null = null;
let _brokerAgent: BrokerAgent | null = null;
let _kernelAgent: KernelAgent | null = null;

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

/**
 * Initialize the agent swarm. Call once at gateway startup.
 * Idempotent — multiple calls are safe.
 */
export async function initAgentBridge(): Promise<void> {
  if (_initialized) return;

  try {
    _bus = new MessageBus();

    _userAgent = new UserAgent(_bus);

    _brokerAgent = new BrokerAgent(_bus);

    const defaultCap: Capability = {
      id: "cap_fdm_gateway",
      kernelId: "kernel-gateway",
      type: "fdm",
      name: "FDM Printing — Prusa MK4",
      description: "Fused deposition modeling on Prusa MK4",
      materials: ["pla", "petg"],
      assuranceTiers: [0, 1],
      pricing: { currency: "USDC", baseCost: "2.00", perMinute: "0.05", perGram: "0.03", minimum: "5.00" },
      availability: { timezone: "America/New_York", windows: {} },
      location: { lat: 40.6892, lng: -73.9857 },
      queueDepth: 0,
    };

    _kernelAgent = new KernelAgent(_bus, {
      kernelId: "kernel-gateway",
      name: "Gateway Kernel (Brooklyn)",
      location: { lat: 40.6892, lng: -73.9857 },
      capabilities: [defaultCap],
      mockPrintDuration: 5000,
    });

    _initialized = true;
    console.log("[agent-bridge] Agent swarm initialized: user, broker, kernel");
  } catch (err) {
    console.warn("[agent-bridge] Failed to initialize agents, using mock fallbacks:", err);
  }
}

/**
 * Check if agents are live.
 */
export function isAgentBridgeReady(): boolean {
  return _initialized && _bus !== null;
}

// ---------------------------------------------------------------------------
// Agent access
// ---------------------------------------------------------------------------

export function getUserAgent(): UserAgent | null {
  return _userAgent;
}

export function getBrokerAgent(): BrokerAgent | null {
  return _brokerAgent;
}

export function getKernelAgent(): KernelAgent | null {
  return _kernelAgent;
}

export function getMessageBus(): MessageBus | null {
  return _bus;
}

// ---------------------------------------------------------------------------
// High-level bridge methods
// ---------------------------------------------------------------------------

/**
 * Get all conversations from the message bus.
 */
export function getConversations(): Conversation[] {
  if (!_bus) return [];
  const seen = new Set<string>();
  const result: Conversation[] = [];

  for (const card of getAgentCards()) {
    for (const conv of _bus.getConversationsFor(card.id)) {
      if (!seen.has(conv.id)) {
        seen.add(conv.id);
        result.push(conv);
      }
    }
  }
  return result;
}

/**
 * Get recent messages from all conversations.
 */
export function getRecentMessages(limit = 50): A2AMessage[] {
  const conversations = getConversations();
  const allMessages: A2AMessage[] = [];
  for (const conv of conversations) {
    allMessages.push(...conv.messages);
  }
  allMessages.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return allMessages.slice(0, limit);
}

/**
 * Get agent cards for all registered agents.
 */
export function getAgentCards(): AgentCard[] {
  const cards: AgentCard[] = [];
  if (_userAgent) cards.push(_userAgent.card);
  if (_brokerAgent) cards.push(_brokerAgent.card);
  if (_kernelAgent) cards.push(_kernelAgent.card);
  return cards;
}

/**
 * Get agent status summary.
 */
export function getAgentStatus(): {
  initialized: boolean;
  agents: Array<{ id: string; name: string; role: string; address: string }>;
  conversationCount: number;
  messageCount: number;
} {
  return {
    initialized: _initialized,
    agents: getAgentCards().map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      address: c.walletAddress,
    })),
    conversationCount: getConversations().length,
    messageCount: getRecentMessages(1000).length,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export async function shutdownAgentBridge(): Promise<void> {
  // Agents don't have explicit stop methods — just null out references
  _kernelAgent = null;
  _brokerAgent = null;
  _userAgent = null;
  _bus = null;
  _initialized = false;
}
