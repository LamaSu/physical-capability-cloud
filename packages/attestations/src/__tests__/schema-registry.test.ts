import { describe, it, expect, vi } from "vitest";
import { decodeAbiParameters, keccak256, encodePacked } from "viem";
import {
  SchemaRegistryClient,
  computeSchemaUID,
  parseSchemaString,
  encodeSchemaData,
  decodeSchemaData,
} from "../schema-registry.js";
import { ZERO_ADDRESS, ZERO_BYTES32 } from "../constants.js";

describe("computeSchemaUID", () => {
  it("is deterministic — same inputs give same UID", () => {
    const schema = "address user,uint256 amount";
    const uid1 = computeSchemaUID(schema, ZERO_ADDRESS, true);
    const uid2 = computeSchemaUID(schema, ZERO_ADDRESS, true);
    expect(uid1).toBe(uid2);
  });

  it("differs when schema string differs", () => {
    const a = computeSchemaUID("uint8 tier", ZERO_ADDRESS, true);
    const b = computeSchemaUID("uint16 tier", ZERO_ADDRESS, true);
    expect(a).not.toBe(b);
  });

  it("differs when revocable flag differs", () => {
    const a = computeSchemaUID("uint8 tier", ZERO_ADDRESS, true);
    const b = computeSchemaUID("uint8 tier", ZERO_ADDRESS, false);
    expect(a).not.toBe(b);
  });

  it("matches manual keccak256(encodePacked(...)) derivation", () => {
    const schema = "address foo";
    const resolver = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const revocable = true;
    const manual = keccak256(
      encodePacked(["string", "address", "bool"], [schema, resolver, revocable]),
    );
    expect(computeSchemaUID(schema, resolver, revocable)).toBe(manual);
  });
});

describe("parseSchemaString", () => {
  it("parses a single field", () => {
    expect(parseSchemaString("uint8 tier")).toEqual([
      { type: "uint8", name: "tier" },
    ]);
  });

  it("parses multiple comma-separated fields", () => {
    expect(
      parseSchemaString("address bridgeMaintainer,uint8 tier,bytes32 evidenceCID"),
    ).toEqual([
      { type: "address", name: "bridgeMaintainer" },
      { type: "uint8", name: "tier" },
      { type: "bytes32", name: "evidenceCID" },
    ]);
  });

  it("tolerates extra whitespace", () => {
    expect(parseSchemaString("  uint8  tier  ,   address  foo   ")).toEqual([
      { type: "uint8", name: "tier" },
      { type: "address", name: "foo" },
    ]);
  });

  it("throws on empty schema string", () => {
    expect(() => parseSchemaString("")).toThrow(/empty/);
    expect(() => parseSchemaString("   ")).toThrow(/empty/);
  });

  it("throws on malformed field", () => {
    expect(() => parseSchemaString("uint8")).toThrow(/Invalid schema field/);
    expect(() => parseSchemaString("uint8 tier extra")).toThrow(
      /Invalid schema field/,
    );
  });
});

describe("encodeSchemaData / decodeSchemaData", () => {
  it("encodes and decodes a simple payload (roundtrip)", () => {
    const schema = "address user,uint256 amount";
    const data = {
      user: "0x1111111111111111111111111111111111111111" as `0x${string}`,
      amount: 42n,
    };
    const encoded = encodeSchemaData(schema, data);
    expect(encoded.startsWith("0x")).toBe(true);
    const decoded = decodeSchemaData(schema, encoded);
    expect(decoded.user).toBe(data.user);
    expect(decoded.amount).toBe(42n);
  });

  it("encodes string fields correctly (matches viem decodeAbiParameters)", () => {
    const schema = "string note,uint8 score";
    const encoded = encodeSchemaData(schema, { note: "good work", score: 95 });
    // Verify with a fresh decode
    const decoded = decodeAbiParameters(
      [{ type: "string" }, { type: "uint8" }],
      encoded,
    );
    expect(decoded[0]).toBe("good work");
    expect(decoded[1]).toBe(95);
  });

  it("throws if data is missing a schema field", () => {
    expect(() =>
      encodeSchemaData("uint8 tier,address who", { tier: 2 }),
    ).toThrow(/Missing data field "who"/);
  });

  it("ignores extra data fields not in the schema", () => {
    const schema = "uint8 tier";
    // Extra `note` is silently ignored
    const encoded = encodeSchemaData(schema, { tier: 2, note: "ignored" });
    const decoded = decodeSchemaData(schema, encoded);
    expect(decoded.tier).toBe(2);
    expect("note" in decoded).toBe(false);
  });
});

describe("SchemaRegistryClient", () => {
  it("looks up Schema Registry address by chain ID", () => {
    const client = new SchemaRegistryClient({
      chainId: 8453,
      rpcUrl: "http://localhost",
    });
    expect(client.address).toBe("0x4200000000000000000000000000000000000020");
  });

  it("returns null when getSchema hits an unregistered UID", async () => {
    const mockPublicClient = {
      readContract: vi.fn().mockResolvedValue({
        uid: ZERO_BYTES32,
        resolver: "0x0000000000000000000000000000000000000000",
        revocable: false,
        schema: "",
      }),
    };
    const client = new SchemaRegistryClient({
      chainId: 8453,
      rpcUrl: "x",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicClient: mockPublicClient as any,
    });
    expect(
      await client.getSchema(("0x" + "ff".repeat(32)) as `0x${string}`),
    ).toBeNull();
  });

  it("returns a typed AttestationSchema when getSchema hits a registered UID", async () => {
    const uid = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const mockPublicClient = {
      readContract: vi.fn().mockResolvedValue({
        uid,
        resolver: "0x0000000000000000000000000000000000000000",
        revocable: true,
        schema: "uint8 tier",
      }),
    };
    const client = new SchemaRegistryClient({
      chainId: 8453,
      rpcUrl: "x",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicClient: mockPublicClient as any,
    });
    const s = await client.getSchema(uid);
    expect(s).not.toBeNull();
    expect(s!.schema).toBe("uint8 tier");
    expect(s!.revocable).toBe(true);
  });
});
