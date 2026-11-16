/**
 * FC-8 round 3 (astra pack 61b census closure) — shared test doubles for the
 * three e2e scripts' `run(deps)`. Not a test file itself (no `*.test.ts`
 * suffix); imported by the dynamic test files for each script.
 *
 * These scripts call live Base Sepolia RPC + the gateway + an oracle. A
 * dynamic test proves what a script PRINTS, not what the chain/gateway
 * actually did, so these fakes only need to be structurally valid enough
 * for the script's own logic to proceed (extract an address from a log,
 * take a branch on a truthy field) — never semantically accurate gas/block
 * numbers etc., which are not gateway/oracle-derived and are not part of
 * astra's census.
 */
import type { PublicClient, WalletClient } from "viem";

/** A minimal fetch Response double: status, headers.get(), text(), json(). */
export function fakeResponse(
  status: number,
  bodyObjOrText: unknown,
  headers: Record<string, string> = {},
): Response {
  const bodyText = typeof bodyObjOrText === "string" ? bodyObjOrText : JSON.stringify(bodyObjOrText);
  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lowerHeaders[k.toLowerCase()] = v;
  return {
    status,
    statusText: status === 200 ? "OK" : "ERROR",
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => lowerHeaders[k.toLowerCase()] ?? null },
    text: async () => bodyText,
    json: async () => (typeof bodyObjOrText === "string" ? JSON.parse(bodyObjOrText) : bodyObjOrText),
  } as unknown as Response;
}

/**
 * A fake viem wallet+public client pair covering every method the three
 * scripts call: getBalance, getTransactionCount, deployContract,
 * writeContract, waitForTransactionReceipt, readContract. Deterministic,
 * structurally valid, carries no canary (on-chain tx data is not part of
 * astra's gateway/oracle-derived census).
 */
export function makeFakeChain(): { wallet: WalletClient; pub: PublicClient } {
  let nonce = 0;
  const DEPLOY_HASH = `0x${"1".repeat(64)}`;
  const WRITE_HASH = `0x${"2".repeat(64)}`;
  const CONTRACT_ADDR = `0x${"3".repeat(40)}`;
  // topics[1] padded to 32 bytes so `"0x" + topics[1].slice(26)` yields a 20-byte address.
  const ESCROW_TOPIC1 = `0x${"0".repeat(24)}${"4".repeat(40)}`;

  const pub = {
    getBalance: async () => 1_000_000_000_000_000_000n,
    getTransactionCount: async () => nonce++,
    waitForTransactionReceipt: async ({ hash }: { hash: string }) => ({
      blockNumber: 12345n,
      gasUsed: 21000n,
      status: "success",
      contractAddress: CONTRACT_ADDR,
      logs: [{ topics: [`0x${"5".repeat(64)}`, ESCROW_TOPIC1], address: CONTRACT_ADDR }],
      transactionHash: hash,
    }),
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "balanceOf": return 5_000_000n;
        case "funded": return true;
        case "getMilestoneCount": return 1n;
        case "totalAmount": return 1_000_000n;
        case "totalFeesCollectedByToken": return 100n;
        case "getEscrowCount": return 3n;
        default: return 0n;
      }
    },
  };

  const wallet = {
    deployContract: async () => DEPLOY_HASH,
    writeContract: async () => WRITE_HASH,
  };

  return { wallet: wallet as unknown as WalletClient, pub: pub as unknown as PublicClient };
}
