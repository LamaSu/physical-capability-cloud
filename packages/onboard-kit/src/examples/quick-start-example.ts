/**
 * Quick Start Example — Get a device on the PCC network in ~20 lines
 *
 * Run with: npx tsx src/examples/quick-start-example.ts
 */

import { quickStart } from "../quick-start.js";
import { UserAgent } from "@pcc/agent-user";
import { BrokerAgent } from "@pcc/agent-broker";

async function main() {
  console.log("=== PCC Quick Start Example ===\n");

  // 1. Start your kernel (mock mode — no real hardware needed)
  const { kernelAgent, bus, capability, stop } = await quickStart({
    kernelId: "kernel_demo_001",
    name: "Demo Workshop",
    location: { lat: 37.77, lng: -122.41 },
    capability: {
      type: "fdm",
      name: "Demo 3D Printer",
      materials: ["pla", "petg", "abs"],
      assuranceTiers: [0, 1],
      pricing: { baseCost: "5.00", perMinute: "0.10", minimum: "10.00" },
    },
  });

  console.log(`Kernel agent started: ${kernelAgent.id}`);
  console.log(`  Capability: ${capability.type} — ${capability.name}`);
  console.log(`  Materials: ${capability.materials.join(", ")}`);
  console.log();

  // 2. Create a broker (normally already running on the network)
  const broker = new BrokerAgent(bus);
  broker.start();
  broker.registerKernelCapabilities(kernelAgent.id, {
    kernelId: "kernel_demo_001",
    capabilities: [capability],
    reputation: 500,
  });
  console.log("Broker started and kernel registered\n");

  // 3. Create a user agent to test discovery
  const user = new UserAgent(bus, {});
  user.start();

  const notifications: Array<{ type: string; summary: string }> = [];
  user.onNotification((n: any) => notifications.push(n));

  // 4. Discover your capability
  console.log("User agent discovering capabilities...");
  await user.discoverCapabilities({ capabilityType: "fdm" });
  await new Promise(r => setTimeout(r, 500));

  const discoveryNotif = notifications.find(n => n.type === "capabilities_found");
  if (discoveryNotif) {
    console.log(`  Found: ${discoveryNotif.summary}`);
  }

  // 5. Request a quote
  console.log("\nRequesting quote...");
  await user.requestQuote({
    capabilityType: "fdm",
    params: { material: "pla" },
    assuranceTier: 1,
  });
  await new Promise(r => setTimeout(r, 500));

  const quoteNotif = notifications.find(n => n.type === "quote_received");
  if (quoteNotif) {
    console.log(`  Quote: ${quoteNotif.summary}`);
  }

  console.log("\n=== Your equipment is live on the PCC network! ===");
  console.log("Users can now discover, quote, and submit jobs to your machines.\n");

  // Cleanup
  user.stop();
  broker.stop();
  stop();
}

main().catch(console.error);
