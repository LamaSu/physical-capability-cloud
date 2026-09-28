import { describe, it, expect } from "vitest";
import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SIGNING_PREIMAGE_CONTRACT,
  SigningPreimageError,
  isTaggedDigest,
  parseTaggedDigest,
  signingPreimage,
  parseEd25519SignatureHex,
  parseEd25519PublicKeyHex,
  sessionKeyDelegationPreimage,
  sessionRevocationPreimage,
} from "../evidence/signing-preimage.js";
import { canonicalize, hashBundle, hashEvent, sha256 } from "../util/canonical.js";
import type { EvidenceEvent } from "../types/evidence.js";
import type { SessionKey } from "../identity/ephemeral.js";

const DIGEST = "sha256:" + "0123456789abcdef".repeat(4);
const utf8 = (s: string) => new TextEncoder().encode(s);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof SigningPreimageError ? e.code : `non-contract:${String(e)}`;
  }
  return undefined;
}

function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    sign: (msg: Uint8Array) => new Uint8Array(sign(null, msg, privateKey)),
    verify: (msg: Uint8Array, sig: Uint8Array) => verify(null, msg, publicKey, sig),
  };
}

const SESSION: Omit<SessionKey, "parentSignature"> = {
  sessionId: "sess-001",
  parentAgentId: "eip155:84532:0x1111111111111111111111111111111111111111",
  publicKey: new Uint8Array(32).fill(7),
  issuedAt: 1727200000,
  expiresAt: 1727203600,
  scope: {
    allowedActions: ["workflow_step_complete", "evidence_submit"],
    contractIds: ["job-b", "job-a"],
    maxSignatures: 100,
  },
};

/** The exact bytes verifier/ephemeral-identity.ts and kernel-sdk/job-handler.ts build today. */
function incumbentDelegationBytes(sk: Omit<SessionKey, "parentSignature">): Uint8Array {
  const body: Record<string, unknown> = {
    sessionId: sk.sessionId,
    parentAgentId: sk.parentAgentId,
    publicKey: Array.from(sk.publicKey, (b) => b.toString(16).padStart(2, "0")).join(""),
    issuedAt: sk.issuedAt,
    expiresAt: sk.expiresAt,
    scope: {
      allowedActions: [...sk.scope.allowedActions].sort(),
      contractIds: [...sk.scope.contractIds].sort(),
      maxSignatures: sk.scope.maxSignatures,
    },
  };
  if (sk.derivationPath !== undefined) body.derivationPath = sk.derivationPath;
  return utf8(JSON.stringify(body));
}

