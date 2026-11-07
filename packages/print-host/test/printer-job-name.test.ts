import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { jobFileStem } from "../src/job-inputs.js";
import { derivePrinterJobName } from "../src/printer-job-name.js";

describe("derivePrinterJobName", () => {
  it("uses the exact host prefix for a short job id", () => {
    expect(derivePrinterJobName("j")).toBe("pcc-job j");
  });

  it("keeps the longest accepted host job id printable and bounded", () => {
    const jobId = "j".repeat(200);
    expect(jobFileStem(jobId)).toBe(jobId);
    expect(jobFileStem(`${jobId}j`)).toBeUndefined();
    expect(derivePrinterJobName(jobId)).toBe(`pcc-job ${jobId}`);
    expect(derivePrinterJobName(jobId)).toMatch(/^[\x20-\x7e]{1,255}$/);
  });

  it("uses the readable form up to the printer's 255-character limit", () => {
    const jobId = "j".repeat(247);
    expect(derivePrinterJobName(jobId)).toBe(`pcc-job ${jobId}`);
    expect(derivePrinterJobName(jobId)).toHaveLength(255);
  });

  it.each([
    { label: "the first oversized id", jobId: "j".repeat(248) },
    { label: "a long id", jobId: "j".repeat(4_096) },
    { label: "a non-ASCII id", jobId: "job:Café" },
    { label: "a C0 control", jobId: "job:\n" },
    { label: "DEL", jobId: "job:\x7f" },
    { label: "a C1 control", jobId: "job:\x9f" },
  ])("hashes $label into a deterministic printable ASCII name", ({ jobId }) => {
    const expected = `pcc-job sha256:${createHash("sha256").update(jobId, "utf8").digest("hex")}`;
    const name = derivePrinterJobName(jobId);
    expect(name).toBe(expected);
    expect(derivePrinterJobName(jobId)).toBe(name);
    expect(name).toMatch(/^[\x20-\x7e]{1,255}$/);
    expect(name).toHaveLength(79);
  });
});
