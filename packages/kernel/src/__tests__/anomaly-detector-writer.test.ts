import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashBundle, type EvidenceBundle, type EvidenceEvent, type Signature } from "@pcc/spec";
import { AnomalyDetector } from "../anomaly-detector.js";

interface WriterVector {
  id: string;
  verified: boolean;
  event: EvidenceEvent;
}

interface VectorFile {
  events: WriterVector[];
  invalidWriters: WriterVector[];
}

const vectors = JSON.parse(readFileSync(
  new URL("../../../spec/src/evidence/vectors/event-hash-writer.v2.json", import.meta.url),
  "utf8",
)) as VectorFile;

const cases = [...vectors.events, ...vectors.invalidWriters];
const BUNDLE = "bundle_writer_detector";

async function bundleOf(event: EvidenceEvent): Promise<EvidenceBundle> {
  const events = [structuredClone(event)];
  return {
    id: BUNDLE,
    jobId: "job_writer_vector",
    stepId: "s",
    kernelId: "kernel_writer_vector",
    assuranceTier: 0,
    events,
    bundleHash: await hashBundle(events),
    kernelSignature: {
      signer: `0x${"1".repeat(40)}`,
      algorithm: "ed25519",
      value: "real_signature_fixture",
    } as Signature,
    createdAt: "2026-10-16T08:00:01.000Z",
  };
}

describe("AnomalyDetector uses spec writer-version verification", () => {
  it.each(cases)("AD1 vector $id is verified=$verified", async ({ id, event, verified }) => {
    const detector = new AnomalyDetector();
    const bundle = await bundleOf(event);
    const result = await detector.checkEvidenceIntegrity(bundle);

    if (verified) {
      expect(result, id).toBeNull();
    } else {
      expect(result, id).not.toBeNull();
      expect(result!.severity).toBe("critical");
      expect(result!.category).toBe("evidence_mismatch");
      expect(result!.description).toBe(
        `Event hash mismatch for event ${event.id} in bundle ${BUNDLE}`,
      );
      expect(result!.sourceId).toBe(bundle.kernelId);
      expect(result!.targetId).toBe(BUNDLE);
      expect(result!.evidence).toStrictEqual({
        eventId: event.id,
        storedHash: event.hash,
      });
    }
  });
});