describe("signing preimage — the tagged-digest signature contract", () => {
  it("names its contract version", () => {
    expect(SIGNING_PREIMAGE_CONTRACT).toBe("pcc.evidence.signing-preimage.v1");
  });

  it("is the UTF-8 of the full tagged digest string (71 bytes), the incumbent convention", () => {
    const bytes = signingPreimage(DIGEST);
    expect(bytes.length).toBe(71);
    expect(Array.from(bytes)).toEqual(Array.from(utf8(DIGEST)));
  });

  it("matches the digests canonical.ts actually produces for a real bundle", async () => {
    const base = { timestamp: "2026-09-24T00:00:00.000Z", source: { deviceId: "d1", kernelId: "k1" } };
    const events = [] as EvidenceEvent[];
    for (const type of ["execution_started", "execution_completed"] as const) {
      const ev = { ...base, type, payload: { jobId: "job-a" } } as unknown as EvidenceEvent;
      ev.hash = await hashEvent(ev);
      events.push(ev);
    }
    const bundleHash = await hashBundle(events);
    expect(isTaggedDigest(bundleHash)).toBe(true);
    expect(Array.from(signingPreimage(bundleHash))).toEqual(Array.from(utf8(bundleHash)));
  });

  it("round-trips a real Ed25519 signature", async () => {
    const key = ed25519();
    const digest = await sha256(canonicalize({ hello: "world" }));
    const sig = key.sign(signingPreimage(digest));
    expect(key.verify(signingPreimage(digest), sig)).toBe(true);
  });

  describe("negative controls", () => {
    it("raw32 vs tagged digest: a signature over the 32 raw bytes never verifies against the preimage", () => {
      const key = ed25519();
      const raw32 = Uint8Array.from(Buffer.from(DIGEST.slice("sha256:".length), "hex"));
      expect(raw32.length).toBe(32);
      const raw32Sig = key.sign(raw32);
      expect(key.verify(signingPreimage(DIGEST), raw32Sig)).toBe(false);
      // and the tagged-digest signature never verifies as a raw32 signature
      const taggedSig = key.sign(signingPreimage(DIGEST));
      expect(key.verify(raw32, taggedSig)).toBe(false);
    });

    it("rejects raw digest bytes as input, deterministically", () => {
      const raw32 = new Uint8Array(32);
      expect(codeOf(() => signingPreimage(raw32))).toBe("raw-digest-bytes");
      expect(codeOf(() => signingPreimage(raw32))).toBe("raw-digest-bytes");
    });

    it("rejects every non-canonical digest form with its own stable code", () => {
      const hex = DIGEST.slice("sha256:".length);
      expect(codeOf(() => parseTaggedDigest("0x" + hex))).toBe("hex-prefixed-digest");
      expect(codeOf(() => parseTaggedDigest("0X" + hex))).toBe("hex-prefixed-digest");
      expect(codeOf(() => parseTaggedDigest(hex))).toBe("missing-sha256-tag");
      expect(codeOf(() => parseTaggedDigest("SHA256:" + hex))).toBe("missing-sha256-tag");
      expect(codeOf(() => parseTaggedDigest("sha256:" + hex.toUpperCase()))).toBe("malformed-tagged-digest");
      expect(codeOf(() => parseTaggedDigest("sha256:" + hex.slice(1)))).toBe("malformed-tagged-digest");
      expect(codeOf(() => parseTaggedDigest("sha256:" + hex + "0"))).toBe("malformed-tagged-digest");
      expect(codeOf(() => parseTaggedDigest("sha256:" + hex.slice(0, 63) + "g"))).toBe("malformed-tagged-digest");
      expect(codeOf(() => parseTaggedDigest(" " + DIGEST))).toBe("missing-sha256-tag");
      expect(codeOf(() => parseTaggedDigest(DIGEST + "\n"))).toBe("malformed-tagged-digest");
      expect(codeOf(() => parseTaggedDigest(undefined))).toBe("not-a-string");
      expect(codeOf(() => parseTaggedDigest(42))).toBe("not-a-string");
      expect(codeOf(() => parseTaggedDigest(DIGEST))).toBeUndefined();
    });

    it("domain separation: the registration challenge the same key signs is never a digest preimage", () => {
      const key = ed25519();
      const challenge = "pcc-kernel-signing-key:kernel-abc";
      const challengeSig = key.sign(utf8(challenge));
      expect(codeOf(() => signingPreimage(challenge))).toBe("missing-sha256-tag");
      expect(key.verify(signingPreimage(DIGEST), challengeSig)).toBe(false);
    });
  });
});

