import { describe, it, expect } from "vitest";
import { CsdSchema } from "./schema.js";
import { CsdRegistry } from "./registry.js";
import printAndMailCsd from "../csds/document-print-and-mail.csd.json" with { type: "json" };

describe("pcc://capabilities/document-print-and-mail/v1 (composite CSD, kind=workflow)", () => {
  it("validates against CsdSchema", () => {
    const result = CsdSchema.safeParse(printAndMailCsd);
    if (!result.success) {
      throw new Error(result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; "));
    }
    expect(result.data.kind).toBe("workflow");
    expect(result.data.url).toBe("pcc://capabilities/document-print-and-mail/v1");
  });

  it("registers into a fresh CsdRegistry and resolves by URL", () => {
    const registry = new CsdRegistry();
    registry.register(CsdSchema.parse(printAndMailCsd));
    const resolved = registry.resolve("pcc://capabilities/document-print-and-mail/v1");
    expect(resolved.name).toBe("Document Print-and-Mail");
    expect(resolved.pricing.currency).toBe("USDC");
  });

  it("tier 2 and tier 3 close the MAIL leg on the carrier's authenticated acceptance-scan webhook — never a photo alone", () => {
    const csd = CsdSchema.parse(printAndMailCsd);
    for (const tier of ["tier2", "tier3"] as const) {
      const prims = csd.evidence?.[tier]?.primitives ?? [];
      const scan = prims.find((p) => p.id === "confirm.target_system" && p.params?.channel === "webhook" && p.params?.matcher === "carrier.acceptance_scan");
      expect(scan, `${tier} must bind the carrier acceptance scan`).toBeDefined();
      // bound to the carrier leg's REAL EvidenceEvent type (carrier lane #1470; @pcc/spec EVIDENCE_EVENT_TYPES)
      expect(scan?.bind).toBe("courier_pickup_confirmed");
      expect(csd.evidence?.[tier]?.required).toContain("courier_pickup_confirmed");
      // and never closed by a photo alone: the photo primitive is the pre-seal handoff photo, not the mail proof
      const photo = prims.find((p) => p.id === "capture.photo_nonced");
      expect(photo?.bind).toBe("photo_captured");
    }
    // tier 3 adds the delivery scan under its real event type
    const t3 = csd.evidence?.tier3?.primitives ?? [];
    expect(t3.find((p) => p.params?.matcher === "carrier.delivery_scan")?.bind).toBe("courier_delivery_confirmed");
    // tier 1 is honest: mailing is still self-declared there (only the print leg is machine-proven)
    const t1 = csd.evidence?.tier1?.primitives?.map((p) => p.id) ?? [];
    expect(t1).toContain("machine.execution_log");
    expect(t1).not.toContain("confirm.target_system");
  });

  it("the print leg reuses the existing document-printing vocabulary (receipt bound to that capability; log bound to printer_job_verified)", () => {
    const csd = CsdSchema.parse(printAndMailCsd);
    const receipt = csd.evidence?.tier1?.primitives?.find((p) => p.id === "receipt.kernel_signed");
    expect(receipt?.params?.capability).toBe("document-printing");
    const log = csd.evidence?.tier1?.primitives?.find((p) => p.id === "machine.execution_log");
    expect(log?.bind).toBe("printer_job_verified");
    expect(csd.evidence?.tier1?.primitives?.find((p) => p.id === "artifact.hash")?.bind).toBe("commitment.labelHash");
  });
});
