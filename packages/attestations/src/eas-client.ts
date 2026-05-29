/**
 * Read-only client for the EAS (Ethereum Attestation Service) contract.
 *
 * Wraps viem PublicClient to fetch attestations by UID and to scan
 * `Attested` event logs filtered by recipient/schema.
 */

import { createPublicClient, http, type PublicClient } from "viem";
import { easAbi } from "./abis.js";
import { getEASDeployment, ZERO_BYTES32 } from "./constants.js";
import type { Attestation } from "./types.js";

export interface EASClientOptions {
  chainId: number;
  rpcUrl: string;
  /** Override the EAS contract address (otherwise looked up by chainId) */
  easAddress?: `0x${string}`;
  /** Inject a pre-built viem PublicClient (for testing or shared transport) */
  publicClient?: PublicClient;
}

export class EASClient {
  readonly chainId: number;
  readonly address: `0x${string}`;
  private readonly publicClient: PublicClient;

  constructor(options: EASClientOptions) {
    this.chainId = options.chainId;

    if (options.easAddress) {
      this.address = options.easAddress;
    } else {
      this.address = getEASDeployment(options.chainId).eas;
    }

    if (options.publicClient) {
      this.publicClient = options.publicClient;
    } else {
      if (!options.rpcUrl) {
        throw new Error("EASClient requires either { publicClient } or { rpcUrl }");
      }
      this.publicClient = createPublicClient({
        transport: http(options.rpcUrl),
      });
    }
  }

  /**
   * Fetch a single attestation by UID. Returns null if the attestation
   * does not exist (EAS returns a zero-filled struct in that case).
   */
  async getAttestation(uid: `0x${string}`): Promise<Attestation | null> {
    const raw = (await this.publicClient.readContract({
      address: this.address,
      abi: easAbi,
      functionName: "getAttestation",
      args: [uid],
    })) as {
      uid: `0x${string}`;
      schema: `0x${string}`;
      time: bigint;
      expirationTime: bigint;
      revocationTime: bigint;
      refUID: `0x${string}`;
      recipient: `0x${string}`;
      attester: `0x${string}`;
      revocable: boolean;
      data: `0x${string}`;
    };

    // Non-existent attestations return a zero-filled struct
    if (raw.uid === ZERO_BYTES32) return null;

    return {
      uid: raw.uid,
      schema: raw.schema,
      refUID: raw.refUID,
      time: raw.time,
      expirationTime: raw.expirationTime,
      revocationTime: raw.revocationTime,
      recipient: raw.recipient,
      attester: raw.attester,
      revocable: raw.revocable,
      data: raw.data,
    };
  }

  /**
   * Check on-chain validity (exists, not revoked, not expired) for a UID.
   * Note: EAS.isAttestationValid only checks existence; expiry/revocation
   * are computed in this method.
   */
  async isValid(uid: `0x${string}`): Promise<boolean> {
    const exists = (await this.publicClient.readContract({
      address: this.address,
      abi: easAbi,
      functionName: "isAttestationValid",
      args: [uid],
    })) as boolean;

    if (!exists) return false;

    const att = await this.getAttestation(uid);
    if (!att) return false;
    if (att.revocationTime > 0n) return false;
    if (att.expirationTime > 0n && att.expirationTime < BigInt(Math.floor(Date.now() / 1000))) {
      return false;
    }
    return true;
  }

  /**
   * Scan `Attested` event logs for attestations matching a recipient
   * (and optionally a schema UID). Returns hydrated Attestation objects.
   *
   * NOTE: This is an O(events) scan via getLogs. For production indexing
   * use TheGraph or an EAS indexer instead. Bounded by `fromBlock`/`toBlock`.
   */
  async getAttestationsByRecipient(
    recipient: `0x${string}`,
    schema?: `0x${string}`,
    options: { fromBlock?: bigint; toBlock?: bigint | "latest" } = {},
  ): Promise<Attestation[]> {
    const logs = await this.publicClient.getLogs({
      address: this.address,
      event: {
        type: "event",
        name: "Attested",
        inputs: [
          { indexed: true, name: "recipient", type: "address" },
          { indexed: true, name: "attester", type: "address" },
          { indexed: false, name: "uid", type: "bytes32" },
          { indexed: true, name: "schemaUID", type: "bytes32" },
        ],
      },
      args: schema ? { recipient, schemaUID: schema } : { recipient },
      fromBlock: options.fromBlock ?? 0n,
      toBlock: options.toBlock ?? "latest",
    });

    const attestations: Attestation[] = [];
    for (const log of logs) {
      const uid = (log.args as { uid?: `0x${string}` }).uid;
      if (!uid) continue;
      const att = await this.getAttestation(uid);
      if (att) attestations.push(att);
    }

    return attestations;
  }
}
