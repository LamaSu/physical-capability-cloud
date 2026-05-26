/**
 * Tests for manifest.ts — EIP-712 sign + verify round-trip with a real
 * viem private-key signer (no external RPC needed).
 */

import { describe, it, expect } from "vitest";
import {
  signBackendManifest,
  verifyBackendManifest,
  prepareEip712Payload,
  type RegistryEip712Domain,
} from "./manifest.js";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import type {
  BackendManifest,
  BackendManifestAuthor,
} from "@pcc/spec";

const MODULE_PATH = "pylabrobot.liquid_handling.backends.hamilton.STAR";
const HASH_A = "0x" + "a".repeat(64);

function makeManifest(
  authorAddr: `0x${string}`,
  overrides: Partial<BackendManifest> = {},
): BackendManifest {
  const author: BackendManifestAuthor = {
    address: authorAddr,
    groupBps: 10000,
  };
  return {
    schemaVersion: 1,
    plrModulePath: MODULE_PATH,
    plrVersionRange: ">=0.2.0 <0.3.0",
    className: "STARBackend",
    authors: [author],
    rateScheduleHash: HASH_A,
    license: "MIT",
    issuedAt: "2026-05-25T00:00:00.000Z",
    ...overrides,
  };
}

const DOMAIN: RegistryEip712Domain = {
  chainId: 84532, // base-sepolia
  verifyingContract: "0x0000000000000000000000000000000000000bee",
};

describe("EIP-712 sign + verify round-trip", () => {
  it("signs with a viem WalletClient and verifies", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const wallet = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http("https://sepolia.base.org"),
    });

    const manifest = makeManifest(account.address);
    const signed = await signBackendManifest(manifest, wallet, DOMAIN);

    expect(signed.signature).toMatch(/^0x[a-fA-F0-9]+$/);
    expect(signed.signerAddress).toBe(account.address);

    const { valid, recovered } = await verifyBackendManifest(signed, DOMAIN);
    expect(valid).toBe(true);
    expect(recovered).toBe(account.address);
  });

  it("rejects a manifest whose signer doesn't match authors[0]", async () => {
    const signerKey = generatePrivateKey();
    const signerAccount = privateKeyToAccount(signerKey);
    const wallet = createWalletClient({
      account: signerAccount,
      chain: baseSepolia,
      transport: http("https://sepolia.base.org"),
    });

    // Manifest claims a different address as authors[0]
    const wrongAuthor = "0x000000000000000000000000000000000000dead" as `0x${string}`;
    const manifest = makeManifest(wrongAuthor);

    const signature = await wallet.signTypedData({
      domain: {
        name: "PCC-PLRBackendRegistry",
        version: "1",
        chainId: DOMAIN.chainId,
        verifyingContract: DOMAIN.verifyingContract,
      },
      types: {
        Author: [
          { name: "address", type: "address" },
          { name: "groupBps", type: "uint16" },
          { name: "name", type: "string" },
          { name: "handle", type: "string" },
          { name: "role", type: "string" },
        ],
        BackendManifest: [
          { name: "schemaVersion", type: "uint8" },
          { name: "plrModulePath", type: "string" },
          { name: "plrVersionRange", type: "string" },
          { name: "className", type: "string" },
          { name: "authors", type: "Author[]" },
          { name: "rateScheduleHash", type: "bytes32" },
          { name: "delegatedAgentId", type: "bytes32" },
          { name: "license", type: "string" },
          { name: "notes", type: "string" },
          { name: "issuedAt", type: "string" },
        ],
      },
      primaryType: "BackendManifest",
      message: prepareEip712Payload(manifest),
    });

    const result = await verifyBackendManifest(
      {
        manifest,
        signature,
        signerAddress: signerAccount.address,
      },
      DOMAIN,
    );
    expect(result.valid).toBe(false);
    expect(result.recovered).toBe(signerAccount.address);
  });

  it("signBackendManifest rejects when expectedSignerAddress mismatches authors[0]", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const wallet = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http("https://sepolia.base.org"),
    });
    const manifest = makeManifest(account.address);
    await expect(
      signBackendManifest(
        manifest,
        wallet,
        DOMAIN,
        "0x000000000000000000000000000000000000beef",
      ),
    ).rejects.toThrow(/expected signer/);
  });
});

describe("prepareEip712Payload", () => {
  it("fills optional fields with empty strings / zero bytes32", () => {
    const m = makeManifest(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    const payload = prepareEip712Payload(m);
    const authors = payload.authors as Array<Record<string, unknown>>;
    expect(authors[0].name).toBe("");
    expect(authors[0].handle).toBe("");
    expect(authors[0].role).toBe("");
    expect(payload.delegatedAgentId).toBe("0x" + "0".repeat(64));
    expect(payload.notes).toBe("");
  });

  it("preserves populated optional fields", () => {
    const m = makeManifest("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      delegatedAgentId: ("0x" + "1".repeat(64)) as `0x${string}`,
      notes: "Hamilton STAR backend",
      authors: [
        {
          address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          groupBps: 10000,
          name: "Alice",
          handle: "@alice",
          role: "maintainer",
        },
      ],
    });
    const payload = prepareEip712Payload(m);
    const authors = payload.authors as Array<Record<string, unknown>>;
    expect(authors[0].name).toBe("Alice");
    expect(payload.notes).toBe("Hamilton STAR backend");
  });
});
