/**
 * Run a PCCP agent as a standalone process connected to the gateway relay.
 *
 * Usage:
 *   npx tsx scripts/run-agent.ts --role user --relay http://localhost:3200
 *   npx tsx scripts/run-agent.ts --role broker --relay http://localhost:3200
 *   npx tsx scripts/run-agent.ts --role kernel --id kernel_lab_sf --relay http://localhost:3200
 */

import { NetworkedBus } from "../packages/a2a/src/networked-bus.js";
import { UserAgent } from "../packages/agent-user/src/user-agent.js";
import { BrokerAgent } from "../packages/agent-broker/src/broker-agent.js";
import { KernelAgent } from "../packages/agent-kernel/src/kernel-agent.js";
import { AgentWallet } from "../packages/agent-runtime/src/wallet.js";

const args = process.argv.slice(2);
const roleIdx = args.indexOf("--role");
const relayIdx = args.indexOf("--relay");
const idIdx = args.indexOf("--id");

const role = roleIdx >= 0 ? args[roleIdx + 1] : "user";
const relayUrl = relayIdx >= 0 ? args[relayIdx + 1] : "http://localhost:3200";
const agentId = idIdx >= 0 ? args[idIdx + 1] : `${role}_agent_${Date.now().toString(36)}`;

console.log(`═══════════════════════════════════════════════════`);
console.log(`  PCCP Agent Runner`);
console.log(`═══════════════════════════════════════════════════`);
console.log(`  Role:    ${role}`);
console.log(`  ID:      ${agentId}`);
console.log(`  Relay:   ${relayUrl}`);
console.log(`  PID:     ${process.pid}`);
console.log(`═══════════════════════════════════════════════════`);
console.log();

const bus = new NetworkedBus({ relayUrl });

// Create wallet for the agent
const wallet = new AgentWallet();

let agent: UserAgent | BrokerAgent | KernelAgent;

switch (role) {
  case "user":
    agent = new UserAgent({
      id: agentId,
      name: "PCCP UserAgent",
      wallet,
      bus: bus as any,
    });
    break;

  case "broker":
    agent = new BrokerAgent({
      id: agentId,
      name: "PCCP BrokerAgent",
      wallet,
      bus: bus as any,
    });
    break;

  case "kernel":
    agent = new KernelAgent({
      id: agentId,
      name: `PCCP KernelAgent (${agentId})`,
      wallet,
      bus: bus as any,
      kernelId: agentId,
    });
    break;

  default:
    console.error(`Unknown role: ${role}. Use: user, broker, kernel`);
    process.exit(1);
}

console.log(`[${role}] Agent online. Listening for messages...`);
console.log(`[${role}] Press Ctrl+C to stop.`);
console.log();

// Keep process alive
process.on("SIGINT", () => {
  console.log(`\n[${role}] Shutting down...`);
  bus.disconnectAll?.();
  process.exit(0);
});

// Heartbeat
setInterval(() => {
  const connected = bus.connected ?? false;
  console.log(`[${role}] heartbeat | relay: ${connected ? "connected" : "disconnected"} | ${new Date().toISOString()}`);
}, 30_000);
