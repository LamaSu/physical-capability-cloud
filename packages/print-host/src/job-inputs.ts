import { constants } from "node:fs";
import fs from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

export interface JobInputs {
  documentData: Buffer;
  jobName: string;
  totalPages: number;
  unit: { settlementUnitId: string; challengeNonce: string; fundedAt: number; reclaimAt: number };
}

export const JOB_INPUT_CODES = [
  "job_inputs_unavailable", "job_inputs_bad_id", "job_inputs_bad_directory",
  "job_inputs_not_found", "job_inputs_symlink", "job_inputs_not_file",
  "job_inputs_changed", "job_inputs_read_failed", "job_inputs_bad_json",
  "job_inputs_bad_schema", "job_inputs_too_large", "job_inputs_not_pdf",
] as const;
export type JobInputCode = typeof JOB_INPUT_CODES[number];

export type JobInputResult = { ok: true; value: JobInputs } | { ok: false; code: JobInputCode };
export type JobInputSource = (jobId: string) => Promise<JobInputResult>;

/** The gateway inputs route is a future seam; absence never authorises a print. */
export const defaultJobInputSource: JobInputSource = async () => ({ ok: false, code: "job_inputs_unavailable" });

/** A stable basename shared with the journal; it never introduces path separators. */
export function jobFileStem(jobId: string): string | undefined {
  if (typeof jobId !== "string" || jobId.length === 0 || jobId.length > 200
    || /[\u0000-\u001f\u007f-\u009f]/.test(jobId)) return undefined;
  try {
    const stem = encodeURIComponent(jobId);
    // Keep both the manifest and bundle basenames below the common 255-byte limit.
    return Buffer.byteLength(stem) <= 240 ? stem : undefined;
  } catch { return undefined; }
}

const plainFileName = z.string().min(1).max(240).refine((value) =>
  value !== "." && value !== ".." && Buffer.byteLength(value) <= 240
    && !/[\/\\\u0000-\u001f\u007f-\u009f]/.test(value),
);
const unitSchema = z.object({
  settlementUnitId: z.string().regex(/^0x[0-9a-f]{64}$/),
  challengeNonce: z.string().regex(/^0x[0-9a-f]{64}$/),
  fundedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reclaimAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict().refine((unit) => unit.reclaimAt > unit.fundedAt);

/** Custom input sources must meet the same unit binding requirements before claim. */
export function isUnitBinding(value: unknown): value is JobInputs["unit"] {
  return unitSchema.safeParse(value).success;
}
const manifestSchema = z.object({
  jobName: z.string().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value)),
  totalPages: z.number().int().min(1).max(50),
  documentFile: plainFileName,
  unit: unitSchema,
}).strict();

class InputFileError extends Error {
  constructor(readonly code: JobInputCode) { super(code); }
}

function ioCode(error: unknown): JobInputCode {
  if (error instanceof InputFileError) return error.code;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "ENOENT" ? "job_inputs_not_found"
    : code === "ELOOP" ? "job_inputs_symlink" : "job_inputs_read_failed";
}

/** Bound the descriptor read, including a file that grows after its metadata check. */
async function readLocalFile(path: string, limit: number): Promise<Buffer> {
  const checked = await fs.lstat(path);
  if (checked.isSymbolicLink()) throw new InputFileError("job_inputs_symlink");
  if (!checked.isFile()) throw new InputFileError("job_inputs_not_file");
  if (checked.size > limit) throw new InputFileError("job_inputs_too_large");
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW
    | constants.O_NOCTTY | constants.O_NONBLOCK);
  let bytes: Buffer | undefined;
  try {
    const opened = await file.stat();
    if (opened.dev !== checked.dev || opened.ino !== checked.ino) throw new InputFileError("job_inputs_changed");
    if (!opened.isFile()) throw new InputFileError("job_inputs_not_file");
    if (opened.size > limit) throw new InputFileError("job_inputs_too_large");
    bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) return bytes.subarray(0, length);
      length += bytesRead;
    }
    throw new InputFileError("job_inputs_too_large");
  } catch (error) {
    bytes?.fill(0);
    throw error;
  } finally { await file.close(); }
}

/** Local, operator-provided inputs with the funded unit binding; this never fetches a document. */
export function fileJobInputSource(dir: string): JobInputSource {
  return async (jobId) => {
    const stem = jobFileStem(jobId);
    if (stem === undefined) return { ok: false, code: "job_inputs_bad_id" };
    if (!isAbsolute(dir)) return { ok: false, code: "job_inputs_bad_directory" };
    let manifestBytes: Buffer | undefined;
    let documentData: Buffer | undefined;
    try {
      const directory = await fs.lstat(dir);
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        return { ok: false, code: "job_inputs_bad_directory" };
      }
      manifestBytes = await readLocalFile(join(dir, `${stem}.json`), 64 * 1024);
      let value: unknown;
      try { value = JSON.parse(manifestBytes.toString("utf8")); }
      catch { return { ok: false, code: "job_inputs_bad_json" }; }
      const parsed = manifestSchema.safeParse(value);
      if (!parsed.success) return { ok: false, code: "job_inputs_bad_schema" };
      documentData = await readLocalFile(join(dir, parsed.data.documentFile), 20 * 1024 * 1024);
      if (documentData.length < 5 || !documentData.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))) {
        documentData.fill(0);
        return { ok: false, code: "job_inputs_not_pdf" };
      }
      return {
        ok: true,
        value: {
          documentData,
          jobName: parsed.data.jobName,
          totalPages: parsed.data.totalPages,
          unit: parsed.data.unit,
        },
      };
    } catch (error) {
      documentData?.fill(0);
      return { ok: false, code: ioCode(error) };
    } finally { manifestBytes?.fill(0); }
  };
}