describe("signature and public-key shape parsing", () => {
  const sigHex = "ab".repeat(64);
  const pkHex = "cd".repeat(32);

  it("accepts the incumbent forms: optional 0x, either hex case", () => {
    expect(parseEd25519SignatureHex(sigHex).length).toBe(64);
    expect(parseEd25519SignatureHex("0x" + sigHex.toUpperCase()).length).toBe(64);
    expect(parseEd25519PublicKeyHex(pkHex).length).toBe(32);
    expect(Array.from(parseEd25519PublicKeyHex("0X" + pkHex))).toEqual(new Array(32).fill(0xcd));
  });

  it("rejects malformed signature shapes deterministically", () => {
    expect(codeOf(() => parseEd25519SignatureHex(sigHex.slice(2)))).toBe("malformed-signature");
    expect(codeOf(() => parseEd25519SignatureHex(sigHex + "00"))).toBe("malformed-signature");
    expect(codeOf(() => parseEd25519SignatureHex("zz".repeat(64)))).toBe("malformed-signature");
    expect(codeOf(() => parseEd25519SignatureHex(""))).toBe("malformed-signature");
    expect(codeOf(() => parseEd25519SignatureHex(new Uint8Array(64)))).toBe("malformed-signature");
    expect(codeOf(() => parseEd25519SignatureHex("0x0x" + sigHex.slice(4)))).toBe("malformed-signature");
  });

  it("rejects malformed public keys", () => {
    expect(codeOf(() => parseEd25519PublicKeyHex(pkHex.slice(2)))).toBe("malformed-public-key");
    expect(codeOf(() => parseEd25519PublicKeyHex(sigHex))).toBe("malformed-public-key");
    expect(codeOf(() => parseEd25519PublicKeyHex(null))).toBe("malformed-public-key");
  });
});

