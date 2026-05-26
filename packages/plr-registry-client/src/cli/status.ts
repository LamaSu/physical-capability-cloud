#!/usr/bin/env node
/**
 * pcc-plr-status — print the current registry record for a PLR module.
 *
 * Usage:
 *   pcc-plr-status --module pylabrobot.liquid_handling.backends.opentrons.OT2
 *
 * Required env: PLR_BACKEND_REGISTRY_ADDRESS
 * Optional env: PLR_BACKEND_REGISTRY_CHAIN (default "base"),
 *               PLR_BACKEND_REGISTRY_RPC_URL.
 *
 * Phase 1 scope: prints the on-chain record + resolves the author via
 * ContributorNFT.ownerOf. Earnings-to-date via event scan is deferred to
 * Phase 2 (requires subgraph or eth_getLogs walk).
 */

import { loadEnv, makeReadOnlyClient, parseFlags, requireFlag } from "./common.js";

async function main() {
  const env = loadEnv();
  const flags = parseFlags(process.argv.slice(2));
  const modulePath = requireFlag(flags, "module");

  const client = makeReadOnlyClient(env);

  const record = await client.getRecord(modulePath);
  if (!record) {
    console.log(`No registration found for ${modulePath}`);
    process.exit(2);
  }

  let authorAddress: string;
  try {
    authorAddress = await client.authorOf(modulePath);
  } catch {
    authorAddress = "(unable to resolve — NFT may be burned)";
  }

  const enabled = await client.isEnabled(modulePath);
  const total = await client.totalBackends();

  // Pretty-print.
  console.log(`# PLR Backend: ${modulePath}`);
  console.log(`  status            ${enabled ? "ENABLED" : "DISABLED"}`);
  console.log(`  author            ${authorAddress}`);
  console.log(`  contributorTokenId ${record.contributorTokenId}`);
  console.log(`  scheduleHash      ${record.scheduleHash}`);
  console.log(`  manifestCid       ${record.manifestCid}`);
  console.log(`  delegatedAgentId  ${record.delegatedAgentId}`);
  console.log(`  registeredAt      ${new Date(record.registeredAt * 1000).toISOString()}`);
  console.log(
    `  lastEnabledChange ${new Date(record.lastEnabledChange * 1000).toISOString()}`,
  );
  console.log(`# Registry total: ${total} backends`);
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
