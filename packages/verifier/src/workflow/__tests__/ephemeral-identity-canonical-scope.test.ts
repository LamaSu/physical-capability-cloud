/**
 * Canonical scope for issued session keys (answers #361 E7 F4).
 *
 * scope.allowedActions and scope.contractIds are SETS in meaning but ARRAYS on
 * the wire. #361 commits sessionKeyAuthDigest = sha256(canonicalize(
 * SessionKeyAuthorization)), so unless the issuer emits ONE spelling of a
 * scope, [a,b], [b,a] and [a,a,b] are three digests for one authorization.
 *
 * The canonical spelling is: duplicates dropped, then sorted in UTF-16
 * code-unit order (Array.prototype.sort() with no comparator, never
 * localeCompare), built BEFORE the struct is signed so the emitted object and
 * the signature agree.
 *
 * Randomness and time are stubbed so two issuances can be compared byte for
 * byte: same sessionId, same session key, same issuedAt and expiresAt.
 * Ed25519 is deterministic, so equal canonical bytes <=> equal parentSignature.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import nacl from "tweetnacl";
import type {
  AgentRegistryId,
  PrincipalKey,
  SessionAction,
  SessionKey,
  SessionKeyConfig,
  SessionScope,
} from "@pcc/spec";
import { DEFAULT_SESSION_KEY_CONFIG } from "@pcc/spec";
import { SessionKeyService } from "../ephemeral-identity.js";

// ---------------------------------------------------------------------------
// Controllable randomUUID. Transparent (real UUIDs) unless a test pins it.
// ---------------------------------------------------------------------------

const rng = vi.hoisted(() => ({ uuid: undefined as string | undefined }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => rng.uuid ?? actual.randomUUID() };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW_MS = 1_700_000_000_000;
const FIXED_ISSUED_AT = FIXED_NOW_MS / 1000;
const FIXED_UUID = "00000000-0000-4000-8000-000000000001";

// Keys come from fixed seeds (tweetnacl), never from real key material.
const principalKeypair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const sessionKeypair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));

const principal: PrincipalKey = {
  agentId: "eip155:84532:0xDeadBeef00000000000000000000000000000001" as AgentRegistryId,
  walletAddress: "0xDeadBeef00000000000000000000000000000001",
  publicKey: principalKeypair.publicKey,
};

const service = new SessionKeyService();

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** The task's example: unsorted, with a duplicate in each list. */
const MESSY: Pick<SessionScope, "allowedActions" | "contractIds"> = {
  allowedActions: ["workflow_step_complete", "evidence_submit", "evidence_submit"],
  contractIds: ["c2", "c1", "c2"],
};

/** The one canonical spelling of MESSY. */
const CANONICAL: Pick<SessionScope, "allowedActions" | "contractIds"> = {
  allowedActions: ["evidence_submit", "workflow_step_complete"],
  contractIds: ["c1", "c2"],
};

/** Inputs that all mean the same authorization, spelled four ways. */
const VARIANTS: Array<{ label: string; scope: Partial<SessionScope> }> = [
  { label: "already canonical", scope: { ...CANONICAL } },
  {
    label: "reordered",
    scope: {
      allowedActions: ["workflow_step_complete", "evidence_submit"],
      contractIds: ["c2", "c1"],
    },
  },
  {
    label: "duplicated",
    scope: {
      allowedActions: ["evidence_submit", "evidence_submit", "workflow_step_complete"],
      contractIds: ["c1", "c1", "c2"],
    },
  },
  { label: "reordered and duplicated", scope: { ...MESSY } },
];

/** The documented canonical-bytes layout, written out independently of the
 *  production helper: what the parent signed before AND after this change. */
function referenceCanonicalJson(sk: Omit<SessionKey, "parentSignature">): string {
  return JSON.stringify({
    sessionId: sk.sessionId,
    parentAgentId: sk.parentAgentId,
    publicKey: hex(sk.publicKey),
    issuedAt: sk.issuedAt,
    expiresAt: sk.expiresAt,
    scope: {
      allowedActions: [...sk.scope.allowedActions].sort(),
      contractIds: [...sk.scope.contractIds].sort(),
      maxSignatures: sk.scope.maxSignatures,
    },
    ...(sk.derivationPath !== undefined ? { derivationPath: sk.derivationPath } : {}),
  });
}

function issue(scope?: Partial<SessionScope>) {
  return service.issueSessionKey({
    principal,
    principalPrivateKey: principalKeypair.secretKey,
    scope,
  });
}