describe("session-key delegation preimage", () => {
  it("is byte-identical to the incumbent verifier/kernel-sdk serialization", () => {
    expect(Array.from(sessionKeyDelegationPreimage(SESSION))).toEqual(Array.from(incumbentDelegationBytes(SESSION)));
  });

  it("pins the exact bytes (insertion order, sorted arrays, lowercase hex)", () => {
    expect(new TextDecoder().decode(sessionKeyDelegationPreimage(SESSION))).toBe(
      '{"sessionId":"sess-001","parentAgentId":"eip155:84532:0x1111111111111111111111111111111111111111",' +
        '"publicKey":"' + "07".repeat(32) + '","issuedAt":1727200000,"expiresAt":1727203600,' +
        '"scope":{"allowedActions":["evidence_submit","workflow_step_complete"],"contractIds":["job-a","job-b"],"maxSignatures":100}}',
    );
  });

  it("includes derivationPath only when defined, appended last", () => {
    const derived = { ...SESSION, derivationPath: "m/44'/0'/0'" };
    const text = new TextDecoder().decode(sessionKeyDelegationPreimage(derived));
    expect(text.endsWith(',"derivationPath":"m/44\'/0\'/0\'"}')).toBe(true);
    expect(Array.from(sessionKeyDelegationPreimage({ ...SESSION, derivationPath: undefined }))).toEqual(
      Array.from(sessionKeyDelegationPreimage(SESSION)),
    );
    // An explicitly empty path is refused before any signature check (R20 round 2):
    // the pre-contract gateway dropped it by truthiness, so it never verified there.
    expect(codeOf(() => sessionKeyDelegationPreimage({ ...SESSION, derivationPath: "" }))).toBe("malformed-session-key");
  });

  it("does not depend on the caller's array order", () => {
    const shuffled = {
      ...SESSION,
      scope: { ...SESSION.scope, allowedActions: ["evidence_submit", "workflow_step_complete"], contractIds: ["job-a", "job-b"] },
    };
    expect(Array.from(sessionKeyDelegationPreimage(shuffled))).toEqual(Array.from(sessionKeyDelegationPreimage(SESSION)));
  });

  it("round-trips a real principal signature", () => {
    const principal = ed25519();
    const sig = principal.sign(sessionKeyDelegationPreimage(SESSION));
    expect(principal.verify(sessionKeyDelegationPreimage(SESSION), sig)).toBe(true);
  });

  describe("negative controls", () => {
    it("a sorted-key (canonicalize) serialization is a different preimage and its signature never verifies", () => {
      const principal = ed25519();
      const sortedKeyBytes = utf8(
        canonicalize({
          sessionId: SESSION.sessionId,
          parentAgentId: SESSION.parentAgentId,
          publicKey: "07".repeat(32),
          issuedAt: SESSION.issuedAt,
          expiresAt: SESSION.expiresAt,
          scope: {
            allowedActions: [...SESSION.scope.allowedActions].sort(),
            contractIds: [...SESSION.scope.contractIds].sort(),
            maxSignatures: SESSION.scope.maxSignatures,
          },
        }),
      );
      expect(Array.from(sortedKeyBytes)).not.toEqual(Array.from(sessionKeyDelegationPreimage(SESSION)));
      const sortedKeySig = principal.sign(sortedKeyBytes);
      expect(principal.verify(sessionKeyDelegationPreimage(SESSION), sortedKeySig)).toBe(false);
    });

    it("widening the scope after signing breaks the principal signature", () => {
      const principal = ed25519();
      const sig = principal.sign(sessionKeyDelegationPreimage(SESSION));
      const widened = { ...SESSION, scope: { ...SESSION.scope, contractIds: [...SESSION.scope.contractIds, "job-c"] } };
      expect(principal.verify(sessionKeyDelegationPreimage(widened), sig)).toBe(false);
      const extended = { ...SESSION, expiresAt: SESSION.expiresAt + 1 };
      expect(principal.verify(sessionKeyDelegationPreimage(extended), sig)).toBe(false);
    });

    it("rejects malformed session keys", () => {
      const bad = (patch: Record<string, unknown>) => ({ ...SESSION, ...patch }) as Omit<SessionKey, "parentSignature">;
      expect(codeOf(() => sessionKeyDelegationPreimage(bad({ publicKey: new Uint8Array(31) })))).toBe("malformed-session-key");
      expect(codeOf(() => sessionKeyDelegationPreimage(bad({ publicKey: "07".repeat(32) })))).toBe("malformed-session-key");
      expect(codeOf(() => sessionKeyDelegationPreimage(bad({ expiresAt: 1.5 })))).toBe("malformed-session-key");
      expect(codeOf(() => sessionKeyDelegationPreimage(bad({ issuedAt: Number.NaN })))).toBe("malformed-session-key");
      expect(codeOf(() => sessionKeyDelegationPreimage(bad({ expiresAt: -1 })))).toBe("malformed-session-key");
      expect(
        codeOf(() => sessionKeyDelegationPreimage(bad({ scope: { ...SESSION.scope, maxSignatures: Infinity } }))),
      ).toBe("malformed-session-key");
      expect(
        codeOf(() => sessionKeyDelegationPreimage(bad({ scope: { ...SESSION.scope, contractIds: ["ok", 7] } }))),
      ).toBe("malformed-session-key");
      expect(codeOf(() => sessionKeyDelegationPreimage(bad({ derivationPath: 44 })))).toBe("malformed-session-key");
      expect(codeOf(() => sessionKeyDelegationPreimage(bad({ derivationPath: null })))).toBe("malformed-session-key");
    });

    it("rejects sparse and prototype-backed scope arrays instead of serializing holes as null", () => {
      const bad = (patch: Record<string, unknown>) => ({ ...SESSION, ...patch }) as Omit<SessionKey, "parentSignature">;
      const sparse = ["job-a"];
      sparse.length = 2; // a hole at index 1: every() would skip it and JSON.stringify would write null
      expect(codeOf(() => sessionKeyDelegationPreimage(bad({ scope: { ...SESSION.scope, contractIds: sparse } })))).toBe(
        "malformed-session-key",
      );
      const inherited = new Array<string>(1); // index 0 exists only on the prototype
      Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: "evidence_submit" }));
      expect(
        codeOf(() => sessionKeyDelegationPreimage(bad({ scope: { ...SESSION.scope, allowedActions: inherited } }))),
      ).toBe("malformed-session-key");
    });
  });
});

/**
 * Cross-language lock: the committed goldens (generated by
 * packages/pcc-node/tests/gen_goldens.mjs and reproduced by pynacl in
 * test_signing_preimage_parity.py) must also be reproduced by THIS helper.
 */
