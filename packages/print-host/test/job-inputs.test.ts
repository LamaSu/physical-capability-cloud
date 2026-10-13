import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultJobInputSource, fileJobInputSource, isUnitBinding, JOB_INPUT_CODES } from "../src/job-inputs.js";

let dir: string;
const jobId = "job-input-1";
const pdf = Buffer.from("%PDF-1.7\nrehearsal document\n%%EOF");
const unit = {
  settlementUnitId: `0x${"a".repeat(64)}`, challengeNonce: `0x${"0".repeat(64)}`,
  fundedAt: 1_792_083_600, reclaimAt: 1_792_087_200,
};

beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), "print-host-inputs-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); });

async function fixture(change: Record<string, unknown> = {}, content = pdf): Promise<void> {
  await fs.writeFile(join(dir, "document.pdf"), content);
  await fs.writeFile(join(dir, `${jobId}.json`), JSON.stringify({ jobName: "Operator rehearsal", totalPages: 2, documentFile: "document.pdf", unit, ...change }));
}

describe("fileJobInputSource", () => {
  it("accepts the closed funded-unit manifest and a local PDF", async () => {
    await fixture();
    const result = await fileJobInputSource(dir)(jobId);
    expect(result).toEqual({ ok: true, value: { documentData: pdf, jobName: "Operator rehearsal", totalPages: 2, unit } });
  });

  it("refuses a manifest without the required unit evidence binding", async () => {
    await fixture({ unit: undefined });
    const result = await fileJobInputSource(dir)(jobId);
    expect(result).toEqual({ ok: false, code: "job_inputs_bad_schema" });
  });

  it.each(["settlementUnitId", "challengeNonce", "fundedAt", "reclaimAt"] as const)(
    "refuses a unit missing %s", async (field) => {
      await fixture({ unit: { ...unit, [field]: undefined } });
      expect(await fileJobInputSource(dir)(jobId)).toEqual({ ok: false, code: "job_inputs_bad_schema" });
    },
  );

  it.each([
    { fundedAt: -1 }, { fundedAt: 1.5 }, { reclaimAt: -1 }, { reclaimAt: 1.5 },
    { fundedAt: Number.MAX_SAFE_INTEGER + 1 }, { reclaimAt: Number.MAX_SAFE_INTEGER + 1 },
    { fundedAt: "1792083600" }, { reclaimAt: "1792087200" },
    { reclaimAt: unit.fundedAt }, { reclaimAt: unit.fundedAt - 1 },
    { fundedAt: null }, { reclaimAt: null },
  ])("refuses invalid Unix-second funding windows %#", async (change) => {
    await fixture({ unit: { ...unit, ...change } });
    expect(await fileJobInputSource(dir)(jobId)).toEqual({ ok: false, code: "job_inputs_bad_schema" });
  });

  it("checks custom input bindings with the same strict schema", () => {
    expect(isUnitBinding(unit)).toBe(true);
    expect(isUnitBinding(undefined)).toBe(false);
    expect(isUnitBinding({ ...unit, extra: true })).toBe(false);
    expect(isUnitBinding({ ...unit, fundedAt: Number.NaN })).toBe(false);
    expect(isUnitBinding({ ...unit, reclaimAt: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it.each(["../document.pdf", "/document.pdf", "child/document.pdf", String.raw`child\document.pdf`, ".", "..", "document\u0000.pdf"])(
    "refuses traversal or a non-plain documentFile %s", async (documentFile) => {
      await fixture({ documentFile });
      expect(await fileJobInputSource(dir)(jobId)).toEqual({ ok: false, code: "job_inputs_bad_schema" });
    },
  );

  it("refuses a symlink document without reading its target", async () => {
    await fixture();
    await fs.symlink(join(dir, "document.pdf"), join(dir, "linked.pdf"));
    await fixture({ documentFile: "linked.pdf" });
    expect(await fileJobInputSource(dir)(jobId)).toEqual({ ok: false, code: "job_inputs_symlink" });
  });

  it("refuses a symlink manifest and a symlink inputs directory", async () => {
    await fixture();
    await fs.rename(join(dir, `${jobId}.json`), join(dir, "actual.json"));
    await fs.symlink(join(dir, "actual.json"), join(dir, `${jobId}.json`));
    expect(await fileJobInputSource(dir)(jobId)).toEqual({ ok: false, code: "job_inputs_symlink" });
    const linkedDir = join(dir, "linked-dir");
    await fs.symlink(dir, linkedDir);
    expect(await fileJobInputSource(linkedDir)(jobId)).toEqual({ ok: false, code: "job_inputs_bad_directory" });
  });

  it("refuses a non-PDF and an oversize PDF", async () => {
    await fixture({}, Buffer.from("not a PDF"));
    expect(await fileJobInputSource(dir)(jobId)).toEqual({ ok: false, code: "job_inputs_not_pdf" });
    await fixture();
    await fs.truncate(join(dir, "document.pdf"), 20 * 1024 * 1024 + 1);
    expect(await fileJobInputSource(dir)(jobId)).toEqual({ ok: false, code: "job_inputs_too_large" });
  });

  it("requires the literal PDF magic bytes, including their high bits", async () => {
    await fixture({}, Buffer.from([0xa5, 0xd0, 0xc4, 0xc6, 0xad]));
    expect(await fileJobInputSource(dir)(jobId)).toEqual({ ok: false, code: "job_inputs_not_pdf" });
  });

  it("accepts the exact 20 MiB limit", async () => {
    await fixture();
    await fs.truncate(join(dir, "document.pdf"), 20 * 1024 * 1024);
    const result = await fileJobInputSource(dir)(jobId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.documentData.length).toBe(20 * 1024 * 1024);
  });

  it.each([
    { unit: { ...unit, challengeNonce: "0x1234" } },
    { unit: { ...unit, challengeNonce: `0x${"A".repeat(64)}` } },
    { unit: { ...unit, settlementUnitId: "a".repeat(64) } },
    { unit: { ...unit, extra: true } },
    { totalPages: 0 }, { totalPages: 51 }, { totalPages: 1.5 },
    { jobName: "" }, { jobName: "contains\nnewline" }, { extra: "server text" },
  ])("refuses bad unit, pagination, names, or unknown manifest fields %#", async (change) => {
    await fixture(change);
    expect(await fileJobInputSource(dir)(jobId)).toEqual({ ok: false, code: "job_inputs_bad_schema" });
  });

  it("returns only closed failure codes, without parser excerpts or filesystem messages", async () => {
    const secret = "PRIVATE_DOCUMENT_TEXT_NEVER_RETURNED";
    await fs.writeFile(join(dir, `${jobId}.json`), `${secret}{`);
    const invalid = await fileJobInputSource(dir)(jobId);
    expect(invalid).toEqual({ ok: false, code: "job_inputs_bad_json" });
    expect(JSON.stringify(invalid)).not.toContain(secret);
    expect(await fileJobInputSource(dir)("absent")).toEqual({ ok: false, code: "job_inputs_not_found" });
    const result = await fileJobInputSource("relative")(jobId);
    expect(result).toEqual({ ok: false, code: "job_inputs_bad_directory" });
    if (!result.ok) expect(JOB_INPUT_CODES).toContain(result.code);
  });

  it("encodes a job identifier rather than allowing it to select an outside manifest", async () => {
    await fixture();
    expect(await fileJobInputSource(dir)("../job-input-1")).toEqual({ ok: false, code: "job_inputs_not_found" });
    await fs.rename(join(dir, `${jobId}.json`), join(dir, "..%2Fjob-input-1.json"));
    expect((await fileJobInputSource(dir)("../job-input-1")).ok).toBe(true);
    expect(await fileJobInputSource(dir)("bad\njob")).toEqual({ ok: false, code: "job_inputs_bad_id" });
    expect(await fileJobInputSource(dir)("\ud800")).toEqual({ ok: false, code: "job_inputs_bad_id" });
  });

  it("refuses a file replaced between inspection and opening", async () => {
    await fixture();
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      await fs.rename(join(dir, `${jobId}.json`), join(dir, "original.json"));
      await fixture();
      return open(...args);
    });
    expect(await fileJobInputSource(dir)(jobId)).toEqual({ ok: false, code: "job_inputs_changed" });
  });

  it("caps reads if a document grows after inspection", async () => {
    await fixture();
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === join(dir, "document.pdf")) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs) => {
          await fs.truncate(join(dir, "document.pdf"), 20 * 1024 * 1024 + 1);
          return read(...readArgs);
        });
      }
      return handle;
    });
    expect(await fileJobInputSource(dir)(jobId)).toEqual({ ok: false, code: "job_inputs_too_large" });
  });
});

it("the default input source remains unavailable", async () => {
  expect(await defaultJobInputSource(jobId)).toEqual({ ok: false, code: "job_inputs_unavailable" });
});
