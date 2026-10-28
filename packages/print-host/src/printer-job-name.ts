import { createHash } from "node:crypto";

/** The printer receives only a deterministic, printable ASCII name owned by the host. */
export function derivePrinterJobName(jobId: string): string {
  const name = `pcc-job ${jobId}`;
  if (name.length <= 255 && !/[^\x20-\x7e]/.test(name)) return name;
  return `pcc-job sha256:${createHash("sha256").update(jobId, "utf8").digest("hex")}`;
}
