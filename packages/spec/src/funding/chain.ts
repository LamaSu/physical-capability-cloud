/**
 * Chain plumbing for the buyer-funding SDK: one block, by identity. Author: implementer-bravo (pcc-adk).
 *
 * Every read a check depends on is a raw `eth_call` / `eth_getCode` addressed to ONE block by its hash (EIP-1898,
 * `requireCanonical: true`), the same pattern as `@pcc/contracts/vnext`'s preflight.ts and read.ts. A reorganized
 * block can never answer for the one that was checked, and a node that cannot serve hash-pinned calls makes the
 * caller fail closed.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { refuse } from "./errors.js";
import { ESCROW_ABI } from "./vnext.js";

export interface PinnedBlock {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

/** The latest block, or the one with `blockHash`; throws if the node returns a block it cannot identify. */
export async function pinBlock(client: PublicClient, blockHash?: Hex): Promise<PinnedBlock> {
  const b = blockHash === undefined ? await client.getBlock() : await client.getBlock({ blockHash });
  if (b.number === null || b.hash === null) throw new Error("the node returned a pending block, which has no number or hash to pin");
  return { number: b.number, hash: b.hash, timestamp: b.timestamp };
}

export interface PinnedReader {
  code(address: Address): Promise<Hex>;
  read<T>(address: Address, abi: Abi, functionName: string, args?: readonly unknown[]): Promise<T>;
}

export function pinnedReader(client: PublicClient, blockHash: Hex): PinnedReader {
  const pin = { blockHash, requireCanonical: true } as const;
  const rpc = (method: "eth_call" | "eth_getCode", params: unknown[]) =>
    client.request({ method, params: [...params, pin] } as never) as Promise<Hex>;
  return {
    code: (address) => rpc("eth_getCode", [address]),
    async read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
      const data = encodeFunctionData({ abi, functionName, args } as never);
      const ret = await rpc("eth_call", [{ to: address, data }]);
      return decodeFunctionResult({ abi, functionName, data: ret } as never) as T;
    },
  };
}

/** Revert data carried anywhere in an error's cause chain (a raw JSON-RPC revert puts it in `data`). */
function revertDataOf(e: unknown): Hex | undefined {
  for (let x: unknown = e, i = 0; x && i < 8; x = (x as { cause?: unknown }).cause, i++) {
    const data = (x as { data?: unknown }).data;
    if (typeof data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(data)) return data as Hex;
    if (data && typeof (data as { data?: unknown }).data === "string") return (data as { data: Hex }).data;
  }
  return undefined;
}

/** The revert's error name when the escrow declared it, else the shortest message available. */
export function describeRevert(e: unknown): string {
  const data = revertDataOf(e);
  if (data) {
    try {
      return decodeErrorResult({ abi: ESCROW_ABI, data }).errorName;
    } catch {
      // not an error the escrow declares; fall through to the message
    }
  }
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      if (reverted.data?.errorName) return reverted.data.errorName;
      if (reverted.reason) return reverted.reason;
    }
    return e.shortMessage;
  }
  return e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
}

/** Both clients must be on `chainId`: the wallet signs and sends there, the read client checks there. */
export async function assertChain(wallet: WalletClient, publicClient: PublicClient, chainId: bigint): Promise<void> {
  let walletChain: number;
  let readChain: number;
  try {
    [walletChain, readChain] = await Promise.all([wallet.getChainId(), publicClient.getChainId()]);
  } catch (e) {
    refuse("LIVE_CHECK_FAILED", `could not read the chain id: ${describeRevert(e)}`);
  }
  if (BigInt(walletChain) !== chainId) refuse("CHAIN_MISMATCH", `the wallet is on chain ${walletChain}; the policy is for chain ${chainId}`);
  if (BigInt(readChain) !== chainId) refuse("CHAIN_MISMATCH", `the read client is on chain ${readChain}; the policy is for chain ${chainId}`);
}
