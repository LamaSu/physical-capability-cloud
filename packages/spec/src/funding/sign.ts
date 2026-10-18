/**
 * `signJobPolicy`: the buyer's EIP-712 acceptance of a verified policy. Author: implementer-bravo (pcc-adk).
 *
 * It signs only `prepared.typedData`, the SDK's own recomputation, never typed data a gateway supplied, and only
 * for an object `prepareFunding` returned. It then checks that the wallet's signature is one the factory accepts
 * (FAC:375-387) and that it recovers to the payer over the recomputed digest. So the signature is exactly over
 * what the contract verifies.
 *
 * Run 1's payer-sent `fund()` does not need it: when the payer sends, the payer leg is implicit and the payer
 * signature is never read (ESC:718, FAC:253). It is for an off-chain acceptance record, and for a relayed fund
 * (plan S3.3, out of scope here). A relayer holding it can fund ONLY these terms, ONLY from an allowance the
 * payer granted to this escrow, and only until the expiry.
 */
import type { Hex, WalletClient } from "viem";
import { refuse } from "./errors.js";
import { assertPrepared, eoaSignatureProblem, recoverSigner, type PreparedFunding } from "./prepare.js";

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export async function signJobPolicy(args: { prepared: PreparedFunding; wallet: WalletClient }): Promise<Hex> {
  const prepared = assertPrepared(args.prepared);
  const account = args.wallet.account;
  if (!account) refuse("PAYER_NOT_SIGNER", "the wallet has no account to sign with");
  if (!same(account.address, prepared.payer)) refuse("PAYER_NOT_SIGNER", `the wallet is ${account.address}; the policy's payer is ${prepared.payer}`);
  let chainId: number;
  try {
    chainId = await args.wallet.getChainId();
  } catch {
    refuse("LIVE_CHECK_FAILED", "could not read the wallet's chain id");
  }
  if (BigInt(chainId) !== prepared.chainId) refuse("CHAIN_MISMATCH", `the wallet is on chain ${chainId}; the policy is for chain ${prepared.chainId}`);

  const { domain, types, primaryType, message } = prepared.typedData;
  const signature = await args.wallet.signTypedData({ account, domain, types, primaryType, message });

  const badShape = eoaSignatureProblem(signature);
  if (badShape) refuse("SIGNATURE_NOT_CANONICAL", `the wallet's signature: ${badShape}`);
  const signer = await recoverSigner(prepared.digest, signature);
  if (signer === undefined || !same(signer, prepared.payer)) {
    refuse("PAYER_NOT_SIGNER", `the wallet's signature recovers to ${signer ?? "nothing"} over the policy digest, not the payer ${prepared.payer}`);
  }
  return signature;
}
