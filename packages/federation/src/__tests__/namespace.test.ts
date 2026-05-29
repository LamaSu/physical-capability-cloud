import { describe, expect, it } from "vitest";
import {
  buildDefaultPccPublicNamespace,
  DEFAULT_PCC_PUBLIC_NAMESPACE_ID,
  evaluateNamespaceAcl,
  type Namespace,
} from "../namespace.js";

function ns(over: Partial<Namespace> = {}): Namespace {
  return {
    id: "test-ns",
    displayName: "Test Namespace",
    description: "for tests",
    ownerDid: "did:pcc:owner",
    visibility: "tenant-private",
    createdAt: "2026-05-25T00:00:00.000Z",
    createdInRegion: "us-east-1",
    acl: {
      "did:pcc:owner": "owner",
    },
    aclVectorClock: { ticks: {} },
    ...over,
  };
}

describe("evaluateNamespaceAcl", () => {
  it("public read allowed without a principal", () => {
    const r = evaluateNamespaceAcl(
      ns({ visibility: "public" }),
      undefined,
      "read",
    );
    expect(r.allowed).toBe(true);
  });

  it("public write requires principal in ACL", () => {
    const pubNs = ns({ visibility: "public" });
    expect(evaluateNamespaceAcl(pubNs, undefined, "write").allowed).toBe(false);
    expect(
      evaluateNamespaceAcl(pubNs, "did:pcc:owner", "write").allowed,
    ).toBe(true);
  });

  it("denies tenant-private read without a principal", () => {
    const r = evaluateNamespaceAcl(ns(), undefined, "read");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("no_principal");
  });

  it("denies tenant-private read when principal is not in ACL", () => {
    const r = evaluateNamespaceAcl(ns(), "did:pcc:stranger", "read");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("principal_not_in_acl");
  });

  it("hides pcc-internal namespaces from non-ACL principals", () => {
    const r = evaluateNamespaceAcl(
      ns({ visibility: "pcc-internal" }),
      "did:pcc:stranger",
      "read",
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("namespace_invisible");
  });

  it("owner has all permissions", () => {
    const n = ns();
    expect(evaluateNamespaceAcl(n, "did:pcc:owner", "read").allowed).toBe(true);
    expect(evaluateNamespaceAcl(n, "did:pcc:owner", "write").allowed).toBe(true);
    expect(evaluateNamespaceAcl(n, "did:pcc:owner", "admin").allowed).toBe(true);
  });

  it("writer can write but not admin", () => {
    const n = ns({ acl: { "did:pcc:writer": "writer" } });
    expect(evaluateNamespaceAcl(n, "did:pcc:writer", "read").allowed).toBe(true);
    expect(evaluateNamespaceAcl(n, "did:pcc:writer", "write").allowed).toBe(true);
    const adm = evaluateNamespaceAcl(n, "did:pcc:writer", "admin");
    expect(adm.allowed).toBe(false);
    expect(adm.reason).toBe("insufficient_role");
  });

  it("reader can read but not write or admin", () => {
    const n = ns({ acl: { "did:pcc:reader": "reader" } });
    expect(evaluateNamespaceAcl(n, "did:pcc:reader", "read").allowed).toBe(true);
    expect(evaluateNamespaceAcl(n, "did:pcc:reader", "write").allowed).toBe(false);
    expect(evaluateNamespaceAcl(n, "did:pcc:reader", "admin").allowed).toBe(false);
  });
});

describe("buildDefaultPccPublicNamespace", () => {
  it("creates a public namespace with the canonical id", () => {
    const n = buildDefaultPccPublicNamespace({
      createdInRegion: "us-east-1",
      ownerDid: "did:pcc:pcc",
    });
    expect(n.id).toBe(DEFAULT_PCC_PUBLIC_NAMESPACE_ID);
    expect(n.visibility).toBe("public");
    expect(n.acl["did:pcc:pcc"]).toBe("owner");
  });

  it("publicly readable without a principal", () => {
    const n = buildDefaultPccPublicNamespace({
      createdInRegion: "us-east-1",
      ownerDid: "did:pcc:pcc",
    });
    expect(evaluateNamespaceAcl(n, undefined, "read").allowed).toBe(true);
  });
});
