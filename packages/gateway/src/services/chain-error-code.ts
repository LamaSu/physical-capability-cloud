import {
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  InvalidDomainError,
  InvalidPrimaryTypeError,
  InvalidStructTypeError,
  RpcError,
  RpcRequestError,
  SocketClosedError,
  TimeoutError,
  WaitForTransactionReceiptTimeoutError,
  WebSocketRequestError,
} from "viem";

/** The only identity-write failure values permitted in responses or telemetry. */
export const CHAIN_ERROR_CODES = Object.freeze([
  "identity_write_disabled",
  "config_invalid",
  "rpc_unavailable",
  "insufficient_funds",
  "rpc_rejected",
  "tx_reverted",
  "tx_missing_event",
  "signing_failed",
  "wallet_generation_failed",
  "unknown",
] as const);

export type ChainErrorCode = (typeof CHAIN_ERROR_CODES)[number];

/** Human text is for local debugging; callers must use classifyChainError. */
export class ChainWriteError extends Error {
  constructor(readonly code: ChainErrorCode, message: string) {
    super(message);
    this.name = "ChainWriteError";
  }
}

/** Classify by trusted types only: provider text, URLs and bodies are never read. */
export function classifyChainError(error: unknown): ChainErrorCode {
  let current: unknown = error;
  let fallback: ChainErrorCode = "unknown";
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current instanceof ChainWriteError) {
      // Check membership as well: JS callers can mutate a TypeScript readonly field.
      const code = current.code;
      return CHAIN_ERROR_CODES.includes(code) ? code : "unknown";
    }
    if (current instanceof InsufficientFundsError) return "insufficient_funds";
    if (
      current instanceof ExecutionRevertedError ||
      current instanceof ContractFunctionRevertedError
    ) return "tx_reverted";
    if (
      current instanceof HttpRequestError ||
      current instanceof WebSocketRequestError ||
      current instanceof SocketClosedError ||
      current instanceof TimeoutError ||
      current instanceof WaitForTransactionReceiptTimeoutError
    ) return "rpc_unavailable";
    if (
      current instanceof InvalidDomainError ||
      current instanceof InvalidPrimaryTypeError ||
      current instanceof InvalidStructTypeError
    ) return "signing_failed";
    // A JSON-RPC wrapper may contain a more specific transport/revert/funds cause.
    if (current instanceof RpcError || current instanceof RpcRequestError) {
      fallback = "rpc_rejected";
    }
    if (current instanceof BaseError) {
      current = current.cause;
    } else {
      return fallback;
    }
  }
  return fallback;
}
