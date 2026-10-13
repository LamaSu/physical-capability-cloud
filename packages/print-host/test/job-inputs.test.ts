import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { defaultJobInputSource, fileJobInputSource, hasPackageInputs, isUnitBinding, JOB_INPUT_CODES } from "../src/job-inputs.js";

let dir: string;
const jobId = "job-input-1";
const pdf = Buffer.from("%PDF-1.7\nrehearsal document\n%%EOF");
const unit = {
  settlementUnitId: `0x${"a".repeat(64)}`, challengeNonce: `0x${"0".repeat(64)}`,
  fundedAt: 1_792_083_600, reclaimAt: 1_792_087_200,
};
const hash = (label: string) => `0x${createHash("sha256").update(label).digest("hex")}`;
const packageFields = {
  chainId: 84532, escrow: getAddress(hash("escrow").slice(0, 42)),
  jobIdHash: hash(jobId), milestoneIndex: 0, stepId: hash("step"),
  compositionRoot: hash("composition"), acceptedEnvelopeHash: hash("accepted"),
  compositionSchemaVersion: 2, tChallengeRef: "challenge:input-1",
  evidenceTimeBounds: { start: String(unit.fundedAt), end: String(unit.reclaimAt) },
};
const program = { programHash: hash("program"), attestationSetRoot: hash("attestations"), workProductRoot: hash("work") };

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

  it("accepts complete settlement and canonical program contexts", async () => {
    await fixture({ unit: { ...unit, ...packageFields }, program });
    const result = await fileJobInputSource(dir)(jobId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.unit).toEqual({ ...unit, ...packageFields });
      expect(result.value.program).toEqual(program);
      expect(hasPackageInputs(result.value)).toBe(true);
      expect(isUnitBinding(result.value.unit)).toBe(true);
    }
  });

  it.each(Object.keys(packageFields))("keeps printing inputs when package unit field %s is absent", async (field) => {
    await fixture({ unit: { ...unit, ...packageFields, [field]: undefined }, program });
    const result = await fileJobInputSource(dir)(jobId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(hasPackageInputs(result.value)).toBe(false);
  });

  it.each([undefined, {}, { programHash: program.programHash },
    { programHash: program.programHash, attestationSetRoot: program.attestationSetRoot }])(
    "keeps printing inputs with an absent or incomplete program %#", async (partialProgram) => {
      await fixture({ unit: { ...unit, ...packageFields }, program: partialProgram });
      const result = await fileJobInputSource(dir)(jobId);
      expect(result.ok).toBe(true);
      if (result.ok) expect(hasPackageInputs(result.value)).toBe(false);
    },
  );

  it.each([{}, { start: "1" }, { end: "2" }])("keeps printing inputs with incomplete package time bounds %#", async (bounds) => {
    await fixture({ unit: { ...unit, ...packageFields, evidenceTimeBounds: bounds }, program });
    const result = await fileJobInputSource(dir)(jobId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(hasPackageInputs(result.value)).toBe(false);
  });

  it.each([
    { chainId: 1 }, { chainId: "84532" }, { escrow: packageFields.escrow.toLowerCase() },
    { escrow: `0x${"0".repeat(40)}` }, { escrow: "bad address" },
    { jobIdHash: packageFields.jobIdHash.toUpperCase() }, { jobIdHash: "0x1234" },
    { milestoneIndex: -1 }, { milestoneIndex: 0.5 }, { milestoneIndex: Number.MAX_SAFE_INTEGER + 1 },
    { milestoneIndex: "0" }, { stepId: null }, { compositionRoot: "invalid" }, { acceptedEnvelopeHash: "invalid" },
    { compositionSchemaVersion: -1 }, { compositionSchemaVersion: 65_536 }, { compositionSchemaVersion: "2" },
    { tChallengeRef: "" }, { tChallengeRef: "line\nbreak" }, { tChallengeRef: "\uD800" },
    { evidenceTimeBounds: { start: "01", end: "2" } },
    { evidenceTimeBounds: { start: "2", end: "1" } },
    { evidenceTimeBounds: { start: "1.0", end: "2" } },
    { evidenceTimeBounds: { start: "9007199254740992", end: "9007199254740992" } },
    { evidenceTimeBounds: { start: "1", end: "2", extra: true } },
    { operator: packageFields.escrow }, { devicePublicKey: hash("device") }, { kernelId: "kernel:injected" },
  ])("refuses malformed or injected package unit values %#", async (change) => {
    await fixture({ unit: { ...unit, ...packageFields, ...change }, program });
    expect(await fileJobInputSource(dir)(jobId)).toEqual({ ok: false, code: "job_inputs_bad_schema" });
  });

  it.each([
    { programHash: "bad" }, { attestationSetRoot: program.attestationSetRoot.toUpperCase() },
    { workProductRoot: null }, { extra: "server text" },
  ])("refuses malformed or extra program fields %#", async (change) => {
    await fixture({ unit: { ...unit, ...packageFields }, program: { ...program, ...change } });
    expect(await fileJobInputSource(dir)(jobId)).toEqual({ ok: false, code: "job_inputs_bad_schema" });
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
