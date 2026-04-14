/**
 * CSV -> LedgerEntry importer for the accounting-reconcile onboarding harness.
 *
 * - Auto-detects QuickBooks / Xero / generic exports from the header row.
 * - Handles UTF-8 BOM, UTF-16 (LE/BE), Latin-1 fallback.
 * - Parses quoted fields with embedded commas and escaped quotes ("").
 * - Rejects empty files, missing Date column, missing amount columns with a
 *   typed `CsvImportError`.
 * - Folds Debit / Credit columns into a signed amount so the kernel's
 *   `fetchLedger` step receives the LedgerEntry shape it already expects.
 *
 * Zero external deps -- implements a minimal, RFC 4180-leaning parser.
 */
import { readFileSync } from "node:fs";

import type { LedgerEntry } from "@pcc/kernel/dist/digital/accounting-kernel.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CsvFormat = "quickbooks" | "xero" | "generic";

export interface ImportStats {
  rows: number;
  accounts: number;
  dateRange: { start?: string; end?: string };
  totalDebits: number;
  totalCredits: number;
}

export interface CsvImportResult {
  entries: LedgerEntry[];
  format: CsvFormat;
  stats: ImportStats;
}

export type CsvImportErrorCode =
  | "empty_file"
  | "no_header"
  | "missing_date_column"
  | "missing_amount_column"
  | "malformed_row"
  | "unreadable_encoding";

export class CsvImportError extends Error {
  readonly code: CsvImportErrorCode;
  readonly hint?: string;

  constructor(code: CsvImportErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "CsvImportError";
    this.code = code;
    this.hint = hint;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read a CSV file from disk and parse it into LedgerEntry[]. */
export function importCsvFile(filePath: string): CsvImportResult {
  const buf = readFileSync(filePath);
  const text = decodeBuffer(buf);
  return importCsvText(text);
}

/** Parse CSV text (already decoded) into LedgerEntry[] with format auto-detection. */
export function importCsvText(text: string): CsvImportResult {
  const stripped = stripBom(text);
  if (stripped.trim().length === 0) {
    throw new CsvImportError(
      "empty_file",
      "CSV is empty or only whitespace",
      "Provide a CSV with a header row and at least one data row.",
    );
  }

  const rows = parseCsvRows(stripped);
  if (rows.length === 0) {
    throw new CsvImportError("empty_file", "CSV has no parseable rows");
  }

  const header = rows[0];
  if (header.length === 0 || header.every((c) => c.trim() === "")) {
    throw new CsvImportError("no_header", "First row is empty; expected a header row");
  }

  const format = detectFormat(header);
  const mapping = buildColumnMapping(header, format);

  if (mapping.dateIdx < 0) {
    throw new CsvImportError(
      "missing_date_column",
      `Missing required Date column (looked for: date, transaction date, posting date). Header was: ${header.join(", ")}`,
      "Rename your date column to 'Date' or export with one.",
    );
  }
  if (mapping.amountIdx < 0 && mapping.debitIdx < 0 && mapping.creditIdx < 0) {
    throw new CsvImportError(
      "missing_amount_column",
      `Missing amount column (need Amount, or Debit+Credit). Header was: ${header.join(", ")}`,
    );
  }

  const entries: LedgerEntry[] = [];
  const accounts = new Set<string>();
  const dates: string[] = [];
  let totalDebits = 0;
  let totalCredits = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    // Skip entirely empty rows gracefully
    if (isEmptyRow(row)) continue;

    // Pad short rows, ignore overflow cells (common with trailing commas)
    const cell = (idx: number): string =>
      idx >= 0 && idx < row.length ? (row[idx] ?? "").trim() : "";

    const date = cell(mapping.dateIdx);
    if (!date) {
      // A row with no date is likely a subtotal/blank -- skip rather than reject.
      continue;
    }

    const description = cell(mapping.descriptionIdx) || cell(mapping.memoIdx);
    const account = cell(mapping.accountIdx) || "UNCATEGORIZED";
    const reference = cell(mapping.referenceIdx) || undefined;

    // Compute the signed amount. Priority: explicit Amount, else Debit-Credit.
    let amount = 0;
    const rawDebit = parseMoney(cell(mapping.debitIdx));
    const rawCredit = parseMoney(cell(mapping.creditIdx));
    const rawAmount = parseMoney(cell(mapping.amountIdx));

    if (mapping.amountIdx >= 0 && !Number.isNaN(rawAmount)) {
      amount = rawAmount;
    } else {
      amount = (Number.isNaN(rawDebit) ? 0 : rawDebit) - (Number.isNaN(rawCredit) ? 0 : rawCredit);
    }

    // Skip rows where we truly have no monetary data
    if (amount === 0 && Number.isNaN(rawAmount) && Number.isNaN(rawDebit) && Number.isNaN(rawCredit)) {
      continue;
    }

    // Round to cents to avoid float drift at import time
    amount = Math.round(amount * 100) / 100;

    if (!Number.isNaN(rawDebit)) totalDebits += rawDebit;
    if (!Number.isNaN(rawCredit)) totalCredits += rawCredit;

    entries.push({
      date: normalizeDate(date),
      description,
      amount,
      account,
      reference,
    });
    accounts.add(account);
    dates.push(date);
  }

  if (entries.length === 0) {
    throw new CsvImportError(
      "empty_file",
      "CSV header was valid but no data rows were parseable",
      "Check that amount/debit/credit columns contain numbers, not labels.",
    );
  }

  const sortedDates = [...dates].sort();
  const stats: ImportStats = {
    rows: entries.length,
    accounts: accounts.size,
    dateRange: {
      start: sortedDates[0],
      end: sortedDates[sortedDates.length - 1],
    },
    totalDebits: Math.round(totalDebits * 100) / 100,
    totalCredits: Math.round(totalCredits * 100) / 100,
  };

  return { entries, format, stats };
}

// ---------------------------------------------------------------------------
// Internals -- encoding, BOM, row parsing
// ---------------------------------------------------------------------------

/**
 * Decode a buffer with UTF-8 / UTF-16 / Latin-1 fallback.
 * Detects BOMs first, then heuristically falls back to Latin-1 on invalid
 * UTF-8 sequences.
 */
export function decodeBuffer(buf: Buffer): string {
  if (buf.length === 0) return "";
  // UTF-16 LE BOM: FF FE
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le").slice(1);
  }
  // UTF-16 BE BOM: FE FF -- swap bytes then decode as LE
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1]!;
      swapped[i - 1] = buf[i]!;
    }
    return swapped.toString("utf16le");
  }
  // Try UTF-8 (handles both UTF-8 BOM and plain ASCII).
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return decoder.decode(buf);
  } catch {
    // Fall back to Latin-1 for legacy exports.
    return buf.toString("latin1");
  }
}

