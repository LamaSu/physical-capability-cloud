import { describe, it, expect } from "vitest";
import { CsdRegistry } from "./registry.js";
import {
  resolveCapabilityContractIdentity,
  resolveContractId,
  computeContractDigest,
  capabilityClassOf,
  CapabilityContractIdentityError,
} from "./capability-contract-identity.js";
import type { CSD } from "./schema.js";

/** A minimal schema-valid CSD; override any field via `over`. */
function csd(url: string, over: Partial<CSD> = {}): CSD {
  return {
    url,
    version: "1.0.0",
    status: "active",
    name: "Test cap",
    description: "a test capability",
    kind: "base",
    baseDefinition: null,
    parameters: [],
    constraints: [],
    pricing: { basePrice: "1.00", currency: "USDC" },
    ...over,
  };
}

describe("M1 — canonical capability-contract identity", () => {
  it("resolves a full url to {class, contractId, digest}", async () => {
    const reg = new CsdRegistry();
    reg.register(csd("pcc://capabilities/fdm/v2"));
    const id = await resolveCapabilityContractIdentity("pcc://capabilities/fdm/v2", reg);
    expect(id.capabilityClass).toBe("fdm");
    expect(id.capabilityContractId).toBe("pcc://capabilities/fdm/v2");
    expect(id.capabilityContractDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("resolves a bare class string to its single registered contract", async () => {
    const reg = new CsdRegistry();
    reg.register(csd("pcc://capabilities/fdm/v2"));
    const id = await resolveCapabilityContractIdentity("fdm", reg);
    expect(id.capabilityContractId).toBe("pcc://capabilities/fdm/v2");
  });

  // THE load-bearing property: identity binds CONTENT, not the mutable url.
  it("digest is stable for identical content, and CHANGES when a url's content is silently overwritten", async () => {
    const reg = new CsdRegistry();
    reg.register(csd("pcc://capabilities/fdm/v2", { pricing: { basePrice: "1.00", currency: "USDC" } }));
    const before = await resolveCapabilityContractIdentity("pcc://capabilities/fdm/v2", reg);
    const again = await resolveCapabilityContractIdentity("pcc://capabilities/fdm/v2", reg);
    expect(again.capabilityContractDigest).toBe(before.capabilityContractDigest); // stable

    // Overwrite the SAME url with different content — the register() mutability hazard.
    reg.register(csd("pcc://capabilities/fdm/v2", { pricing: { basePrice: "999.00", currency: "USDC" } }));
    const after = await resolveCapabilityContractIdentity("pcc://capabilities/fdm/v2", reg);
    expect(after.capabilityContractId).toBe(before.capabilityContractId); // same url (pointer unchanged)
    expect(after.capabilityContractDigest).not.toBe(before.capabilityContractDigest); // digest caught it
  });

  it("digest is insensitive to key insertion order (canonicalized)", async () => {
    const a: CSD = csd("pcc://capabilities/x/v1");
    // Identical content, reversed key order.
    const b = {
      pricing: { currency: "USDC", basePrice: "1.00" },
      constraints: [],
      parameters: [],
      baseDefinition: null,
      kind: "base",
      description: "a test capability",
      name: "Test cap",
      status: "active",
      version: "1.0.0",
      url: "pcc://capabilities/x/v1",
    } as CSD;
    expect(await computeContractDigest(a)).toBe(await computeContractDigest(b));
  });

  it("applies baseDefinition inheritance before hashing (profile digest reflects the resolved contract)", async () => {
    const reg = new CsdRegistry();
    reg.register(csd("pcc://capabilities/base/v1", { pricing: { basePrice: "5.00", currency: "USDC" } }));
    reg.register(
      csd("pcc://capabilities/profile/v1", { kind: "profile", baseDefinition: "pcc://capabilities/base/v1" }),
    );
    // The profile omits pricing-relevant content that inheritance fills in; the
    // digest must be that of the RESOLVED (inherited) doc, not the raw profile.
    const id = await resolveCapabilityContractIdentity("pcc://capabilities/profile/v1", reg);
    const rawDigest = await computeContractDigest(reg.get("pcc://capabilities/profile/v1")!);
    const resolvedDigest = await computeContractDigest(reg.resolve("pcc://capabilities/profile/v1"));
    expect(id.capabilityContractDigest).toBe(resolvedDigest);
    expect(id.capabilityContractDigest).not.toBe(rawDigest);
  });

  it("fails closed on an unresolvable reference", async () => {
    const reg = new CsdRegistry();
    await expect(resolveCapabilityContractIdentity("nonexistent", reg)).rejects.toBeInstanceOf(
      CapabilityContractIdentityError,
    );
  });

  it("fails closed on a full url that is not registered", async () => {
    const reg = new CsdRegistry();
    await expect(resolveCapabilityContractIdentity("pcc://capabilities/fdm/v9", reg)).rejects.toThrow(
      /UNKNOWN_CONTRACT_URL/,
    );
  });

  it("fails closed AMBIGUOUS when a bare class matches multiple active revisions", () => {
    const reg = new CsdRegistry();
    reg.register(csd("pcc://capabilities/fdm/v1"));
    reg.register(csd("pcc://capabilities/fdm/v2"));
    expect(() => resolveContractId("fdm", reg)).toThrow(/AMBIGUOUS_CAPABILITY/);
  });

  it("resolves a class with multiple revisions to the single ACTIVE one", async () => {
    const reg = new CsdRegistry();
    reg.register(csd("pcc://capabilities/fdm/v1", { status: "retired" }));
    reg.register(csd("pcc://capabilities/fdm/v2", { status: "active" }));
    const id = await resolveCapabilityContractIdentity("fdm", reg);
    expect(id.capabilityContractId).toBe("pcc://capabilities/fdm/v2");
  });

  it("capabilityClassOf rejects a malformed url", () => {
    expect(() => capabilityClassOf("not-a-url")).toThrow(/UNRECOGNIZED_CONTRACT_URL/);
    expect(capabilityClassOf("pcc://capabilities/fdm/v2")).toBe("fdm");
  });
});
