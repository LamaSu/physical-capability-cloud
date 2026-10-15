import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPublicClient, decodeAbiParameters, encodeAbiParameters, http,
  isErc6492Signature, parseErc6492Signature, serializeErc6492Signature, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { baseSepolia } from "viem/chains";
import { createSiweMessage } from "viem/siwe";
import { __resetSignatureVerifierForTests, setSignatureVerifierTransportForTests, verifyEvmMessageSignature } from "../auth/evm-signature.js";

const url = process.env.PCC_LIVE_SIGVERIFY_RPC_URL;
describe.skipIf(!url)("live Base Sepolia universal signature validator", () => {
  afterEach(() => { __resetSignatureVerifierForTests(); vi.unstubAllEnvs(); });
  it("accepts an undeployed CSW and rejects meaningful tampering, wrong messages, owners and chains", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const client = createPublicClient({ chain: baseSepolia, transport: http(url!) });
    const account = await toCoinbaseSmartAccount({ client, owners: [owner], version: "1.1" });
    expect([undefined, "0x"]).toContain(await client.getCode({ address: account.address }));
    const message = createSiweMessage({
      domain: "capability.network", address: account.address, uri: "https://capability.network",
      version: "1", chainId: 84532, nonce: "livecheck12345678", issuedAt: new Date(),
    });
    const signature = await account.signMessage({ message });
    expect(isErc6492Signature(signature)).toBe(true);
    setSignatureVerifierTransportForTests(null);
    vi.stubEnv("PCC_SIGVERIFY_RPC_URL", url!);
    vi.stubEnv("PCC_SIGVERIFY_CHAIN_ID", "84532");
    const check = (sig: Hex, signedMessage = message, chainId = 84532) => verifyEvmMessageSignature({
      address: account.address, message: signedMessage, signature: sig, chainId,
    });
    expect(await check(signature)).toEqual({ ok: true, kind: "contract" });
    const parsed = parseErc6492Signature(signature);
    if (!parsed.address || !parsed.data) throw new Error("Expected ERC-6492 wrapper");
    const tuple = [{ type: "tuple", components: [
      { name: "ownerIndex", type: "uint8" }, { name: "signatureData", type: "bytes" },
    ] }] as const;
    const [{ ownerIndex, signatureData }] = decodeAbiParameters(tuple, parsed.signature);
    const firstByte = (parseInt(signatureData.slice(2, 4), 16) ^ 1).toString(16).padStart(2, "0");
    const tamperedData = `0x${firstByte}${signatureData.slice(4)}` as Hex;
    const tampered = serializeErc6492Signature({ address: parsed.address, data: parsed.data,
      signature: encodeAbiParameters(tuple, [{ ownerIndex, signatureData: tamperedData }]) });
    expect(await check(tampered)).toEqual({ ok: false, reason: "invalid" });
    expect(await check(signature, `${message}!`)).toEqual({ ok: false, reason: "invalid" });
    expect(await check(await owner.signMessage({ message }))).toEqual({ ok: false, reason: "invalid" });
    expect(await check(signature, message, 8453)).toEqual({ ok: false, reason: "wrong_chain" });
  }, 60_000);
});