/** Strip a leading UTF-8 BOM if present (U+FEFF). */
export function stripBom(s: string): string {
  if (s.length > 0 && s.charCodeAt(0) === 0xfeff) return s.slice(1);
  return s;
}

/**
 * Minimal RFC 4180-leaning CSV row parser.
 * Handles:
 *   - Quoted fields with embedded commas and newlines
 *   - Escaped quotes ("")
 *   - CRLF and LF line endings
 *   - Trailing empty lines
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i]!;

    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          // Escaped quote
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    // Not in quotes
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      // Treat CRLF as single record terminator
      if (i + 1 < n && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }

  // Final field/row (file may not end with newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Remove entirely-blank trailing rows the parser created
  while (rows.length > 0 && isEmptyRow(rows[rows.length - 1]!)) {
    rows.pop();
  }
  return rows;
}

function isEmptyRow(row: string[]): boolean {
  return row.every((c) => c === undefined || c === null || c.trim() === "");
}

// ---------------------------------------------------------------------------
// Internals -- format detection + column mapping
// ---------------------------------------------------------------------------

interface ColumnMapping {
  dateIdx: number;
  descriptionIdx: number;
  memoIdx: number;
  accountIdx: number;
  amountIdx: number;
  debitIdx: number;
  creditIdx: number;
  referenceIdx: number;
}

/**
 * Detect the CSV format from the header row.
 *   QuickBooks exports: "Date", "Num", "Name", "Memo", "Account", "Debit", "Credit"
 *   Xero exports:       "*Date", "*Description", "*Account Code", "*Tax Rate", "Amount"
 *                       or "Date,Description,Reference,Debit,Credit,Account Code"
 *   Generic:            anything with Date + (Amount | Debit + Credit)
 */
