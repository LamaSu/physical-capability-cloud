import {
  createPublicClient, encodeDeployData, erc6492SignatureValidatorAbi,
  erc6492SignatureValidatorByteCode, ExecutionRevertedError, getAddress,
  hashMessage, http, isErc6492Signature, recoverMessageAddress,
  type Hex, type Transport,
} from "viem";
import { registerOutboundSecretUrl, withSuppressedTracing } from "../services/outbound-secrets.js";

export type SignatureCheck =
  | { ok: true; kind: "eoa" | "contract" }
  | { ok: false; reason: "malformed" | "invalid" | "wrong_chain" | "unconfigured" | "unavailable" };

/** Fixed, request-independent failure for the link-proof boundary. */
export class SignatureVerifierUnavailableError extends Error {
  constructor() {
    super("Signature verifier unavailable");
    this.name = "SignatureVerifierUnavailableError";
  }
}

export const SIGVERIFY_GAS_CAP = 3_000_000n;
let testTransport: Transport | null = null;
const verifiedChains = new Map<string, number>();

export function setSignatureVerifierTransportForTests(transport: Transport | null): void {
  testTransport = transport;
  verifiedChains.clear();
}

export function __resetSignatureVerifierForTests(): void {
  setSignatureVerifierTransportForTests(null);
}

function positiveInteger(value: string | undefined, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function configuredUrl(): string | undefined {
  const value = process.env.PCC_SIGVERIFY_RPC_URL;
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || value.includes("#")) return undefined;
    if (url.protocol !== "https:" && !(url.protocol === "http:" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** viem wraps transport failures too, so only a revert anywhere in the cause chain is invalid. */
function isRevert(error: unknown): boolean {
  const seen = new Set<unknown>();
  let link = error;
  while (link !== null && typeof link === "object" && !seen.has(link)) {
    seen.add(link);
    if (link instanceof ExecutionRevertedError) return true;
    const detail = link as { code?: unknown; message?: unknown; cause?: unknown };
    if (detail.code === 3 || (typeof detail.code === "number" &&
      typeof detail.message === "string" && /execution reverted/i.test(detail.message))) return true;
    link = detail.cause;
  }
  return false;
}

/** A custom transport need not implement timeout. Late answers must never authenticate. */
function withinDeadline<T>(request: () => Promise<T>, deadline: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { reject(new Error("Signature verifier deadline exceeded")); return; }
    const timer = setTimeout(() => reject(new Error("Signature verifier deadline exceeded")), remaining);
    Promise.resolve().then(request).then(value => {
      clearTimeout(timer);
      if (Date.now() >= deadline) reject(new Error("Signature verifier deadline exceeded"));
      else resolve(value);
    }, error => {
      clearTimeout(timer);
      if (Date.now() >= deadline) reject(new Error("Signature verifier deadline exceeded"));
      else reject(error);
    });
  });
}

/** Verify locally first, then use a gas-bounded deployless universal validator on the named chain. */
export async function verifyEvmMessageSignature({ address, message, signature, chainId }: {
  address: string; message: string; signature: string; chainId: number;
}): Promise<SignatureCheck> {
  try {
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address) ||
      typeof signature !== "string" || !/^0x(?:[0-9a-fA-F]{2}){64,2048}$/.test(signature) ||
      typeof message !== "string" || message.length === 0 || message.length > 8192) {
      return { ok: false, reason: "malformed" };
    }
    const hexSignature = signature as Hex;
    const eoaLength = signature.length === 130 || signature.length === 132;
    if (eoaLength && !isErc6492Signature(hexSignature)) {
      try {
        const recovered = await recoverMessageAddress({ message, signature: hexSignature });
        if (recovered.toLowerCase() === address.toLowerCase()) return { ok: true, kind: "eoa" };
      } catch {
        // Failed local recovery can still be a contract signature.
      }
    }

    const configuredChain = positiveInteger(process.env.PCC_SIGVERIFY_CHAIN_ID, 84532);
    if (configuredChain === undefined) return { ok: false, reason: "unconfigured" };
    if (chainId !== configuredChain) return { ok: false, reason: "wrong_chain" };
    const url = configuredUrl();
    if (!url) return { ok: false, reason: eoaLength ? "invalid" : "unconfigured" };

    registerOutboundSecretUrl(url);
    const timeout = Math.min(15000, Math.max(1000,
      positiveInteger(process.env.PCC_SIGVERIFY_TIMEOUT_MS, 5000) ?? 5000));
    const deadline = Date.now() + timeout;
    // Recreate the HTTP transport for each request to give it only the remaining budget.
    const client = () => createPublicClient({
      ccipRead: false,
      batch: { multicall: false },
      transport: testTransport ?? http(url, { retryCount: 0, timeout: Math.max(1, deadline - Date.now()), batch: false }),
    });
    if (verifiedChains.get(url) !== configuredChain) {
      try {
        const rpcChain = await withinDeadline(() => withSuppressedTracing(() => client().getChainId()), deadline);
        if (rpcChain !== configuredChain) return { ok: false, reason: "unavailable" };
        verifiedChains.set(url, rpcChain);
      } catch {
        // A chain query failure is an infrastructure failure, regardless of its RPC code.
        return { ok: false, reason: "unavailable" };
      }
    }
    const data = encodeDeployData({
      abi: erc6492SignatureValidatorAbi,
      bytecode: erc6492SignatureValidatorByteCode,
      args: [getAddress(address), hashMessage(message), hexSignature],
    });
    const result = await withinDeadline(() => withSuppressedTracing(() => client().call({ data, gas: SIGVERIFY_GAS_CAP })), deadline);
    return result.data === "0x01" ? { ok: true, kind: "contract" } : { ok: false, reason: "invalid" };
  } catch (error) {
    // Never expose viem errors: they can embed both RPC credentials and signed bytes.
    return { ok: false, reason: isRevert(error) ? "invalid" : "unavailable" };
  }
}
