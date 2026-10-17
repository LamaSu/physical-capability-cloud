/**
 * A static guard for the print path's failure text (steward #5547), as failure-text-guard does for
 * JobRunner's: printer-job.ts turns a failure's reason into text only through failureText, which
 * never throws. The raw `err instanceof Error ? err.message : String(err)` throws for a reason with
 * no text form (astra pack 200).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const RAW = /instanceof\s+Error\s*\?\s*[\w.]+\.message\s*:\s*String\(/g;

it("printer-job.ts turns a failure's reason into text only through failureText", () => {
  const source = readFileSync(fileURLToPath(new URL("../printer-job.ts", import.meta.url)), "utf8");
  expect(source.match(RAW) ?? [], "raw conversions in printer-job.ts").toEqual([]);
});