export function detectFormat(header: string[]): CsvFormat {
  const norm = header.map((h) => h.trim().toLowerCase().replace(/^\*/, ""));

  // QuickBooks: presence of "num" + "memo" + separate Debit/Credit is signature
  const hasQbSignature =
    norm.includes("num") &&
    norm.includes("memo") &&
    norm.includes("debit") &&
    norm.includes("credit");
  if (hasQbSignature) return "quickbooks";

  // Xero: asterisk-prefixed headers OR "account code" + "tax rate" OR "tracking name"
  const hasXeroAsterisk = header.some((h) => h.trim().startsWith("*"));
  const hasXeroAccountCode = norm.includes("account code");
  const hasXeroTaxRate = norm.includes("tax rate");
  if (hasXeroAsterisk || (hasXeroAccountCode && hasXeroTaxRate)) return "xero";

  return "generic";
}

/**
 * Build a ColumnMapping from the header + format hint.
 * All column indexes default to -1 when absent.
 */
export function buildColumnMapping(header: string[], _format: CsvFormat): ColumnMapping {
  const norm = header.map((h) => h.trim().toLowerCase().replace(/^\*/, ""));

  const findFirst = (candidates: string[]): number => {
    for (const cand of candidates) {
      const idx = norm.indexOf(cand);
      if (idx >= 0) return idx;
    }
    return -1;
  };

  return {
    dateIdx: findFirst(["date", "transaction date", "posting date", "txn date"]),
    descriptionIdx: findFirst([
      "description",
      "narration",
      "details",
      "payee",
      "name",
    ]),
    memoIdx: findFirst(["memo", "note", "notes"]),
    accountIdx: findFirst([
      "account",
      "account code",
      "account name",
      "ledger account",
      "gl account",
    ]),
    amountIdx: findFirst(["amount", "value", "net amount", "total"]),
    debitIdx: findFirst(["debit", "debits", "dr", "debit amount"]),
    creditIdx: findFirst(["credit", "credits", "cr", "credit amount"]),
    referenceIdx: findFirst([
      "reference",
      "ref",
      "num",
      "reference number",
      "invoice #",
      "invoice number",
      "doc number",
    ]),
  };
}

// ---------------------------------------------------------------------------
// Internals -- value parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a money string into a number. Accepts:
 *   "1,234.56" -> 1234.56
 *   "$1,234.56" -> 1234.56
 *   "(250.00)" -> -250.00 (accounting parentheses = negative)
 *   "-100"    -> -100
 *   ""        -> NaN (sentinel for "field absent")
 */
export function parseMoney(raw: string): number {
  if (!raw || raw.trim() === "") return NaN;
  let s = raw.trim();

  // Accounting parentheses indicate a negative number
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  // Strip currency symbols and thousands separators
  s = s.replace(/[\$£€¥,\s]/g, "");

  // Handle explicit leading sign
  if (s.startsWith("+")) s = s.slice(1);

  const n = Number(s);
  if (Number.isNaN(n)) return NaN;
  return negative ? -n : n;
}

/**
 * Normalize a date string to ISO YYYY-MM-DD if possible.
 * Leaves unparseable input untouched so callers can see it in the report.
 */
export function normalizeDate(raw: string): string {
  const s = raw.trim();
  if (!s) return s;

  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // MM/DD/YYYY or M/D/YYYY (US -- QuickBooks default)
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    const [, mm, dd, yyRaw] = us;
    const yy = yyRaw!.length === 2 ? `20${yyRaw}` : yyRaw!;
    return `${yy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
  }

  // DD/MM/YYYY is ambiguous with US format -- heuristic: if first component > 12,
  // assume day-first. Otherwise prefer US.
  const dmy = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmy) {
    const [, aRaw, bRaw, cRaw] = dmy;
    const a = Number(aRaw);
    const b = Number(bRaw);
    if (a > 12 && b <= 12) {
      // day-first
      return `${cRaw}-${bRaw!.padStart(2, "0")}-${aRaw!.padStart(2, "0")}`;
    }
    return `${cRaw}-${aRaw!.padStart(2, "0")}-${bRaw!.padStart(2, "0")}`;
  }

  return s;
}
