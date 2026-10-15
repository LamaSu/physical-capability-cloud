import { describe, expect, it } from "vitest";

const configModule = "../vnext-job-config.js";

describe("VITE_VNEXT_JOB_IDS parser", () => {
  it("returns an empty set for empty or non-string config without throwing", async () => {
    const { parseVnextJobIds } = await import(configModule);
    for (const raw of ["", undefined, null, 12, {}, Symbol("config")]) {
      expect([...parseVnextJobIds(raw)]).toEqual([]);
    }
  });

  it("trims whitespace around each entry and drops blank entries", async () => {
    const { parseVnextJobIds } = await import(configModule);
    expect([...parseVnextJobIds(" \t, job-print-1 ,\n job_2\t, ,\r\n")]).toEqual(["job-print-1", "job_2"]);
    expect([...parseVnextJobIds(" \t,\r\n , ")]).toEqual([]);
  });

  it("drops invalid entries and keeps only conservative bounded job ids", async () => {
    const { parseVnextJobIds } = await import(configModule);
    const boundary = "a".repeat(128);
    const raw = ["job-print-1", "https://evil.example/job", "../job", "job with spaces", "job\u0000x", "job?x", "job#x", "_job", "-job", "a".repeat(129), boundary, "Job_2-3"].join(",");
    expect([...parseVnextJobIds(raw)]).toEqual(["job-print-1", boundary, "Job_2-3"]);
  });

  it("deduplicates ids after trimming and preserves exact case", async () => {
    const { parseVnextJobIds } = await import(configModule);
    expect([...parseVnextJobIds(" job-1,job-1, job-1 ,Job-1 ")]).toEqual(["job-1", "Job-1"]);
  });

  it("refuses ':' and '.' (a compiler planId:operator id is not a gateway job id)", async () => {
    const { parseVnextJobIds } = await import(configModule);
    const op = `0x${"a".repeat(40)}`;
    expect([...parseVnextJobIds(["job:x", "job.x", `plan.resv-1:${op}`, "pcc:vnext:golden:job", "job-ok"].join(","))]).toEqual(["job-ok"]);
  });
});
