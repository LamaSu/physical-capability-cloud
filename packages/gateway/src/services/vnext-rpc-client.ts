/** Read-only V-next chain access. RPC errors and credentials never leave this boundary. */
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, type Abi, type Address, type Hex, type Transport } from "viem";
import { readUnitConfigs, VNextSettlementEscrowABI, type ReadUnitConfigsResult } from "@pcc/contracts/vnext";
import { registerOutboundSecretUrl, withSuppressedTracing } from "./outbound-secrets.js";
import { isTestProcess } from "./settlement-mode.js";

export interface VNextBlock {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}
export interface VNextChainReads {
  chainId(): Promise<number>;
  finalizedBlock(): Promise<VNextBlock>;
  blockByNumber(n: bigint): Promise<VNextBlock>;
  code(address: Address, blockHash: Hex): Promise<Hex>;
  call(address: Address, abi: Abi, functionName: string, args: readonly unknown[], blockHash: Hex): Promise<unknown>;
  unitConfigs(escrow: Address, blockNumber: bigint): Promise<ReadUnitConfigsResult>;
  fundedLogs(escrow: Address, fromBlock: bigint, toBlock: bigint): Promise<Array<{ blockNumber: bigint; blockHash: Hex }>>;
}

export type VNextPrepareReads = VNextChainReads & { latestBlock(): Promise<VNextBlock> };

export function vnextRpcUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env === process.env ? process.env.PCC_VNEXT_RPC_URL : env.PCC_VNEXT_RPC_URL;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || value.includes("#")) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) return null;
    return value;
  } catch { return null; }
}

let testTransport: Transport | null = null;
export function __setVNextTransportForTest(transport: Transport | null): void {
  if (!isTestProcess()) throw new Error("V-next transport: test processes only");
  testTransport = transport;
}

export function createVNextChainReads(url: string): VNextPrepareReads {
  registerOutboundSecretUrl(url);
  const client = createPublicClient({
    ccipRead: false, batch: { multicall: false },
    transport: testTransport ?? http(url, { retryCount: 0, timeout: 10_000, batch: false }),
  });
  const safe = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await withSuppressedTracing(fn); }
    catch { throw new Error("chain_read_failed"); }
  };
  const block = async (request: { blockTag: "finalized" } | { blockTag: "latest" } | { blockNumber: bigint }): Promise<VNextBlock> => {
    const b = await client.getBlock(request);
    if (b.number === null || b.hash === null) throw new Error("chain_read_failed");
    return { number: b.number, hash: b.hash, timestamp: b.timestamp };
  };
  return {
    chainId: () => safe(() => client.getChainId()),
    latestBlock: () => safe(() => block({ blockTag: "latest" })),
    finalizedBlock: () => safe(() => block({ blockTag: "finalized" })),
    blockByNumber: n => safe(() => block({ blockNumber: n })),
    code: (address, blockHash) => safe(() => client.request({ method: "eth_getCode", params: [address, { blockHash, requireCanonical: true }] } as never) as Promise<Hex>),
    call: (address, abi, functionName, args, blockHash) => safe(async () => {
      const data = encodeFunctionData({ abi, functionName, args });
      const result = await client.request({ method: "eth_call", params: [{ to: address, data }, { blockHash, requireCanonical: true }] } as never) as Hex;
      return decodeFunctionResult({ abi, functionName, data: result });
    }),
    unitConfigs: (escrow, blockNumber) => safe(async () => {
      const result = await readUnitConfigs({ client, escrow, blockNumber });
      // The shared reader includes diagnostics from RPC errors; only closed checks cross this port.
      return { ...result, checks: result.checks.map(({ name, ok }) => ({ name, ok })) };
    }),
    fundedLogs: (escrow, fromBlock, toBlock) => safe(async () => {
      const logs = await client.getLogs({ address: escrow, event: VNextSettlementEscrowABI.find(e => e.type === "event" && e.name === "Funded")!, fromBlock, toBlock, strict: true });
      return logs.map(log => {
        if (log.blockNumber === null || log.blockHash === null || log.removed) throw new Error("chain_read_failed");
        return { blockNumber: log.blockNumber, blockHash: log.blockHash };
      });
    }),
  };
}
