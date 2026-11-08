/**
 * Device intake: an unknown key that is its own token is still never kept
 * verbatim (astra pack 120f).
 *
 * No such key is known to exist: it would need a 48-bit fixed point of
 * "#" + sha256(key)[:12]. So this file mocks sha256 for ONE input, making
 * "#aaaaaaaaaaaa" its own token. The decision logic is under test here, not
 * the hash. The mock is file-wide, which is why this has its own file.
 */
import { describe, it, expect, vi } from "vitest";

const FIXED = "#aaaaaaaaaaaa";
vi.mock("@noble/hashes/sha256", async (importOriginal) => {
  const real = (await importOriginal()) as { sha256: (b: Uint8Array) => Uint8Array };
  return {
    ...real,
    sha256: (bytes: Uint8Array) => (new TextDecoder().decode(bytes) === FIXED ? new Uint8Array(32).fill(0xaa) : real.sha256(bytes)),
  };
});

const { redactIntakeSecrets, scanIntakeStrings, validateIntake } = await import("../onboarding/intake/index.js");

describe("an unknown key that is its own token (sha256 mocked for that one key)", () => {
  it("redaction keeps a key only by vocabulary membership: the fixed point is renamed", () => {
    const out = redactIntakeSecrets({ schema: "pcc.device-intake.v1", answers: { [FIXED]: { value: "x" } } }) as {
      answers: Record<string, unknown>;
    };
    expect(Object.keys(out.answers)).toHaveLength(1);
    expect(Object.keys(out.answers)).not.toContain(FIXED);
  });

  it("the report never shows it either: its own token is reserved, so it is re-derived", () => {
    const report = validateIntake({ schema: "pcc.device-intake.v1", answers: { [FIXED]: { value: "x", provenance: "human" } } }, "register");
    expect(report.unknownFields).toHaveLength(1);
    expect(report.unknownFields).not.toContain(FIXED);
  });

  it("nor does a secret's path", () => {
    const hits = scanIntakeStrings({ answers: { "safety.estop": { value: { mechanism: "button", [FIXED]: "sk-" + "proj-" + "F".repeat(40) } } } });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path.split("/")).not.toContain(FIXED);
  });
});
