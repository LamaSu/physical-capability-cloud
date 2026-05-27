import { describe, it, expect, vi } from "vitest";
import { EASClient } from "../eas-client.js";
import { EAS_DEPLOYMENTS, ZERO_BYTES32 } from "../constants.js";

describe("EASClient", () => {
  it("looks up the EAS address from chain ID", () => {
    const client = new EASClient({
      chainId: 8453,
      rpcUrl: "https://mainnet.base.org",
    });
    expect(client.address).toBe(EAS_DEPLOYMENTS[8453]!.eas);
  });

  it("uses an injected EAS address override", () => {
    const custom = "0x1234567890123456789012345678901234567890" as const;
    const client = new EASClient({
      chainId: 8453,
      rpcUrl: "https://mainnet.base.org",
      easAddress: custom,
    });
    expect(client.address).toBe(custom);
  });

  it("throws when chainId is unsupported and no override is given", () => {
    expect(
      () => new EASClient({ chainId: 99999999, rpcUrl: "http://localhost" }),
    ).toThrow(/EAS not deployed/);
  });

  it("requires either publicClient or rpcUrl", () => {
    // @ts-expect-error — testing runtime behavior
    expect(() => new EASClient({ chainId: 8453 })).toThrow(
      /publicClient|rpcUrl/,
    );
  });

  it("returns null when getAttestation hits a non-existent UID (zero-filled struct)", async () => {
    const mockPublicClient = {
      readContract: vi.fn().mockResolvedValue({
        uid: ZERO_BYTES32,
        schema: ZERO_BYTES32,
        time: 0n,
        expirationTime: 0n,
        revocationTime: 0n,
        refUID: ZERO_BYTES32,
        recipient: "0x0000000000000000000000000000000000000000",
        attester: "0x0000000000000000000000000000000000000000",
        revocable: false,
        data: "0x",
      }),
    };
    const client = new EASClient({
      chainId: 8453,
      rpcUrl: "x",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicClient: mockPublicClient as any,
    });
    const att = await client.getAttestation(("0x" + "ab".repeat(32)) as `0x${string}`);
    expect(att).toBeNull();
  });

  it("returns a hydrated attestation when getAttestation hits a real UID", async () => {
    const expectedUID = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const mockPublicClient = {
      readContract: vi.fn().mockResolvedValue({
        uid: expectedUID,
        schema: ("0x" + "cd".repeat(32)) as `0x${string}`,
        time: 1700000000n,
        expirationTime: 0n,
        revocationTime: 0n,
        refUID: ZERO_BYTES32,
        recipient: "0x1111111111111111111111111111111111111111",
        attester: "0x2222222222222222222222222222222222222222",
        revocable: true,
        data: "0xdeadbeef",
      }),
    };
    const client = new EASClient({
      chainId: 8453,
      rpcUrl: "x",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicClient: mockPublicClient as any,
    });
    const att = await client.getAttestation(expectedUID);
    expect(att).not.toBeNull();
    expect(att!.uid).toBe(expectedUID);
    expect(att!.time).toBe(1700000000n);
    expect(att!.revocable).toBe(true);
    expect(att!.data).toBe("0xdeadbeef");
  });

  it("isValid returns false for revoked attestations", async () => {
    const uid = ("0x" + "11".repeat(32)) as `0x${string}`;
    const mockPublicClient = {
      readContract: vi
        .fn()
        // isAttestationValid → true
        .mockResolvedValueOnce(true)
        // getAttestation → revoked
        .mockResolvedValueOnce({
          uid,
          schema: ZERO_BYTES32,
          time: 1700000000n,
          expirationTime: 0n,
          revocationTime: 1700000500n, // revoked
          refUID: ZERO_BYTES32,
          recipient: "0x1111111111111111111111111111111111111111",
          attester: "0x2222222222222222222222222222222222222222",
          revocable: true,
          data: "0x",
        }),
    };
    const client = new EASClient({
      chainId: 8453,
      rpcUrl: "x",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicClient: mockPublicClient as any,
    });
    expect(await client.isValid(uid)).toBe(false);
  });

  it("isValid returns false for expired attestations", async () => {
    const uid = ("0x" + "22".repeat(32)) as `0x${string}`;
    const past = BigInt(Math.floor(Date.now() / 1000) - 3600); // 1 hour ago
    const mockPublicClient = {
      readContract: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({
          uid,
          schema: ZERO_BYTES32,
          time: past - 100n,
          expirationTime: past,
          revocationTime: 0n,
          refUID: ZERO_BYTES32,
          recipient: "0x1111111111111111111111111111111111111111",
          attester: "0x2222222222222222222222222222222222222222",
          revocable: true,
          data: "0x",
        }),
    };
    const client = new EASClient({
      chainId: 8453,
      rpcUrl: "x",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicClient: mockPublicClient as any,
    });
    expect(await client.isValid(uid)).toBe(false);
  });

  it("isValid returns true for a live, non-revoked attestation", async () => {
    const uid = ("0x" + "33".repeat(32)) as `0x${string}`;
    const future = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour out
    const mockPublicClient = {
      readContract: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({
          uid,
          schema: ZERO_BYTES32,
          time: 1700000000n,
          expirationTime: future,
          revocationTime: 0n,
          refUID: ZERO_BYTES32,
          recipient: "0x1111111111111111111111111111111111111111",
          attester: "0x2222222222222222222222222222222222222222",
          revocable: true,
          data: "0x",
        }),
    };
    const client = new EASClient({
      chainId: 8453,
      rpcUrl: "x",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicClient: mockPublicClient as any,
    });
    expect(await client.isValid(uid)).toBe(true);
  });

  it("getAttestationsByRecipient hydrates each log via getAttestation", async () => {
    const recipient = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa" as `0x${string}`;
    const uid1 = ("0x" + "01".repeat(32)) as `0x${string}`;
    const uid2 = ("0x" + "02".repeat(32)) as `0x${string}`;

    const mockPublicClient = {
      getLogs: vi.fn().mockResolvedValue([
        { args: { uid: uid1 } },
        { args: { uid: uid2 } },
      ]),
      readContract: vi
        .fn()
        .mockResolvedValueOnce({
          uid: uid1,
          schema: ZERO_BYTES32,
          time: 100n,
          expirationTime: 0n,
          revocationTime: 0n,
          refUID: ZERO_BYTES32,
          recipient,
          attester: "0x2222222222222222222222222222222222222222",
          revocable: true,
          data: "0x01",
        })
        .mockResolvedValueOnce({
          uid: uid2,
          schema: ZERO_BYTES32,
          time: 200n,
          expirationTime: 0n,
          revocationTime: 0n,
          refUID: ZERO_BYTES32,
          recipient,
          attester: "0x2222222222222222222222222222222222222222",
          revocable: true,
          data: "0x02",
        }),
    };
    const client = new EASClient({
      chainId: 8453,
      rpcUrl: "x",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicClient: mockPublicClient as any,
    });
    const all = await client.getAttestationsByRecipient(recipient);
    expect(all).toHaveLength(2);
    expect(all[0]!.uid).toBe(uid1);
    expect(all[1]!.uid).toBe(uid2);
  });
});
