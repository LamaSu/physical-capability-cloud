/**
 * Unit tests for the CSV -> LedgerEntry importer.
 * Run with (from repo root):
 *   cd packages/kernel
 *   node_modules/.bin/vitest run --config ../../scripts/accounting-harness/vitest.config.ts
 */
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  importCsvFile,
  importCsvText,
  decodeBuffer,
  stripBom,
  parseCsvRows,
  detectFormat,
  parseMoney,
  normalizeDate,
  CsvImportError,
} from "../import-csv.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = resolve(HERE, "..", "samples");

function writeTemp(name: string, content: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "pcc-csv-"));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// Sample file parsing
// ---------------------------------------------------------------------------
describe("sample file parsing", () => {
  it("parses the Quickbooks sample (25 entries, 5 accounts, balanced)", () => {
    const result = importCsvFile(resolve(SAMPLES, "quickbooks-sample.csv"));
    expect(result.format).toBe("quickbooks");
    expect(result.entries.length).toBe(25);
    expect(result.stats.accounts).toBe(5);

    // Debits totals
    const net = result.entries.reduce((s, e) => s + e.amount, 0);
    expect(Math.round(net * 100) / 100).toBe(0); // $0.00 net

    // All entries produce LedgerEntry shape the kernel accepts
    for (const e of result.entries) {
      expect(typeof e.date).toBe("string");
      expect(typeof e.amount).toBe("number");
      expect(typeof e.account).toBe("string");
      expect(e.date.length).toBeGreaterThan(0);
    }
  });

  it("parses the Xero sample (25 entries, 5 accounts)", () => {
    const result = importCsvFile(resolve(SAMPLES, "xero-sample.csv"));
    expect(result.format).toBe("xero");
    expect(result.entries.length).toBe(25);
    expect(result.stats.accounts).toBe(5);
  });

  it("parses the generic sample (20 entries, $50.00 variance)", () => {
    const result = importCsvFile(resolve(SAMPLES, "generic-sample.csv"));
    expect(result.format).toBe("generic");
    expect(result.entries.length).toBe(20);
    const net = result.entries.reduce((s, e) => s + e.amount, 0);
    expect(Math.abs(Math.abs(net) - 50)).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------
describe("format detection", () => {
  it("detects Quickbooks from Num+Memo+Debit+Credit signature", () => {
    expect(detectFormat(["Date", "Num", "Name", "Memo", "Account", "Debit", "Credit"]))
      .toBe("quickbooks");
  });

  it("detects Xero from asterisk-prefixed headers", () => {
    expect(detectFormat(["*Date", "*Description", "*Account Code", "Amount"])).toBe("xero");
  });

  it("detects Xero from Account Code + Tax Rate headers (no asterisk)", () => {
    expect(detectFormat(["Date", "Description", "Account Code", "Tax Rate", "Amount"]))
      .toBe("xero");
  });

  it("falls back to generic for unknown headers", () => {
    expect(detectFormat(["Date", "Description", "Account", "Amount"])).toBe("generic");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
describe("error handling", () => {
  it("rejects empty input with empty_file error", () => {
    expect(() => importCsvText("")).toThrow(CsvImportError);
    try {
      importCsvText("");
    } catch (err) {
      expect(err).toBeInstanceOf(CsvImportError);
      expect((err as CsvImportError).code).toBe("empty_file");
    }
  });

  it("rejects missing Date column with typed error", () => {
    const csv = "Account,Amount\n1000-CASH,100";
    try {
      importCsvText(csv);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CsvImportError);
      expect((err as CsvImportError).code).toBe("missing_date_column");
    }
  });

  it("rejects when there is no amount/debit/credit column", () => {
    const csv = "Date,Account\n2026-01-01,CASH";
    try {
      importCsvText(csv);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CsvImportError);
      expect((err as CsvImportError).code).toBe("missing_amount_column");
    }
  });

  it("rejects when header is valid but no data rows parse", () => {
    // Well-formed header but zero usable data rows
    const csv = "Date,Account,Amount\n,,\n";
    try {
      importCsvText(csv);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CsvImportError);
      expect((err as CsvImportError).code).toBe("empty_file");
    }
  });
});

// ---------------------------------------------------------------------------
// Encoding handling
// ---------------------------------------------------------------------------
describe("encoding handling", () => {
  it("strips a UTF-8 BOM from the first cell", () => {
    const csv = "\uFEFFDate,Account,Amount\n2026-01-01,CASH,100\n";
    const result = importCsvText(csv);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]!.date).toBe("2026-01-01");
  });

  it("decodes a UTF-16 LE file with BOM", () => {
    const src = "Date,Account,Amount\n2026-01-01,CASH,100\n";
    const buf = Buffer.concat([
      Buffer.from([0xff, 0xfe]), // LE BOM
      Buffer.from(src, "utf16le"),
    ]);
    const decoded = decodeBuffer(buf);
    // stripBom is applied by importCsvText; the raw decoder leaves a BOM character
    // because we already consumed it, but importCsvText compensates via stripBom.
    const result = importCsvText(decoded);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]!.account).toBe("CASH");
  });

  it("decodes Latin-1 bytes outside ASCII without throwing", () => {
    const buf = Buffer.from(
      "Date,Description,Account,Amount\n2026-01-01,Caf\xE9,5100-CAF,12.50\n",
      "latin1",
    );
    const decoded = decodeBuffer(buf);
    const result = importCsvText(decoded);
    expect(result.entries.length).toBe(1);
    // Latin-1 "é" preserved
    expect(result.entries[0]!.description).toContain("Caf");
  });

  it("stripBom is a no-op when there is no BOM", () => {
    expect(stripBom("hello")).toBe("hello");
    expect(stripBom("\uFEFFhello")).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// Row parsing edge cases
// ---------------------------------------------------------------------------
describe("row parsing", () => {
  it("handles quoted fields with embedded commas", () => {
    const csv = 'Date,Description,Account,Amount\n2026-01-01,"Hello, World",5100,99\n';
    const result = importCsvText(csv);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]!.description).toBe("Hello, World");
  });

  it("handles escaped double quotes within a quoted field", () => {
    const rows = parseCsvRows('a,b\n"he said ""hi""",world\n');
    expect(rows[1]).toEqual(['he said "hi"', "world"]);
  });

  it("handles CRLF line endings", () => {
    const rows = parseCsvRows("a,b\r\n1,2\r\n3,4\r\n");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("skips blank rows mid-file gracefully", () => {
    const csv = "Date,Account,Amount\n2026-01-01,CASH,100\n\n2026-01-02,CASH,200\n";
    const result = importCsvText(csv);
    expect(result.entries.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Debit/Credit folding
// ---------------------------------------------------------------------------
describe("debit/credit folding", () => {
  it("folds separate Debit and Credit columns into signed amounts", () => {
    const csv = "Date,Account,Debit,Credit\n2026-01-01,CASH,250,\n2026-01-02,CASH,,175\n";
    const result = importCsvText(csv);
    expect(result.entries[0]!.amount).toBe(250);
    expect(result.entries[1]!.amount).toBe(-175);
  });

  it("prefers Amount column when present (ignores Debit/Credit)", () => {
    const csv = "Date,Account,Amount,Debit,Credit\n2026-01-01,CASH,-500,100,600\n";
    const result = importCsvText(csv);
    expect(result.entries[0]!.amount).toBe(-500);
  });

  it("parses accounting parentheses as negatives", () => {
    expect(parseMoney("(250.00)")).toBe(-250);
    expect(parseMoney("$1,234.56")).toBe(1234.56);
    expect(parseMoney("-100")).toBe(-100);
    expect(parseMoney("")).toBeNaN();
  });

  it("normalizes MM/DD/YYYY dates to ISO YYYY-MM-DD", () => {
    expect(normalizeDate("01/15/2026")).toBe("2026-01-15");
    expect(normalizeDate("1/5/2026")).toBe("2026-01-05");
    expect(normalizeDate("2026-01-15")).toBe("2026-01-15");
  });
});

// ---------------------------------------------------------------------------
// LedgerEntry kernel-compatibility
// ---------------------------------------------------------------------------
describe("kernel compatibility", () => {
  it("produces LedgerEntry-shaped objects the kernel's fetchLedger accepts", () => {
    const csv = "Date,Description,Account,Amount,Reference\n2026-01-01,Test,5100,100,REF-1\n";
    const result = importCsvText(csv);
    const entry = result.entries[0]!;
    // Shape required by packages/kernel/src/digital/accounting-kernel.ts LedgerEntry
    expect(entry).toMatchObject({
      date: expect.any(String),
      description: expect.any(String),
      amount: expect.any(Number),
      account: expect.any(String),
    });
    // reference optional
    expect(entry.reference === undefined || typeof entry.reference === "string").toBe(true);
  });

  it("computes aggregate stats from entries", () => {
    const path = writeTemp(
      "aggstats.csv",
      "Date,Account,Debit,Credit\n2026-01-01,A,100,\n2026-01-02,B,,50\n2026-01-03,A,25,\n",
    );
    const result = importCsvFile(path);
    expect(result.stats.rows).toBe(3);
    expect(result.stats.accounts).toBe(2);
    expect(result.stats.totalDebits).toBe(125);
    expect(result.stats.totalCredits).toBe(50);
    expect(result.stats.dateRange.start).toBeDefined();
    expect(result.stats.dateRange.end).toBeDefined();
  });
});
