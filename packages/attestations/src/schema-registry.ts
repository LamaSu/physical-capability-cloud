/**
 * EAS Schema Registry helpers.
 *
 * Schemas are global, on-chain definitions of the data shape an attestation
 * carries. A schema UID is keccak256(abi.encode(schema, resolver, revocable)).
 * Once registered, the UID is permanent and reusable by any attester.
 *
 * This module exposes:
 *  - SchemaRegistryClient: read-only schema fetch (registration is a deploy step)
 *  - computeSchemaUID: pure helper to derive UIDs locally
 *  - parseSchemaString / encodeSchemaData: ABI-encode payloads matching a schema
 */

import {
  createPublicClient,
  encodeAbiParameters,
  decodeAbiParameters,
  http,
  keccak256,
  encodePacked,
  type PublicClient,
} from "viem";
import { schemaRegistryAbi } from "./abis.js";
import { getEASDeployment, ZERO_ADDRESS } from "./constants.js";
import type { AttestationSchema } from "./types.js";

export interface SchemaRegistryClientOptions {
  chainId: number;
  rpcUrl?: string;
  /** Override Schema Registry contract address (otherwise looked up by chainId) */
  registryAddress?: `0x${string}`;
  publicClient?: PublicClient;
}

export class SchemaRegistryClient {
  readonly chainId: number;
  readonly address: `0x${string}`;
  private readonly publicClient: PublicClient;

  constructor(options: SchemaRegistryClientOptions) {
    this.chainId = options.chainId;
    this.address = options.registryAddress ?? getEASDeployment(options.chainId).schemaRegistry;

    if (options.publicClient) {
      this.publicClient = options.publicClient;
    } else {
      if (!options.rpcUrl) {
        throw new Error("SchemaRegistryClient requires either { publicClient } or { rpcUrl }");
      }
      this.publicClient = createPublicClient({ transport: http(options.rpcUrl) });
    }
  }

  /**
   * Fetch a registered schema by UID. Returns null if not registered
   * (Schema Registry returns a zero-filled struct).
   */
  async getSchema(uid: `0x${string}`): Promise<AttestationSchema | null> {
    const raw = (await this.publicClient.readContract({
      address: this.address,
      abi: schemaRegistryAbi,
      functionName: "getSchema",
      args: [uid],
    })) as {
      uid: `0x${string}`;
      resolver: `0x${string}`;
      revocable: boolean;
      schema: string;
    };

    if (
      raw.uid === "0x0000000000000000000000000000000000000000000000000000000000000000"
    ) {
      return null;
    }

    return {
      uid: raw.uid,
      schema: raw.schema,
      resolver: raw.resolver,
      revocable: raw.revocable,
    };
  }
}

/**
 * Compute a schema UID locally (deterministic — matches the Schema Registry's
 * UID derivation). Useful for predicting UIDs before registration.
 *
 * UID = keccak256(abi.encodePacked(schema, resolver, revocable))
 */
export function computeSchemaUID(
  schema: string,
  resolver: `0x${string}` = ZERO_ADDRESS,
  revocable = true,
): `0x${string}` {
  return keccak256(encodePacked(["string", "address", "bool"], [schema, resolver, revocable]));
}

/**
 * Represents one field in a parsed schema string.
 * Schema strings look like: "address bridgeMaintainer,uint8 tier,bytes32 evidenceCID"
 */
export interface SchemaField {
  type: string;
  name: string;
}

/**
 * Parse an EAS schema string into typed fields.
 * EAS schemas are comma-separated "type name" pairs. Whitespace tolerant.
 *
 * @throws if any field is missing a type or a name
 */
export function parseSchemaString(schema: string): SchemaField[] {
  const fields = schema
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  if (fields.length === 0) {
    throw new Error("Schema string is empty");
  }

  return fields.map((field) => {
    const parts = field.split(/\s+/);
    if (parts.length !== 2) {
      throw new Error(
        `Invalid schema field: "${field}" — expected "<type> <name>" (got ${parts.length} parts)`,
      );
    }
    const [type, name] = parts as [string, string];
    if (!type || !name) {
      throw new Error(`Invalid schema field: "${field}"`);
    }
    return { type, name };
  });
}

/**
 * ABI-encode an attestation data payload according to a schema string.
 *
 * The schema string is parsed into ordered fields; the data object must
 * supply a value for each field name (extra keys ignored, missing keys throw).
 */
export function encodeSchemaData(
  schema: string,
  data: Record<string, unknown>,
): `0x${string}` {
  const fields = parseSchemaString(schema);
  const types = fields.map((f) => ({ type: f.type, name: f.name }));
  const values: unknown[] = fields.map((f) => {
    if (!(f.name in data)) {
      throw new Error(`Missing data field "${f.name}" (schema requires ${f.type})`);
    }
    return data[f.name];
  });
  return encodeAbiParameters(types, values);
}

/**
 * Decode an ABI-encoded attestation data payload back into a typed object.
 */
export function decodeSchemaData(
  schema: string,
  encoded: `0x${string}`,
): Record<string, unknown> {
  const fields = parseSchemaString(schema);
  const types = fields.map((f) => ({ type: f.type, name: f.name }));
  const decoded = decodeAbiParameters(types, encoded);
  const out: Record<string, unknown> = {};
  fields.forEach((f, i) => {
    out[f.name] = decoded[i];
  });
  return out;
}
