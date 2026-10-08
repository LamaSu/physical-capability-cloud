/**
 * signJobPolicy (implementer-bravo, pcc-adk): it signs only a prepared policy, only as its payer, only on its chain,
 * and only returns a signature the factory would accept over exactly the recomputed digest.
 */
import { describe, expect, it } from "vitest";
import { keccak256, parseSignature, recoverAddress, verifyTypedData, type LocalAccount } from "viem";
import { toAccount } from "viem/accounts";
import { FundingRefusal, prepareFunding, signJobPolicy, type FundingRefusalCode } from "../../funding/index.js";
import { buildFixture, highS, makeChain, newAccount, testPins } from "./fixture.js";

async function refusal(p: Promise<unknown>): Promise<FundingRefusalCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FundingRefusal) return e.code;
    throw e;
  }
  throw new Error("expected a FundingRefusal, but the call succeeded");
}

async function setup() {
  const fx = await buildFixture();
  const chain = makeChain(fx);
  const prepared = await prepareFunding({
    payload: fx.wire(),
    wallet: chain.wallet(),
    publicClient: chain.publicClient,
    quote: { maxTotalGross: fx.totalGross },
    pins: testPins(fx),
  });
  return { fx, chain, prepared };
}

/** The payer's key behind a wallet that rewrites what it signs. */
function rewritingAccount(payer: LocalAccount, rewrite: (td: never) => Promise<`0x${string}`>): LocalAccount {
  return toAccount({
    address: payer.address,
    signMessage: (args) => payer.signMessage(args),
    signTransaction: (tx) => payer.signTransaction(tx),
    signTypedData: (td) => rewrite(td as never),
  });
}

describe("signJobPolicy", () => {
  it("signs exactly the policy digest, as the payer, in the shape the factory accepts", async () => {
    const { fx, chain, prepared } = await setup();
    const signature = await signJobPolicy({ prepared, wallet: chain.wallet() });
    expect(await recoverAddress({ hash: fx.digest, signature })).toBe(fx.payer.address);
    expect(await verifyTypedData({ address: fx.payer.address, ...prepared.typedData, signature })).toBe(true);
    expect([27n, 28n]).toContain(parseSignature(signature).v);
    expect(chain.sends()).toEqual([]);
  });

  it("NOT_PREPARED: a copy of a prepared policy, or any other object", async () => {
    const { chain, prepared } = await setup();
    for (const copy of [{ ...prepared }, structuredClone(prepared), {}, null]) {
      expect(await refusal(signJobPolicy({ prepared: copy as never, wallet: chain.wallet() }))).toBe("NOT_PREPARED");
    }
  });

  it("PAYER_NOT_SIGNER: another wallet", async () => {
    const { chain, prepared } = await setup();
    expect(await refusal(signJobPolicy({ prepared, wallet: chain.wallet(newAccount()) }))).toBe("PAYER_NOT_SIGNER");
  });

  it("a non-payer wallet, or the payer on another chain, is refused before it is ever asked to sign", async () => {
    const { fx, chain, prepared } = await setup();
    let asked = 0;
    const counting = (owner: LocalAccount) =>
      rewritingAccount(owner, async (td) => {
        asked++;
        return owner.signTypedData(td);
      });
    expect(await refusal(signJobPolicy({ prepared, wallet: chain.wallet(counting(newAccount())) }))).toBe("PAYER_NOT_SIGNER");
    chain.state.walletChainId = 1;
    expect(await refusal(signJobPolicy({ prepared, wallet: chain.wallet(counting(fx.payer)) }))).toBe("CHAIN_MISMATCH");
    expect(asked).toBe(0);
  });

  it("PAYER_NOT_SIGNER: a wallet with no account", async () => {
    const { chain, prepared } = await setup();
    expect(await refusal(signJobPolicy({ prepared, wallet: chain.accountless() }))).toBe("PAYER_NOT_SIGNER");
  });

  it("LIVE_CHECK_FAILED: the wallet's chain id cannot be read", async () => {
    const { chain, prepared } = await setup();
    chain.state.failChainId = true;
    expect(await refusal(signJobPolicy({ prepared, wallet: chain.wallet() }))).toBe("LIVE_CHECK_FAILED");
  });

  it("CHAIN_MISMATCH: the wallet moved to another chain after prepare", async () => {
    const { chain, prepared } = await setup();
    chain.state.walletChainId = 1;
    expect(await refusal(signJobPolicy({ prepared, wallet: chain.wallet() }))).toBe("CHAIN_MISMATCH");
  });

  it("SIGNATURE_NOT_CANONICAL: a wallet that returns the high-s twin", async () => {
    const { fx, chain, prepared } = await setup();
    const account = rewritingAccount(fx.payer, async (td) => highS(await fx.payer.signTypedData(td)));
    expect(await refusal(signJobPolicy({ prepared, wallet: chain.wallet(account) }))).toBe("SIGNATURE_NOT_CANONICAL");
  });

  it("PAYER_NOT_SIGNER: a wallet whose signature is over something else", async () => {
    const { fx, chain, prepared } = await setup();
    const account = rewritingAccount(fx.payer, () => fx.payer.sign({ hash: keccak256("0x01") }));
    expect(await refusal(signJobPolicy({ prepared, wallet: chain.wallet(account) }))).toBe("PAYER_NOT_SIGNER");
  });
});
