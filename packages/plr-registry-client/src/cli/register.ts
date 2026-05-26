#!/usr/bin/env node
/**
 * pcc-plr-register — register a PLR backend on-chain.
 *
 * Usage:
 *   pcc-plr-register \
 *     --module pylabrobot.liquid_handling.backends.opentrons.OT2 \
 *     --token-id 142 \
 *     --schedule-hash 0xab...cd \
 *     --manifest /path/to/manifest.json \
 *     [--manifest-cid 0x...]            # if pre-computed; else derived from manifest
 *     [--delegated-agent 0x<addr>]
 *
 * The manifest file is signed off-chain BEFORE running this command (use
 * the dashboard onboarding flow or signBackendManifest() from
 * @pcc/plr-registry-client). This CLI assumes:
 *   - The wallet identified by DEPLOYER_PRIVATE_KEY owns the
 *     ContributorNFT identified by --token-id (the contract checks this).
 *   - The schedule identified by --schedule-hash is already published.
 *
 * Required env:
 *   PLR_BACKEND_REGISTRY_ADDRESS
 *   DEPLOYER_PRIVATE_KEY
 *
 * Forward-compat note: --delegated-agent currently accepts an EVM
 * address (Phase 1). Phase 2 (Q3 2026) will accept an ERC-8004 tokenId
 * in the same field shape.
 */

import { readFile } from "node:fs/promises";

import {
  manifestCid as computeManifestCid,
  addressToDelegatedAgentBytes32,
} from "@pcc/spec";
import {
  loadEnv,
  makeWritableClient,
  parseFlags,
  requireFlag,
} from "./common.js";

const ZERO_BYTES32 = "0x" + "0".repeat(64);

async function main() {
  const env = loadEnv();
  const flags = parseFlags(process.argv.slice(2));
  const modulePath = requireFlag(flags, "module");
  const tokenIdRaw = requireFlag(flags, "token-id");
  const scheduleHash = requireFlag(flags, "schedule-hash") as `0x${string}`;
  const manifestPath = requireFlag(flags, "manifest");

  // Token id parse — registry uses uint256, so we go through BigInt.
  let contributorTokenId: bigint;
  try {
    contributorTokenId = BigInt(tokenIdRaw);
  } catch {
    throw new Error(`--token-id must be a uint256; got ${tokenIdRaw}`);
  }

  // Either accept a pre-computed --manifest-cid or derive from the
  // manifest file's canonical bytes (Phase 1 sha256 placeholder).
  let manifestCidValue: `0x${string}`;
  if (typeof flags["manifest-cid"] === "string") {
    manifestCidValue = flags["manifest-cid"] as `0x${string}`;
  } else {
    const buf = await readFile(manifestPath, "utf-8");
    const payload = JSON.parse(buf);
    manifestCidValue = await computeManifestCid(payload);
  }

  const delegatedAgentFlag = flags["delegated-agent"];
  let delegatedAgentId: `0x${string}` = ZERO_BYTES32 as `0x${string}`;
  if (typeof delegatedAgentFlag === "string" && delegatedAgentFlag.length > 0) {
    if (delegatedAgentFlag.length === 42) {
      // EVM address — Phase 1 encoding
      delegatedAgentId = addressToDelegatedAgentBytes32(
        delegatedAgentFlag as `0x${string}`,
      );
    } else if (delegatedAgentFlag.length === 66) {
      // Already bytes32
      delegatedAgentId = delegatedAgentFlag as `0x${string}`;
    } else {
      throw new Error(
        `--delegated-agent must be an EVM address or bytes32; got ${delegatedAgentFlag}`,
      );
    }
  }

  const { client, address } = makeWritableClient(env);

  console.log(`Registering ${modulePath} as ${address}...`);
  console.log(`  contributorTokenId: ${contributorTokenId.toString()}`);
  console.log(`  scheduleHash:       ${scheduleHash}`);
  console.log(`  manifestCid:        ${manifestCidValue}`);
  console.log(`  delegatedAgentId:   ${delegatedAgentId}`);

  const txHash = await client.register({
    modulePath,
    contributorTokenId,
    scheduleHash,
    delegatedAgentId,
    manifestCid: manifestCidValue,
    account: address,
  });
  console.log(`tx: ${txHash}`);
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
