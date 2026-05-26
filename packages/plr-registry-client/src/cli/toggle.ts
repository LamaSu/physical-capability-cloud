#!/usr/bin/env node
/**
 * pcc-plr-toggle — flip the kill-switch for a registered PLR backend.
 *
 * Usage:
 *   pcc-plr-toggle --module pylabrobot.liquid_handling.backends.opentrons.OT2 --enable
 *   pcc-plr-toggle --module pylabrobot.liquid_handling.backends.opentrons.OT2 --disable
 *
 * Required env:
 *   PLR_BACKEND_REGISTRY_ADDRESS — deployed contract address
 *   DEPLOYER_PRIVATE_KEY         — wallet that owns the BACKEND_AUTHOR
 *                                  NFT or is the delegated agent
 *
 * Forward-only semantics per validated answer Q7: setEnabled(false) blocks
 * NEW assertEnabled() calls; in-flight escrow continues to settlement.
 */

import { loadEnv, makeWritableClient, parseFlags, requireFlag } from "./common.js";

async function main() {
  const env = loadEnv();
  const flags = parseFlags(process.argv.slice(2));
  const modulePath = requireFlag(flags, "module");
  const enable = !!flags.enable;
  const disable = !!flags.disable;

  if (enable === disable) {
    throw new Error("exactly one of --enable / --disable required");
  }

  const { client, address } = makeWritableClient(env);

  // Confirm we have a record first so the user gets a useful error before
  // burning gas.
  const record = await client.getRecord(modulePath);
  if (!record) {
    throw new Error(`${modulePath} is not registered`);
  }
  if (record.enabled === enable) {
    console.log(
      `${modulePath} is already ${enable ? "enabled" : "disabled"}; no-op`,
    );
    return;
  }

  console.log(`Signing as ${address}...`);
  const txHash = await client.setEnabled({
    modulePath,
    enabled: enable,
    account: address,
  });
  console.log(`tx: ${txHash}`);
  console.log(`status: ${enable ? "ENABLED" : "DISABLED"}`);
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