/** Issue a key and capture the exact bytes the parent signed. */
function issueCapturing(scope?: Partial<SessionScope>) {
  const detached = vi.spyOn(nacl.sign, "detached");
  try {
    const issued = issue(scope);
    expect(detached).toHaveBeenCalledTimes(1);
    const signed = detached.mock.calls[0]![0];
    return { ...issued, signedJson: new TextDecoder().decode(signed) };
  } finally {
    // Restore at once: verification needs the real nacl.sign.detached.verify.
    detached.mockRestore();
  }
}

function verifyIssued(issued: { sessionKey: SessionKey; sessionPrivateKey: Uint8Array }, action = "evidence_submit") {
  const event = service.signEvent({
    eventData: new TextEncoder().encode("canonical-scope-evidence"),
    sessionKey: issued.sessionKey,
    sessionPrivateKey: issued.sessionPrivateKey,
    parentPublicKey: principalKeypair.publicKey,
  });
  return service.verifySessionSignedEvent({ event, action });
}

beforeEach(() => {
  rng.uuid = FIXED_UUID;
  vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW_MS);
});

afterEach(() => {
  rng.uuid = undefined;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// issueSessionKey
// ---------------------------------------------------------------------------

describe("issueSessionKey emits a canonical scope", () => {
  beforeEach(() => {
    vi.spyOn(nacl.sign, "keyPair").mockImplementation(() => sessionKeypair);
  });

  it("(a) sorts and de-duplicates allowedActions and contractIds in the emitted scope", () => {
    const { sessionKey } = issue({ ...MESSY, maxSignatures: 7 });

    expect(sessionKey.scope).toEqual({ ...CANONICAL, maxSignatures: 7 });
  });

  it("(a) orders by UTF-16 code unit, not by locale", () => {
    // Locale order puts "a" before "B" and e-acute before "z"; code-unit order
    // is the reverse of both.
    const { sessionKey } = issue({ contractIds: ["a", "B", "z", "é", "b", "A"] });

    expect(sessionKey.scope.contractIds).toEqual(["A", "B", "a", "b", "z", "é"]);
  });

  it("(a) orders by code UNIT, so a surrogate pair sorts before U+FF5E (code-point order would not)", () => {
    // U+1F600 is the pair D83D DE00, and 0xD83D < 0xFF5E, so code-unit order puts
    // it first. Its code point (0x1F600) is larger, so code-point and UTF-8 byte
    // order put it last. Any verifier recomputing the digest must match this.
    const { sessionKey } = issue({ contractIds: ["～", "😀"] });

    expect(sessionKey.scope.contractIds).toEqual(["😀", "～"]);
  });

  it("(a) neither aliases nor reorders the caller's arrays", () => {
    const allowedActions = [...MESSY.allowedActions];
    const contractIds = [...MESSY.contractIds];

    const { sessionKey } = issue({ allowedActions, contractIds });

    expect(allowedActions).toEqual(MESSY.allowedActions);
    expect(contractIds).toEqual(MESSY.contractIds);
    expect(sessionKey.scope.allowedActions).not.toBe(allowedActions);
    expect(sessionKey.scope.contractIds).not.toBe(contractIds);

    // A later edit to the caller's array cannot change what was signed.
    contractIds.push("c9");
    expect(sessionKey.scope.contractIds).toEqual(CANONICAL.contractIds);
  });

  it("(a) canonicalizes defaults that come from the config", () => {
    const config: SessionKeyConfig = {
      defaultTTLSeconds: 60,
      maxTTLSeconds: 120,
      defaultMaxSignatures: 5,
      defaultAllowedActions: ["heartbeat", "evidence_submit", "heartbeat"],
    };

    const { sessionKey } = service.issueSessionKey({
      principal,
      principalPrivateKey: principalKeypair.secretKey,
      config,
    });

    expect(sessionKey.scope.allowedActions).toEqual(["evidence_submit", "heartbeat"]);
  });

  it.each(VARIANTS)("(b) $label input emits the canonical scope arrays", ({ scope }) => {
    const { sessionKey } = issue(scope);

    expect(sessionKey.scope.allowedActions).toEqual(CANONICAL.allowedActions);
    expect(sessionKey.scope.contractIds).toEqual(CANONICAL.contractIds);
  });

  it.each(VARIANTS)(
    "(b) $label input signs the same canonical bytes as the canonical input",
    ({ scope }) => {
      const reference = issueCapturing({ ...CANONICAL });
      const run = issueCapturing(scope);

      expect(run.sessionKey.sessionId).toBe(reference.sessionKey.sessionId);
      expect(run.sessionKey.issuedAt).toBe(FIXED_ISSUED_AT);
      expect(run.signedJson).toBe(reference.signedJson);
      expect(hex(run.sessionKey.parentSignature)).toBe(hex(reference.sessionKey.parentSignature));
    },
  );

  it("(c) a duplicate changes the signed canonical bytes, because sort keeps duplicates", () => {
    const duplicated = issueCapturing({
      allowedActions: ["evidence_submit", "evidence_submit"],
      contractIds: ["c1", "c1"],
    });
    const once = issueCapturing({
      allowedActions: ["evidence_submit"],
      contractIds: ["c1"],
    });

    // One authorization, so one set of canonical bytes.
    expect(duplicated.signedJson).toBe(once.signedJson);
  });

  it("(c) reordering alone is already absorbed by the canonicalizer's sort", () => {
    const ordered = issueCapturing({ ...CANONICAL });
    const reversed = issueCapturing({
      allowedActions: ["workflow_step_complete", "evidence_submit"],
      contractIds: ["c2", "c1"],
    });

    expect(reversed.signedJson).toBe(ordered.signedJson);
  });

  it("(d) the parent signed exactly the canonical form of what was emitted, and it verifies", () => {
    const issued = issueCapturing({ ...MESSY });

    // The signature and the emitted object must agree.
    expect(issued.signedJson).toBe(referenceCanonicalJson(issued.sessionKey));

    const result = verifyIssued(issued);
    expect(result.failures).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.principalAgentId).toBe(principal.agentId);
  });
});

// ---------------------------------------------------------------------------
// A malformed scope is refused, and before anything is signed
// ---------------------------------------------------------------------------

describe("a malformed scope is refused before anything is signed", () => {
  const parentSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

  // Every row is something an untyped JSON request body can carry past the types.
  const malformed: Array<[label: string, scope: unknown, message: RegExp]> = [
    [
      "a number in allowedActions",
      { allowedActions: ["evidence_submit", 5] },
      /^scope\.allowedActions\[1\] must be a string, got number$/,
    ],
    [
      "null in contractIds",
      { contractIds: ["c1", null] },
      /^scope\.contractIds\[1\] must be a string, got null$/,
    ],
    [
      "undefined in contractIds",
      { contractIds: ["c1", undefined] },
      /^scope\.contractIds\[1\] must be a string, got undefined$/,
    ],
    [
      "a hole in a sparse contractIds",
      { contractIds: ["c1", , "c3"] },
      /^scope\.contractIds\[1\] must be a string, got undefined$/,
    ],
    [
      "an object in contractIds",
      { contractIds: [{ id: "c1" }] },
      /^scope\.contractIds\[0\] must be a string, got object$/,
    ],
    [
      "a nested array in allowedActions",
      { allowedActions: [["evidence_submit"]] },
      /^scope\.allowedActions\[0\] must be a string, got array$/,
    ],
    [
      "a bare string where allowedActions belongs",
      { allowedActions: "evidence_submit" },
      /^scope\.allowedActions must be an array of strings, got string$/,
    ],
    [
      "a plain object where contractIds belongs",
      { contractIds: { 0: "c1" } },
      /^scope\.contractIds must be an array of strings, got object$/,
    ],
  ];

  it.each(malformed)("issueSessionKey rejects %s", (_label, scope, message) => {
    expect(() => issue(scope as Partial<SessionScope>)).toThrow(message);
  });

  it.each(malformed)("deriveSessionKey rejects %s", (_label, scope, message) => {
    expect(() =>
      service.deriveSessionKey({
        parentSeed,
        path: "m/8004'/84532'/1'/0'",
        principal,
        principalPrivateKey: principalKeypair.secretKey,
        scope: scope as Partial<SessionScope>,
      }),
    ).toThrow(message);
  });

  it("never reaches the signer", () => {
    const detached = vi.spyOn(nacl.sign, "detached");
    try {
      expect(() => issue({ contractIds: [42] } as unknown as Partial<SessionScope>)).toThrow();
      expect(detached).not.toHaveBeenCalled();
    } finally {
      detached.mockRestore();
    }
  });

  it("still accepts empty lists and returns them empty", () => {
    const { sessionKey } = issue({ allowedActions: [], contractIds: [] });

    expect(sessionKey.scope.allowedActions).toEqual([]);
    expect(sessionKey.scope.contractIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Keys issued before the issuer canonicalized must keep verifying
// ---------------------------------------------------------------------------

describe("keys issued before this change still verify", () => {
  /**
   * Hand-sign a key the way the old issuer did: scope exactly as the caller
   * gave it, parent signature over the canonical form that SORTS but does not
   * de-duplicate.
   */
  function legacyKey(scope: SessionScope) {
    const body = {
      sessionId: "legacy-session-0001",
      parentAgentId: principal.agentId,
      publicKey: sessionKeypair.publicKey,
      issuedAt: FIXED_ISSUED_AT,
      expiresAt: FIXED_ISSUED_AT + 3600,
      scope,
    };
    const parentSignature = nacl.sign.detached(
      new TextEncoder().encode(referenceCanonicalJson(body)),
      principalKeypair.secretKey,
    );
    return { sessionKey: { ...body, parentSignature }, sessionPrivateKey: sessionKeypair.secretKey };
  }

  it.each([
    {
      label: "sorted and de-duplicated",
      allowedActions: ["evidence_submit", "workflow_step_complete"] as SessionAction[],
      contractIds: ["c1", "c2"],
    },
    {
      label: "sorted but still carrying duplicates",
      allowedActions: ["evidence_submit", "evidence_submit", "workflow_step_complete"] as SessionAction[],
      contractIds: ["c1", "c2", "c2"],
    },
    {
      label: "unsorted with duplicates, as the old issuer emitted it",
      allowedActions: [...MESSY.allowedActions],
      contractIds: [...MESSY.contractIds],
    },
  ])("verifies a key whose scope is $label", ({ allowedActions, contractIds }) => {
    const issued = legacyKey({ allowedActions, contractIds, maxSignatures: 1000 });

    const event = service.signEvent({
      eventData: new TextEncoder().encode("legacy-evidence"),
      sessionKey: issued.sessionKey,
      sessionPrivateKey: issued.sessionPrivateKey,
      parentPublicKey: principalKeypair.publicKey,
    });
    const result = service.verifySessionSignedEvent({
      event,
      action: "evidence_submit",
      currentTimestamp: FIXED_ISSUED_AT + 10,
    });

    expect(result.failures).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveSessionKey builds its scope the same way
// ---------------------------------------------------------------------------

describe("deriveSessionKey emits the same canonical scope", () => {
  const parentSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const path = "m/8004'/84532'/1'/0'";

  function derive(scope?: Partial<SessionScope>) {
    return service.deriveSessionKey({
      parentSeed,
      path,
      principal,
      principalPrivateKey: principalKeypair.secretKey,
      scope,
    });
  }

  it("sorts and de-duplicates the emitted scope", () => {
    const { sessionKey } = derive({ ...MESSY });

    expect(sessionKey.scope).toEqual({
      ...CANONICAL,
      maxSignatures: DEFAULT_SESSION_KEY_CONFIG.defaultMaxSignatures,
    });
  });

  it("verifies end to end with a messy input scope", () => {
    const derived = derive({ ...MESSY });

    const result = verifyIssued(derived);
    expect(result.failures).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

// astra pack 145, F1 (MEDIUM): validation and canonicalization must consume the SAME
// values. A direct service caller (JSON cannot carry these) can hand an array whose
// iterator, or an index accessor, yields something other than what the index check saw.
describe("validation and canonicalization read each element exactly once (astra pack 145 F1)", () => {
  it("[neg] an array whose iterator yields an unvalidated value is refused, never signed", () => {
    const contractIds = ["c1"];
    (contractIds as unknown as { [Symbol.iterator]: () => Iterator<unknown> })[Symbol.iterator] = function* () {
      yield 42 as unknown as string;
    };
    expect(() => issue({ contractIds })).toThrow();
  });

  it("[neg] an accessor that returns a string on its first read and a number afterwards is refused or canonicalized from the first read", () => {
    const contractIds: string[] = [];
    let reads = 0;
    Object.defineProperty(contractIds, 0, {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? "c1" : (7 as unknown as string);
      },
    });
    contractIds.length = 1;
    let emitted: string[] | undefined;
    try {
      emitted = issue({ contractIds }).sessionKey.scope.contractIds;
    } catch {
      emitted = undefined; // refusing is also acceptable
    }
    if (emitted !== undefined) {
      expect(emitted).toEqual(["c1"]); // only the validated first read may be signed
      expect(emitted.every((x) => typeof x === "string")).toBe(true);
    }
    expect(reads).toBe(1); // each element is read exactly once
  });

  it("[neg] the same holds for allowedActions (the shared helper also backs deriveSessionKey)", () => {
    const allowedActions = ["evidence_submit"];
    (allowedActions as unknown as { [Symbol.iterator]: () => Iterator<unknown> })[Symbol.iterator] = function* () {
      yield { not: "a string" } as unknown as string;
    };
    expect(() => issue({ allowedActions: allowedActions as never })).toThrow();
  });
});