describe("cross-language goldens (packages/pcc-node/tests/goldens.json)", () => {
  const goldens = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../pcc-node/tests/goldens.json", import.meta.url)), "utf8"),
  );
  const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
  const verifyHex = (publicKeyHex: string, msg: Uint8Array, sigHex: string) =>
    verify(
      null,
      msg,
      createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" }),
      Buffer.from(sigHex, "hex"),
    );
  const sessionOf = (g: { session: Record<string, unknown> }) => {
    const { publicKeyHex, ...rest } = g.session as { publicKeyHex: string } & Record<string, unknown>;
    return { ...rest, publicKey: Uint8Array.from(Buffer.from(publicKeyHex, "hex")) } as unknown as Omit<SessionKey, "parentSignature">;
  };

  it("reproduces every signing_preimage vector, and only the tagged signature verifies", () => {
    expect(goldens.signing_preimage.length).toBeGreaterThanOrEqual(3);
    for (const g of goldens.signing_preimage) {
      const preimage = signingPreimage(g.digest);
      expect(Buffer.from(preimage).toString("hex")).toBe(g.preimage_hex);
      expect(verifyHex(g.signer_public_key_hex, preimage, g.signature_hex)).toBe(true);
      expect(verifyHex(g.signer_public_key_hex, preimage, g.raw32_signature_hex)).toBe(false);
    }
  });

  it("agrees with every accept/reject parity vector, decoding the JSON text itself", () => {
    // The vectors are JSON TEXT: JSON.parse is part of the pinned boundary, so
    // 1.0 and 1e2 are integers here exactly as json.loads' floats are in Python.
    const outcome = (v: { kind: string; json: string }): string => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(v.json);
      } catch {
        return "REJECT";
      }
      try {
        if (v.kind === "revocation") {
          return new TextDecoder().decode(sessionRevocationPreimage(parsed as never));
        }
        const { publicKeyHex, ...rest } = parsed as { publicKeyHex: unknown } & Record<string, unknown>;
        const session = { ...rest, publicKey: parseEd25519PublicKeyHex(publicKeyHex) };
        return new TextDecoder().decode(sessionKeyDelegationPreimage(session as never));
      } catch (e) {
        if (!(e instanceof SigningPreimageError)) throw e;
        return "REJECT";
      }
    };
    expect(goldens.parity_vectors.length).toBeGreaterThanOrEqual(27);
    for (const v of goldens.parity_vectors) {
      expect({ name: v.name, got: outcome(v) }).toEqual({ name: v.name, got: v.reject ? "REJECT" : v.preimage_utf8 });
    }
  });

  it("reproduces every session_delegation vector, and the sorted-key signature never verifies", () => {
    expect(goldens.session_delegation.length).toBeGreaterThanOrEqual(3);
    for (const g of goldens.session_delegation) {
      const preimage = sessionKeyDelegationPreimage(sessionOf(g));
      expect(new TextDecoder().decode(preimage)).toBe(g.preimage_utf8);
      expect(verifyHex(g.principal_public_key_hex, preimage, g.parent_signature_hex)).toBe(true);
      expect(g.sorted_key_preimage_utf8).not.toBe(g.preimage_utf8);
      expect(verifyHex(g.principal_public_key_hex, preimage, g.sorted_key_signature_hex)).toBe(false);
    }
  });

  it("reproduces the session_revocation vector", () => {
    for (const g of goldens.session_revocation) {
      const preimage = sessionRevocationPreimage(g.revocation);
      expect(new TextDecoder().decode(preimage)).toBe(g.preimage_utf8);
      expect(verifyHex(g.principal_public_key_hex, preimage, g.parent_signature_hex)).toBe(true);
    }
  });
});

describe("session revocation preimage", () => {
  it("is the incumbent fixed-order JSON", () => {
    const text = new TextDecoder().decode(
      sessionRevocationPreimage({ sessionId: "sess-001", revokedAt: 1727201000, reason: "rotated" }),
    );
    expect(text).toBe('{"sessionId":"sess-001","revokedAt":1727201000,"reason":"rotated"}');
  });

  it("rejects malformed revocations", () => {
    expect(
      codeOf(() => sessionRevocationPreimage({ sessionId: "s", revokedAt: 1.5, reason: "x" })),
    ).toBe("malformed-revocation");
  });
});
