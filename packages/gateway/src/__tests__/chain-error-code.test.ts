import { describe, expect, it } from "vitest";
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  InvalidDomainError,
  InvalidParamsRpcError,
  InvalidPrimaryTypeError,
  InvalidStructTypeError,
  RpcError,
  RpcRequestError,
  SocketClosedError,
  TimeoutError,
  WaitForTransactionReceiptTimeoutError,
  WebSocketRequestError,
} from "viem";

const CANARY = "CANARY-rpc-key-7f3a";
const URL = `https://rpc.example.invalid/v2/${CANARY}`;
const HASH = `0x${"1".repeat(64)}` as const;
const BODY = { method: "eth_sendRawTransaction", params: [CANARY] };
const CODES = [
  "identity_write_disabled", "config_invalid", "rpc_unavailable",
  "insufficient_funds", "rpc_rejected", "tx_reverted", "tx_missing_event",
  "signing_failed", "wallet_generation_failed", "unknown",
] as const;

// The import is intentionally inside each test: master's absent module must
// produce individual red tests, without preventing helper tests from running.
async function classifier() {
  const path = "../services/chain-error-code.js";
  return import(path);
}

function wrapped(error: BaseError): BaseError {
  return new ContractFunctionExecutionError(error, {
    abi: [], functionName: "register",
  });
}

const mapped = [
  ["HttpRequestError", () => new HttpRequestError({ url: URL, status: 401, body: BODY }), "rpc_unavailable"],
  ["WebSocketRequestError", () => new WebSocketRequestError({ url: URL, body: BODY }), "rpc_unavailable"],
  ["SocketClosedError", () => new SocketClosedError({ url: URL }), "rpc_unavailable"],
  ["TimeoutError", () => new TimeoutError({ url: URL, body: BODY }), "rpc_unavailable"],
  ["WaitForTransactionReceiptTimeoutError", () => new WaitForTransactionReceiptTimeoutError({ hash: HASH }), "rpc_unavailable"],
  ["InsufficientFundsError", () => new InsufficientFundsError({ cause: new HttpRequestError({ url: URL }) }), "insufficient_funds"],
  ["ExecutionRevertedError", () => new ExecutionRevertedError({ message: URL }), "tx_reverted"],
  ["ContractFunctionRevertedError", () => new ContractFunctionRevertedError({ abi: [], functionName: "register", message: URL }), "tx_reverted"],
  ["RpcRequestError", () => new RpcRequestError({ url: URL, body: BODY, error: { code: -32602, message: URL } }), "rpc_rejected"],
  ["RpcError", () => new RpcError(new Error(URL), { shortMessage: URL }), "rpc_rejected"],
  ["InvalidParamsRpcError", () => new InvalidParamsRpcError(new Error(URL)), "rpc_rejected"],
  ["InvalidDomainError", () => new InvalidDomainError({ domain: URL }), "signing_failed"],
  ["InvalidPrimaryTypeError", () => new InvalidPrimaryTypeError({ primaryType: URL, types: {} }), "signing_failed"],
  ["InvalidStructTypeError", () => new InvalidStructTypeError({ type: URL }), "signing_failed"],
] as const;

describe("closed identity-write error codes", () => {
  it("exports exactly the closed code tuple", async () => {
    const { CHAIN_ERROR_CODES } = await classifier();
    expect(CHAIN_ERROR_CODES).toEqual(CODES);
  });

  it.each(mapped)("classifies %s directly and through one and two writeContract wrappers", async (_name, makeError, code) => {
    const { classifyChainError } = await classifier();
    const error = makeError();
    for (const candidate of [error, wrapped(error), wrapped(wrapped(error))]) {
      expect(classifyChainError(candidate)).toBe(code);
      expect(CODES).toContain(classifyChainError(candidate));
    }
  });

  it("uses genuine viem HTTP text carrying the canary", () => {
    const error = new HttpRequestError({ url: URL, status: 401, body: BODY });
    expect(error.message).toContain(URL);
    expect(wrapped(wrapped(error)).message).toContain(CANARY);
  });

  it("prefers specific causes to generic JSON-RPC wrappers", async () => {
    const { classifyChainError } = await classifier();
    for (const [cause, code] of [
      [new ExecutionRevertedError({ message: URL }), "tx_reverted"],
      [new InsufficientFundsError(), "insufficient_funds"],
      [new HttpRequestError({ url: URL }), "rpc_unavailable"],
    ] as const) {
      const error = new RpcError(cause, { shortMessage: URL });
      expect(classifyChainError(wrapped(wrapped(error)))).toBe(code);
    }
  });

  it("classifies every helper code exactly without using its human text", async () => {
    const { classifyChainError, ChainWriteError } = await classifier();
    for (const code of CODES) {
      expect(classifyChainError(new ChainWriteError(code, URL))).toBe(code);
    }
  });

  it("never accepts an arbitrary code from an error object", async () => {
    const { classifyChainError, ChainWriteError } = await classifier();
    expect(classifyChainError(Object.assign(new Error(URL), { code: URL }))).toBe("unknown");
    const typed = new ChainWriteError("unknown", URL);
    Object.assign(typed, { code: URL });
    expect(classifyChainError(typed)).toBe("unknown");
  });

  it("returns unknown for plain errors and non-Error throwables, without reading text", async () => {
    const { classifyChainError } = await classifier();
    const unreadable = new Error();
    Object.defineProperty(unreadable, "message", { get() { throw new Error("message was read"); } });
    for (const error of [new Error(URL), unreadable, URL, null, undefined, 7, { message: URL }, { code: "rpc_unavailable" }]) {
      expect(classifyChainError(error)).toBe("unknown");
    }
  });

  it("terminates on a cyclic cause chain", async () => {
    const { classifyChainError } = await classifier();
    const error = new BaseError(URL);
    Object.assign(error, { cause: error });
    expect(classifyChainError(error)).toBe("unknown");
  });
});
