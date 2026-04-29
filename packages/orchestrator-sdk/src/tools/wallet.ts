// viem-only wallet creation; CDP API integration deferred to Wave 3
// (gasless UX upgrade if needed). agentic.market replaced by
// pcc-discovery (charlie 1.3).
//
// This module previously gated behind CDP_API_KEY_ID / CDP_API_KEY_SECRET
// for an unimplemented faucet path. The wallet itself is created locally
// via viem's `generatePrivateKey` + `privateKeyToAccount` — no CDP key is
// needed for that. The `listOnAgenticMarket` POST surface was removed in
// Wave 1.4; PCC's native discovery (pcc-discovery.ts) is the registry now.
//
// Renamed from `cdp-x402.ts` to `wallet.ts` in Wave 2.1 since CDP gating is
// gone. Ported from `LamaSu/navi` packages/backend/src/tools/cdp-x402.ts.

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { emit } from "../core/event-bus.js";

const MOCK = process.env.MOCK_CDP !== "false";

/**
 * Mint a fresh Ethereum wallet on Base Sepolia for an operator.
 * Uses viem to generate a key + derive the address. No CDP credentials
 * required — wallet creation is purely local key generation.
 */
export async function createAgentWallet(input: {
  enterprise_id: string;
}): Promise<{ address: string; chain: string; funded: boolean; private_key_redacted: string }> {
  emit({
    kind: "wallet.start",
    sponsor: "viem",
    level: "info",
    session_id: input.enterprise_id,
    text: `createWallet on base-sepolia (viem-only, no CDP)`,
  });

  if (MOCK) {
    const r = {
      address: `0xmock${input.enterprise_id.slice(0, 6)}`,
      chain: "base-sepolia",
      funded: true,
      private_key_redacted: "0x***",
    };
    emit({
      kind: "wallet.mock",
      sponsor: "viem",
      level: "warn",
      session_id: input.enterprise_id,
      text: `MOCK_CDP=true · ${r.address}`,
      payload: r,
    });
    return r;
  }

  // Real wallet generation via viem — purely local, no network call.
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  emit({
    kind: "wallet.created",
    sponsor: "viem",
    level: "ok",
    session_id: input.enterprise_id,
    text: `wallet ${account.address} created on base-sepolia (chain id 84532)`,
    payload: { address: account.address, chain: "base-sepolia", chain_id: 84532 },
  });

  return {
    address: account.address,
    chain: "base-sepolia",
    funded: false,
    private_key_redacted: `${pk.slice(0, 6)}***${pk.slice(-4)}`,
  };
}
