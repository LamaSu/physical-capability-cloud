/** EvidenceProvenanceDTO (PX-7): the schema id; the vocabulary is exercised by the gateway builder's tests. */
import { describe, it, expect } from "vitest";
import { EVIDENCE_PROVENANCE_SCHEMA_ID } from "../readmodels/evidence-provenance.js";

describe("evidence provenance", () => {
  it("carries a versioned schema id", () => {
    expect(EVIDENCE_PROVENANCE_SCHEMA_ID).toBe("pcc.evidence-provenance/v1");
  });
});
