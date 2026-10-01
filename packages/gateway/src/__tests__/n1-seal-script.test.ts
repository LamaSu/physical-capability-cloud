/**
 * N1 (Gate A): scripts/seal-custodial-keys.mjs, the operator-run migration that
 * seals the plaintext custodial keys already in api_keys.
 *
 * Everything runs against a THROWAWAY SQLite file made in this test (under
 * os.tmpdir()), through the real schema, with synthetic rows: viem-generated
 * keys, random-bytes KEK. Nothing reads a real key, an env file, or a real
 * database. The cases:
 *
 *   - a good row, an address-mismatch row, an already-sealed row (and a
 *     malformed key, a plaintext+sealed conflict, a row with no address);
 *   - dry run (the default) vs --apply: what is written, and what is not;
 *   - the counts, the exit codes, idempotence;
 *   - the ORDER of the steps: the unseal-verify happens before anything is
 *     written, and a failed verify leaves the row untouched;
 *   - one transaction: sealed set and plaintext NULLed together or not at all;
 *   - no key, full address, KEK or row id in stdout or stderr, ever.
 *
 * The in-process runs call the script's own exported main(); the last block
 * runs the real CLI in a child process (needs packages/db built, so it skips,
 * visibly, in a checkout that has not been built).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import {
  createStore,
  createDatabase,
  sealCustodialKey,
  unsealCustodialKey,
  CustodyKek,
  sql,
} from "@pcc/store";
// @ts-ignore: plain .mjs script, no declaration file
import * as script from "../../scripts/seal-custodial-keys.mjs";
import { initStore, closeStore } from "../db.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(here, "..", "..", "scripts", "seal-custodial-keys.mjs");
const DB_DIST = resolve(here, "..", "..", "..", "db", "dist", "index.js");

type Env = Record<string, string | undefined>;
type StateRow = { p: string | null; s: string | null; a: string | null };
type Entry = { address: string; outcome: string; reason?: string; keyAddress?: string };
type Report = {
  mode: string;
  database: { source: string };
  kekId: string;
  sealedColumnPresent: boolean;
  scanned: number;
  counts: Record<string, number>;
  rows: Entry[];
  clean: boolean;
  exit: number;
};

const fp = (address: string) =>
  `sha256:${createHash("sha256").update(address.toLowerCase(), "utf8").digest("hex").slice(0, 12)}`;

interface Seed {
  id: string;
  address?: string | null;
  plaintext?: string | null;
  sealed?: string | null;
}

describe("N1 seal-custodial-keys script", () => {
  let dir: string;
  let file: string;
  let kekBytes: Buffer;
  let kek: CustodyKek;
  let env: Env;
  /** Every secret-ish value this test created, for the "never printed" scans. */
  let secrets: string[];

  const newKey = () => {
    const key = generatePrivateKey();
    secrets.push(key, key.slice(2));
    return { key, address: privateKeyToAddress(key) };
  };

  function seed(rows: Seed[], dbFile = file): void {
    const store = createStore({ dbPath: dbFile, seed: false });
    rows.forEach((r, i) => {
      store.db.run(sql`INSERT INTO api_keys
        (id, key_hash, key_prefix, operator_id, scopes, created_at,
         operator_wallet_address, operator_wallet_private_key, operator_wallet_key_sealed)
        VALUES (${r.id}, ${`hash-${i}-${r.id}`}, 'pcc_test', ${`op-${r.id}`}, '["operator"]',
                ${new Date().toISOString()}, ${r.address ?? null}, ${r.plaintext ?? null}, ${r.sealed ?? null})`);
    });
    store.close();
  }

  function state(dbFile = file): Record<string, StateRow> {
    const { sqlite } = createDatabase(dbFile);
    try {
      const rows = sqlite
        .prepare(
          `SELECT id, operator_wallet_private_key AS p, operator_wallet_key_sealed AS s,
                  operator_wallet_address AS a FROM api_keys ORDER BY id`,
        )
        .all() as Array<StateRow & { id: string }>;
      return Object.fromEntries(rows.map((r) => [r.id, { p: r.p, s: r.s, a: r.a }]));
    } finally {
      sqlite.close();
    }
  }

  /** Run the script's own main() and capture EVERYTHING it (or a library under it) writes. */
  async function run(
    argv: string[] = [],
    over: { env?: Env; deps?: Record<string, unknown>; openDb?: unknown } = {},
  ) {
    const out: string[] = [];
    const err: string[] = [];
    const strays: string[] = [];
    const sink = (c: unknown) => {
      strays.push(String(c));
      return true;
    };
    const spies = [
      vi.spyOn(process.stdout, "write").mockImplementation(sink as never),
      vi.spyOn(process.stderr, "write").mockImplementation(sink as never),
      vi.spyOn(console, "log").mockImplementation(sink),
      vi.spyOn(console, "info").mockImplementation(sink),
      vi.spyOn(console, "warn").mockImplementation(sink),
      vi.spyOn(console, "error").mockImplementation(sink),
    ];
    let code: number;
    try {
      code = await script.main({
        argv,
        env: over.env ?? env,
        out: (s: string) => out.push(s),
        err: (s: string) => err.push(s),
        ...(over.deps ? { deps: over.deps } : {}),
        ...(over.openDb ? { openDb: over.openDb } : {}),
      });
    } finally {
      for (const s of spies) s.mockRestore();
    }
    const stdout = out.join("\n");
    const stderr = err.join("\n");
    const stray = strays.join("");
    return {
      code,
      stdout,
      stderr,
      stray,
      all: [stdout, stderr, stray].join("\n"),
      report: (stdout.trim().startsWith("{") ? JSON.parse(stdout) : null) as Report | null,
    };
  }

  /** Nothing secret-looking in what the script wrote. */
  function expectNoLeaks(text: string): void {
    const lower = text.toLowerCase();
    for (const s of secrets) {
      expect(lower.includes(s.toLowerCase()), "a key, address, KEK or row id appeared in the output").toBe(false);
    }
    expect(text).not.toMatch(/(?:0x)?[0-9a-fA-F]{40,}/); // no key- or address-length hex run at all
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "n1-seal-"));
    file = join(dir, "throwaway.sqlite");
    kekBytes = randomBytes(32);
    kek = new CustodyKek("k1", kekBytes);
    secrets = [kekBytes.toString("base64"), kekBytes.toString("hex"), kekBytes.toString("base64url")];
    env = {
      PCC_DB_PATH: file,
      PCC_CUSTODY_KEK: kekBytes.toString("base64"),
      PCC_CUSTODY_KEK_ID: "k1",
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** good (checksummed address), good (lowercase address), already sealed, and one more for the mixed case. */
  function cleanRows() {
    const g1 = newKey();
    const g2 = newKey();
    const s1 = newKey();
    const rows: Seed[] = [
      { id: "rowid-a-good1", address: g1.address, plaintext: g1.key },
      { id: "rowid-b-good2", address: g2.address.toLowerCase(), plaintext: g2.key },
      {
        id: "rowid-c-sealed",
        address: s1.address,
        sealed: sealCustodialKey(s1.key, { rowId: "rowid-c-sealed", address: s1.address }, kek),
      },
    ];
    secrets.push(...rows.map((r) => r.id), g1.address, g2.address, s1.address);
    return { g1, g2, s1, rows };
  }

  function mixedRows() {
    const g = newKey();
    const m = newKey();
    const other = newKey(); // the wallet the mismatched row is wrongly filed under
    const s = newKey();
    const rows: Seed[] = [
      { id: "rowid-a-good", address: g.address, plaintext: g.key },
      { id: "rowid-b-mismatch", address: other.address, plaintext: m.key },
      {
        id: "rowid-c-sealed",
        address: s.address,
        sealed: sealCustodialKey(s.key, { rowId: "rowid-c-sealed", address: s.address }, kek),
      },
    ];
    secrets.push(...rows.map((r) => r.id), g.address, m.address, other.address, s.address);
    return { g, m, other, s, rows };
  }

  // ── clean database ──────────────────────────────────────────────────
  describe("a clean database (two good rows, one already sealed)", () => {
    it("DRY RUN (the default): reports, exits 0, and writes NOTHING", async () => {
      const { g1, g2, rows } = cleanRows();
      seed(rows);
      const before = state();

      const r = await run([]);

      expect(r.code).toBe(0);
      expect(r.report).toMatchObject({
        mode: "dry-run",
        database: { source: "PCC_DB_PATH" },
        kekId: "k1",
        sealedColumnPresent: true,
        scanned: 3,
        clean: true,
        exit: 0,
        counts: {
          plaintextRows: 2,
          alreadySealed: 1,
          wouldSeal: 2,
          sealed: 0,
          addressMismatch: 0,
          malformedKey: 0,
          conflict: 0,
          failed: 0,
        },
      });
      expect(r.report!.rows).toEqual([
        { address: fp(g1.address), outcome: "would_seal" },
        { address: fp(g2.address), outcome: "would_seal" },
      ]);
      expect(r.stderr).toContain("DRY RUN");
      // The database is exactly as it was: plaintext still there, nothing sealed.
      expect(state()).toEqual(before);
      expect(state()["rowid-a-good1"].p).toBe(g1.key);
      expect(state()["rowid-a-good1"].s).toBeNull();
      expectNoLeaks(r.all);
    });

    it("--apply: seals both, NULLs the plaintext, every blob unseals to its key, the sealed row is untouched", async () => {
      const { g1, g2, rows } = cleanRows();
      seed(rows);
      const before = state();

      const r = await run(["--apply"]);

      expect(r.code).toBe(0);
      expect(r.report).toMatchObject({
        mode: "apply",
        clean: true,
        exit: 0,
        counts: { plaintextRows: 2, alreadySealed: 1, wouldSeal: 0, sealed: 2, failed: 0, addressMismatch: 0 },
      });
      expect(r.report!.rows).toEqual([
        { address: fp(g1.address), outcome: "sealed" },
        { address: fp(g2.address), outcome: "sealed" },
      ]);
      expect(r.stderr).not.toContain("DRY RUN");

      const after = state();
      for (const [id, k] of [
        ["rowid-a-good1", g1],
        ["rowid-b-good2", g2],
      ] as const) {
        expect(after[id].p, `${id}: plaintext NULLed`).toBeNull();
        expect(after[id].s).toMatch(/^pcc-seal:v1:k1:/);
        expect(
          unsealCustodialKey(after[id].s!, { rowId: id, address: after[id].a! }, kek) === k.key,
          `${id}: the sealed blob unseals to the original key`,
        ).toBe(true);
        // Bound to its own row.
        expect(() => unsealCustodialKey(after[id].s!, { rowId: "other-row", address: after[id].a! }, kek)).toThrow();
      }
      // The address column is not touched.
      expect(after["rowid-b-good2"].a).toBe(g2.address.toLowerCase());
      // The already-sealed row is byte-for-byte what it was.
      expect(after["rowid-c-sealed"]).toEqual(before["rowid-c-sealed"]);
      expectNoLeaks(r.all);
    });

    it("is idempotent: a second --apply finds nothing left to do and is clean", async () => {
      const { rows } = cleanRows();
      seed(rows);
      await run(["--apply"]);
      const afterFirst = state();
      const r = await run(["--apply"]);
      expect(r.code).toBe(0);
      expect(r.report!.counts).toMatchObject({ plaintextRows: 0, alreadySealed: 3, sealed: 0, failed: 0 });
      expect(r.report!.rows).toEqual([]);
      expect(state()).toEqual(afterFirst);
      // And a dry run after the fact agrees.
      const dry = await run([]);
      expect(dry.code).toBe(0);
      expect(dry.report!.counts).toMatchObject({ plaintextRows: 0, alreadySealed: 3, wouldSeal: 0 });
    });
  });

  // ── mixed database ──────────────────────────────────────────────────
  describe("a database with an address-mismatch row (good + mismatch + already sealed)", () => {
    it("DRY RUN: exits 3, counts the mismatch, writes nothing", async () => {
      const { g, m, other, rows } = mixedRows();
      seed(rows);
      const before = state();

      const r = await run([]);

      expect(r.code).toBe(3);
      expect(r.report).toMatchObject({
        mode: "dry-run",
        clean: false,
        exit: 3,
        scanned: 3,
        counts: { plaintextRows: 2, alreadySealed: 1, wouldSeal: 1, sealed: 0, addressMismatch: 1, failed: 0 },
      });
      expect(r.report!.rows).toEqual([
        { address: fp(g.address), outcome: "would_seal" },
        {
          address: fp(other.address), // the wallet it is filed under
          outcome: "address_mismatch",
          reason: expect.stringContaining("different address"),
          keyAddress: fp(m.address), // the wallet the key actually belongs to
        },
      ]);
      expect(state()).toEqual(before);
      expectNoLeaks(r.all);
    });

    it("--apply: seals the good row, does NOT seal the mismatch (plaintext kept, nothing sealed), exits 3", async () => {
      const { g, m, rows } = mixedRows();
      seed(rows);
      const before = state();

      const r = await run(["--apply"]);

      expect(r.code).toBe(3);
      expect(r.report!.counts).toMatchObject({
        plaintextRows: 2,
        alreadySealed: 1,
        sealed: 1,
        wouldSeal: 0,
        addressMismatch: 1,
        failed: 0,
      });
      const after = state();
      // good: sealed
      expect(after["rowid-a-good"].p).toBeNull();
      expect(unsealCustodialKey(after["rowid-a-good"].s!, { rowId: "rowid-a-good", address: after["rowid-a-good"].a! }, kek) === g.key).toBe(true);
      // mismatch: untouched, the key stays where it was for a human to look at
      expect(after["rowid-b-mismatch"]).toEqual(before["rowid-b-mismatch"]);
      expect(after["rowid-b-mismatch"].p).toBe(m.key);
      expect(after["rowid-b-mismatch"].s).toBeNull();
      // sealed: untouched
      expect(after["rowid-c-sealed"]).toEqual(before["rowid-c-sealed"]);
      expectNoLeaks(r.all);
    });

    it("compares the address case-insensitively, and a one-digit difference is a mismatch", async () => {
      const k = newKey();
      const flipped = `${k.address.slice(0, -1)}${k.address.endsWith("0") ? "1" : "0"}`;
      secrets.push(flipped);
      seed([
        { id: "rowid-upper", address: `0x${k.address.slice(2).toUpperCase()}`, plaintext: k.key },
        { id: "rowid-off-by-one", address: flipped, plaintext: newKey().key },
      ]);
      const r = await run(["--apply"]);
      expect(r.code).toBe(3);
      expect(r.report!.counts).toMatchObject({ sealed: 1, addressMismatch: 1 });
      expect(state()["rowid-upper"].p).toBeNull();
      expect(state()["rowid-off-by-one"].p).not.toBeNull();
    });
  });

  // ── other row classes ───────────────────────────────────────────────
  describe("other kinds of rows", () => {
    it("a malformed key is reported and NOT sealed (exit 3)", async () => {
      const a = newKey();
      secrets.push(a.address, "rowid-bad");
      seed([
        { id: "rowid-bad", address: a.address, plaintext: "this-is-not-a-private-key" },
        { id: "rowid-short", address: a.address.toLowerCase(), plaintext: `0x${randomBytes(31).toString("hex")}` },
        { id: "rowid-zero", address: a.address.toLowerCase(), plaintext: `0x${"00".repeat(32)}` },
      ]);
      const before = state();
      const r = await run(["--apply"]);
      expect(r.code).toBe(3);
      expect(r.report!.counts).toMatchObject({ plaintextRows: 3, malformedKey: 3, sealed: 0, failed: 0 });
      expect(r.report!.rows.every((e) => e.outcome === "malformed_key")).toBe(true);
      expect(state()).toEqual(before);
      expectNoLeaks(r.all);
    });

    it("a row with BOTH a plaintext key and a sealed value is a conflict: left alone, exit 3", async () => {
      const k = newKey();
      const blob = sealCustodialKey(k.key, { rowId: "rowid-both", address: k.address }, kek);
      secrets.push("rowid-both", k.address);
      seed([{ id: "rowid-both", address: k.address, plaintext: k.key, sealed: blob }]);
      const before = state();
      const r = await run(["--apply"]);
      expect(r.code).toBe(3);
      expect(r.report!.counts).toMatchObject({ plaintextRows: 1, conflict: 1, sealed: 0 });
      expect(r.report!.rows[0]).toMatchObject({ outcome: "conflict" });
      expect(state()).toEqual(before); // never destroys a plaintext key next to a sealed value it did not verify
    });

    it("a plaintext key with no operator_wallet_address cannot be checked and is NOT sealed", async () => {
      const k = newKey();
      secrets.push("rowid-noaddr");
      seed([{ id: "rowid-noaddr", address: null, plaintext: k.key }]);
      const r = await run(["--apply"]);
      expect(r.code).toBe(3);
      expect(r.report!.counts).toMatchObject({ addressMismatch: 1, sealed: 0 });
      expect(r.report!.rows[0]).toMatchObject({ address: "none", outcome: "address_mismatch" });
      expect(r.report!.rows[0].reason).toContain("no operator_wallet_address");
      expect(state()["rowid-noaddr"].p).toBe(k.key);
    });

    it("rows with no custodial key at all, and blank values, are not counted or touched", async () => {
      const a = newKey();
      secrets.push(a.address);
      seed([
        { id: "rowid-nowallet" },
        { id: "rowid-blank", address: a.address, plaintext: "   ", sealed: "" },
      ]);
      const before = state();
      const r = await run(["--apply"]);
      expect(r.code).toBe(0);
      expect(r.report).toMatchObject({
        scanned: 2,
        counts: { plaintextRows: 0, alreadySealed: 0, sealed: 0, failed: 0 },
      });
      expect(state()).toEqual(before);
    });

    it("seals a key stored without the 0x prefix, and the unseal returns it exactly as stored", async () => {
      const k = newKey();
      const bare = k.key.slice(2).toUpperCase(); // bare AND upper-case: stored verbatim, sealed verbatim
      secrets.push(bare, k.address, "rowid-bare");
      seed([{ id: "rowid-bare", address: k.address, plaintext: bare }]);
      const r = await run(["--apply"]);
      expect(r.code).toBe(0);
      const after = state()["rowid-bare"];
      expect(after.p).toBeNull();
      expect(unsealCustodialKey(after.s!, { rowId: "rowid-bare", address: k.address }, kek)).toBe(bare);
      expectNoLeaks(r.all);
    });
  });

  // ── the order of the steps, and the transaction ─────────────────────
  describe("verify-then-write, and one transaction", () => {
    it("the unseal-verify runs BEFORE anything is written: at that moment the row still holds the plaintext and no sealed value", async () => {
      const { rows } = cleanRows();
      seed(rows);
      const atVerify: Array<StateRow> = [];
      const r = await run(["--apply"], {
        deps: {
          unseal: (blob: string, ctx: { rowId: string; address: string }, k: CustodyKek) => {
            atVerify.push(state()[ctx.rowId]);
            return unsealCustodialKey(blob, ctx, k);
          },
        },
      });
      expect(r.code).toBe(0);
      expect(atVerify).toHaveLength(2);
      for (const s of atVerify) {
        expect(s.p, "plaintext still present when the verify runs").not.toBeNull();
        expect(s.s, "nothing sealed yet when the verify runs").toBeNull();
      }
    });

    it("[neg] a seal that does not unseal back to the same key is a failure: the row is left UNTOUCHED, exit 4", async () => {
      const { rows } = cleanRows();
      seed(rows);
      const before = state();
      const r = await run(["--apply"], {
        deps: {
          // A "seal" bound to the wrong row: the verify (for the real row) must refuse it.
          seal: (key: string, ctx: { rowId: string; address: string }, k: CustodyKek) =>
            sealCustodialKey(key, { rowId: `${ctx.rowId}-wrong`, address: ctx.address }, k),
        },
      });
      expect(r.code).toBe(4);
      expect(r.report!.counts).toMatchObject({ plaintextRows: 2, failed: 2, sealed: 0 });
      expect(r.report!.rows.map((e) => e.outcome)).toEqual(["failed", "failed"]);
      expect(r.report!.rows[0].reason).toContain("verify_failed");
      expect(state()).toEqual(before); // plaintext kept, nothing sealed
      expectNoLeaks(r.all);
    });

    it("[neg] an unseal that returns a DIFFERENT key, or throws, is a failure and the row is untouched", async () => {
      const { rows } = cleanRows();
      seed(rows);
      const before = state();
      const different = await run(["--apply"], {
        deps: { unseal: () => `0x${randomBytes(32).toString("hex")}` },
      });
      expect(different.code).toBe(4);
      expect(state()).toEqual(before);
      const throws = await run(["--apply"], {
        deps: {
          unseal: () => {
            throw new Error("boom");
          },
        },
      });
      expect(throws.code).toBe(4);
      expect(throws.report!.counts).toMatchObject({ failed: 2, sealed: 0 });
      expect(state()).toEqual(before);
    });

    it("a dry run also runs the verify, so a bad seal shows up BEFORE anyone passes --apply", async () => {
      const { rows } = cleanRows();
      seed(rows);
      const r = await run([], {
        deps: { unseal: () => "0xnot-the-key" },
      });
      expect(r.code).toBe(4);
      expect(r.report).toMatchObject({ mode: "dry-run", counts: { failed: 2, wouldSeal: 0 } });
    });

    it("a seal that throws is a failure with a static reason, row untouched", async () => {
      const { rows } = cleanRows();
      seed(rows);
      const before = state();
      const r = await run(["--apply"], {
        deps: {
          seal: (key: string) => {
            throw new Error(`cannot seal ${key}`);
          },
        },
      });
      expect(r.code).toBe(4);
      expect(r.report!.rows.every((e) => e.reason === "seal_failed")).toBe(true);
      expect(state()).toEqual(before);
      expectNoLeaks(r.all); // the thrown message held the key; it is never echoed
    });

    it("compare-and-swap: a row changed while the script runs is NOT overwritten (row_changed, exit 4)", async () => {
      const k = newKey();
      secrets.push("rowid-race", k.address);
      seed([{ id: "rowid-race", address: k.address, plaintext: k.key }]);
      const replacement = newKey().key;
      const r = await run(["--apply"], {
        deps: {
          // Runs after the row was read and before it is written: someone else updates the row.
          seal: (key: string, ctx: { rowId: string; address: string }, kk: CustodyKek) => {
            const { sqlite } = createDatabase(file);
            sqlite.prepare("UPDATE api_keys SET operator_wallet_private_key = ? WHERE id = ?").run(replacement, ctx.rowId);
            sqlite.close();
            return sealCustodialKey(key, ctx, kk);
          },
        },
      });
      expect(r.code).toBe(4);
      expect(r.report!.rows[0]).toMatchObject({ outcome: "failed" });
      expect(r.report!.rows[0].reason).toContain("row_changed");
      const after = state()["rowid-race"];
      expect(after.p).toBe(replacement); // the other writer's value survives
      expect(after.s).toBeNull(); // and nothing was sealed over it
    });

    it.each(["operator_wallet_key_sealed", "operator_wallet_private_key"])(
      "one transaction: if the write fails on %s, NEITHER the sealed value NOR the NULL plaintext lands",
      async (column) => {
        const k = newKey();
        secrets.push("rowid-tx", k.address);
        seed([{ id: "rowid-tx", address: k.address, plaintext: k.key }]);
        // A trigger that aborts any statement touching ONE of the two columns. Setting the
        // two columns in separate statements would leave the other half behind (a sealed
        // value next to a surviving plaintext, or a NULLed plaintext with nothing sealed:
        // data loss); one atomic UPDATE in one transaction leaves nothing, whichever half fails.
        const { sqlite } = createDatabase(file);
        sqlite.exec(`CREATE TRIGGER n1_abort BEFORE UPDATE OF ${column} ON api_keys
                     BEGIN SELECT RAISE(ABORT, 'synthetic abort'); END;`);
        sqlite.close();
        const r = await run(["--apply"]);
        expect(r.code).toBe(4);
        expect(r.report!.rows[0]).toMatchObject({ outcome: "failed" });
        expect(r.report!.rows[0].reason).toContain("write_failed");
        const after = state()["rowid-tx"];
        expect(after.p).toBe(k.key);
        expect(after.s).toBeNull();
      },
    );

    it("a failure on one row does not stop the others", async () => {
      const bad = newKey();
      const good = newKey();
      secrets.push("rowid-1", "rowid-2", bad.address, good.address);
      seed([
        { id: "rowid-1", address: bad.address, plaintext: bad.key },
        { id: "rowid-2", address: good.address, plaintext: good.key },
      ]);
      const r = await run(["--apply"], {
        deps: {
          seal: (key: string, ctx: { rowId: string; address: string }, k: CustodyKek) => {
            if (ctx.rowId === "rowid-1") throw new Error("first one fails");
            return sealCustodialKey(key, ctx, k);
          },
        },
      });
      expect(r.code).toBe(4);
      expect(r.report!.counts).toMatchObject({ failed: 1, sealed: 1 });
      expect(state()["rowid-1"].p).toBe(bad.key);
      expect(state()["rowid-2"].p).toBeNull();
      expect(state()["rowid-2"].s).not.toBeNull();
    });
  });

  // ── cannot start ────────────────────────────────────────────────────
  describe("cannot start (exit 2): nothing is touched", () => {
    const badKek: Array<[string, Env]> = [
      ["no KEK", { PCC_CUSTODY_KEK: undefined }],
      ["blank KEK", { PCC_CUSTODY_KEK: "" }],
      ["short KEK", { PCC_CUSTODY_KEK: randomBytes(31).toString("base64") }],
      ["hex KEK", { PCC_CUSTODY_KEK: randomBytes(32).toString("hex") }],
      ["no KEK id", { PCC_CUSTODY_KEK_ID: undefined }],
      ["malformed KEK id", { PCC_CUSTODY_KEK_ID: "k:1" }],
    ];

    it.each(badKek)("[neg] %s: exit 2, no report, DB untouched, KEK value not echoed", async (_n, over) => {
      const { rows } = cleanRows();
      seed(rows);
      const before = state();
      const e = { ...env, ...over };
      for (const k of Object.keys(over)) if (over[k] === undefined) delete e[k];
      const r = await run(["--apply"], { env: e });
      expect(r.code).toBe(2);
      expect(r.report).toBeNull();
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("no valid custody KEK");
      expect(state()).toEqual(before);
      for (const v of Object.values(over)) {
        if (v && v.length > 3) expect(r.all).not.toContain(v);
      }
      expectNoLeaks(r.all);
    });

    it.each([["--aply"], ["apply"], ["--apply=true"], ["-x"], ["--apply", "--force"]])(
      "[neg] an unknown argument (%s) is a usage error, never a silent dry run",
      async (...argv) => {
        const { rows } = cleanRows();
        seed(rows);
        const before = state();
        const r = await run(argv);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("usage:");
        expect(r.stdout).toBe("");
        expect(state()).toEqual(before);
      },
    );

    it("--help prints the usage and exits 0 without touching anything", async () => {
      const { rows } = cleanRows();
      seed(rows);
      const before = state();
      const r = await run(["--help"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("--apply");
      expect(state()).toEqual(before);
    });

    it("a database file that does not exist is an error, and the file is NOT created", async () => {
      const missing = join(dir, "no-such.sqlite");
      const r = await run(["--apply"], { env: { ...env, PCC_DB_PATH: missing } });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("does not exist");
      expect(existsSync(missing)).toBe(false);
    });

    it("a database with no api_keys table is an error", async () => {
      const { sqlite } = createDatabase(file);
      sqlite.exec("CREATE TABLE unrelated (x TEXT)");
      sqlite.close();
      const r = await run([]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("no api_keys table");
    });

    it("--apply before the sealed column exists is refused (exit 2); a dry run still reports; the schema is never altered", async () => {
      const k = newKey();
      secrets.push("rowid-legacy", k.address);
      const { sqlite } = createDatabase(file);
      sqlite.exec(`CREATE TABLE api_keys (
        id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL, operator_id TEXT NOT NULL,
        scopes TEXT NOT NULL, created_at TEXT NOT NULL, operator_wallet_address TEXT, operator_wallet_private_key TEXT)`);
      sqlite
        .prepare(
          "INSERT INTO api_keys (id, key_hash, key_prefix, operator_id, scopes, created_at, operator_wallet_address, operator_wallet_private_key) VALUES ('rowid-legacy','h','p','o','[]','now',?,?)",
        )
        .run(k.address, k.key);
      sqlite.close();

      const apply = await run(["--apply"]);
      expect(apply.code).toBe(2);
      expect(apply.stderr).toContain("operator_wallet_key_sealed does not exist");

      const dry = await run([]);
      expect(dry.code).toBe(0);
      expect(dry.report).toMatchObject({ sealedColumnPresent: false, counts: { plaintextRows: 1, wouldSeal: 1 } });

      const handle = createDatabase(file);
      const names = (handle.sqlite.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>).map((c) => c.name);
      handle.sqlite.close();
      expect(names).not.toContain("operator_wallet_key_sealed"); // no schema change from the script
      expectNoLeaks(`${apply.all}\n${dry.all}`);
    });
  });

  // ── output hygiene under hostile conditions ─────────────────────────
  describe("no key, full address, KEK or row id is ever printed", () => {
    it("holds across every mode and every row class at once", async () => {
      const c = cleanRows();
      const m = mixedRows();
      const k = newKey();
      secrets.push("rowid-weird", k.address);
      seed([
        ...c.rows,
        ...m.rows.map((r) => ({ ...r, id: `${r.id}-m` })),
        { id: "rowid-weird", address: k.address, plaintext: "not-a-key" },
      ]);
      secrets.push(...m.rows.map((r) => `${r.id}-m`));
      const outputs: string[] = [];
      for (const argv of [[], ["--apply"], ["--apply"], []]) {
        outputs.push((await run(argv)).all);
      }
      expectNoLeaks(outputs.join("\n"));
      // what IS printed: fingerprints, 12 hex
      expect(outputs.join("\n")).toMatch(/sha256:[0-9a-f]{12}"/);
      expect(outputs.join("\n")).not.toMatch(/sha256:[0-9a-f]{13,}/);
    });

    it("error text from a library that echoes the key is scrubbed (derive failure, broken handle)", async () => {
      const k = newKey();
      secrets.push("rowid-x", k.address);
      seed([{ id: "rowid-x", address: k.address, plaintext: k.key }]);
      // 1. deriveAddress throws a message containing the key: treated as an unusable key, never echoed
      const r1 = await run(["--apply"], {
        deps: {
          deriveAddress: (key: string) => {
            throw new Error(`invalid private key ${key}`);
          },
        },
      });
      expect(r1.code).toBe(3);
      expect(r1.report!.rows[0].outcome).toBe("malformed_key");
      expectNoLeaks(r1.all);
      // 2. an unexpected failure whose message holds the key and an address: scrubbed, exit 4
      const r2 = await run(["--apply"], {
        openDb: () => ({
          client: {
            prepare: () => {
              throw new Error(`db exploded while holding ${k.key} for ${k.address}`);
            },
          },
          close: () => {},
        }),
      });
      expect(r2.code).toBe(4);
      expect(r2.stderr).toContain("[redacted]");
      expectNoLeaks(r2.all);
      // 3. the same for a database that cannot be opened
      const r3 = await run(["--apply"], {
        openDb: () => {
          throw new Error(`cannot open ${k.key}`);
        },
      });
      expect(r3.code).toBe(2);
      expectNoLeaks(r3.all);
    });

    it("the default writers: report on stdout, banner on stderr, nothing stray from any library", async () => {
      const { rows } = cleanRows();
      seed(rows);
      const written: Array<["out" | "err", string]> = [];
      const o = vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
        written.push(["out", String(c)]);
        return true;
      }) as never);
      const e = vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => {
        written.push(["err", String(c)]);
        return true;
      }) as never);
      let code: number;
      try {
        code = await script.main({ argv: [], env });
      } finally {
        o.mockRestore();
        e.mockRestore();
      }
      expect(code).toBe(0);
      const stdout = written.filter((w) => w[0] === "out").map((w) => w[1]).join("");
      const stderr = written.filter((w) => w[0] === "err").map((w) => w[1]).join("");
      expect(JSON.parse(stdout).mode).toBe("dry-run"); // stdout is exactly one JSON document
      expect(stderr).toContain("DRY RUN");
      expectNoLeaks(`${stdout}\n${stderr}`);
    });
  });

  // ── same database the gateway would open ────────────────────────────
  describe("the database it targets", () => {
    const saved: Env = {};
    const names = ["DATABASE_URL", "RAILWAY_VOLUME_MOUNT_PATH", "PCC_DB_PATH"];
    beforeEach(() => {
      for (const n of names) saved[n] = process.env[n];
    });
    afterEach(() => {
      closeStore();
      for (const n of names) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
    });

    /** Run the gateway's real initStore under `e` and report which file it created. */
    function gatewayOpens(e: Env, candidates: string[]): string[] {
      for (const n of names) delete process.env[n];
      for (const [k, v] of Object.entries(e)) if (v !== undefined) process.env[k] = v;
      initStore({ seed: false });
      closeStore();
      return candidates.filter((c) => existsSync(c));
    }

    it("resolves the SAME file as src/db.ts initStore, for every priority combination", () => {
      const vol = join(dir, "vol");
      mkdirSync(vol, { recursive: true });
      const urlFile = join(dir, "url.sqlite");
      const pccFile = join(dir, "pcc.sqlite");
      const volFile = join(vol, "pcc.db");
      const defaultFile = join(dir, "default-cwd.sqlite");
      const cases: Env[] = [
        { DATABASE_URL: urlFile, RAILWAY_VOLUME_MOUNT_PATH: vol, PCC_DB_PATH: pccFile },
        { DATABASE_URL: urlFile },
        { RAILWAY_VOLUME_MOUNT_PATH: vol, PCC_DB_PATH: pccFile },
        { RAILWAY_VOLUME_MOUNT_PATH: vol },
        { PCC_DB_PATH: pccFile },
      ];
      for (const c of cases) {
        for (const f of [urlFile, pccFile, volFile, defaultFile]) rmSync(f, { force: true });
        const mine = script.resolveDbPath(c).path as string;
        const opened = gatewayOpens(c, [urlFile, pccFile, volFile]);
        expect(opened, `case ${JSON.stringify(Object.keys(c))}`).toEqual([mine]);
      }
      // Nothing set: both fall back to the same default path.
      expect(script.resolveDbPath({}).path).toBe("./data/pcc.sqlite");
      expect(script.resolveDbPath({}).source).toBe("default");
      expect(script.resolveDbPath({ PCC_DB_PATH: "/x/y.db" })).toEqual({ path: "/x/y.db", source: "PCC_DB_PATH" });
    });
  });
});

// ── the real CLI, in a child process ───────────────────────────────────
describe.skipIf(!existsSync(DB_DIST))("N1 seal-custodial-keys script: the real CLI in a child process", () => {
  let dir: string;
  let file: string;
  let kekBytes: Buffer;
  let kek: CustodyKek;
  const secrets: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "n1-seal-cli-"));
    file = join(dir, "throwaway.sqlite");
    kekBytes = randomBytes(32);
    kek = new CustodyKek("k1", kekBytes);
    secrets.length = 0;
    secrets.push(kekBytes.toString("base64"), kekBytes.toString("hex"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function seedRows(rows: Seed[]): void {
    const store = createStore({ dbPath: file, seed: false });
    rows.forEach((r, i) => {
      store.db.run(sql`INSERT INTO api_keys
        (id, key_hash, key_prefix, operator_id, scopes, created_at,
         operator_wallet_address, operator_wallet_private_key, operator_wallet_key_sealed)
        VALUES (${r.id}, ${`hash-${i}-${r.id}`}, 'pcc_test', ${`op-${r.id}`}, '["operator"]',
                ${new Date().toISOString()}, ${r.address ?? null}, ${r.plaintext ?? null}, ${r.sealed ?? null})`);
    });
    store.close();
  }
  function readState(): Record<string, StateRow> {
    const { sqlite } = createDatabase(file);
    try {
      const rows = sqlite
        .prepare(
          "SELECT id, operator_wallet_private_key AS p, operator_wallet_key_sealed AS s, operator_wallet_address AS a FROM api_keys ORDER BY id",
        )
        .all() as Array<StateRow & { id: string }>;
      return Object.fromEntries(rows.map((r) => [r.id, { p: r.p, s: r.s, a: r.a }]));
    } finally {
      sqlite.close();
    }
  }
  /** Spawn the script exactly as an operator would, with ONLY the env given here. */
  function cli(args: string[], env: Env = {}) {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
      env: {
        PCC_DB_PATH: file,
        PCC_CUSTODY_KEK: kekBytes.toString("base64"),
        PCC_CUSTODY_KEK_ID: "k1",
        ...env,
      } as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 120_000,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: `${r.stdout}\n${r.stderr}` };
  }
  const leaks = (text: string) => secrets.filter((s) => text.toLowerCase().includes(s.toLowerCase()));

  function mixed() {
    const g = generatePrivateKey();
    const m = generatePrivateKey();
    const other = privateKeyToAddress(generatePrivateKey());
    const s = generatePrivateKey();
    const sAddr = privateKeyToAddress(s);
    secrets.push(g, g.slice(2), m, m.slice(2), privateKeyToAddress(g), privateKeyToAddress(m), other, s, s.slice(2), sAddr);
    seedRows([
      { id: "cli-row-good", address: privateKeyToAddress(g), plaintext: g },
      { id: "cli-row-mismatch", address: other, plaintext: m },
      { id: "cli-row-sealed", address: sAddr, sealed: sealCustodialKey(s, { rowId: "cli-row-sealed", address: sAddr }, kek) },
    ]);
    return { g, m, other };
  }

  it("dry run (default): exit 3 on a mismatch, one JSON document on stdout, banner on stderr, DB unchanged", () => {
    const { g, m } = mixed();
    const before = readState();
    const r = cli([]);
    expect(r.status, `stderr: ${r.stderr.slice(0, 400)}`).toBe(3);
    const report = JSON.parse(r.stdout) as Report;
    expect(report).toMatchObject({
      mode: "dry-run",
      exit: 3,
      clean: false,
      counts: { plaintextRows: 2, alreadySealed: 1, wouldSeal: 1, addressMismatch: 1, sealed: 0, failed: 0 },
    });
    expect(report.rows.map((e) => e.outcome)).toEqual(["would_seal", "address_mismatch"]);
    expect(r.stderr).toContain("DRY RUN");
    expect(readState()).toEqual(before);
    expect(readState()["cli-row-good"].p).toBe(g);
    expect(readState()["cli-row-mismatch"].p).toBe(m);
    expect(leaks(r.all)).toEqual([]);
    expect(r.all).not.toMatch(/(?:0x)?[0-9a-fA-F]{40,}/);
  });

  it("--apply: exit 3 on a mismatch; the good row is sealed (verifiable), the mismatch row is untouched", () => {
    const { g, m } = mixed();
    const r = cli(["--apply"]);
    expect(r.status, `stderr: ${r.stderr.slice(0, 400)}`).toBe(3);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.counts).toMatchObject({ sealed: 1, addressMismatch: 1, failed: 0 });
    const after = readState();
    expect(after["cli-row-good"].p).toBeNull();
    expect(unsealCustodialKey(after["cli-row-good"].s!, { rowId: "cli-row-good", address: after["cli-row-good"].a! }, kek)).toBe(g);
    expect(after["cli-row-mismatch"].p).toBe(m);
    expect(after["cli-row-mismatch"].s).toBeNull();
    expect(leaks(r.all)).toEqual([]);
    expect(r.all).not.toMatch(/(?:0x)?[0-9a-fA-F]{40,}/);
  });

  it("--apply on a clean database: exit 0, and a second run is a clean no-op", () => {
    const g1 = generatePrivateKey();
    const g2 = generatePrivateKey();
    secrets.push(g1, g1.slice(2), g2, g2.slice(2), privateKeyToAddress(g1), privateKeyToAddress(g2));
    seedRows([
      { id: "cli-a", address: privateKeyToAddress(g1), plaintext: g1 },
      { id: "cli-b", address: privateKeyToAddress(g2).toLowerCase(), plaintext: g2 },
    ]);
    const first = cli(["--apply"]);
    expect(first.status, `stderr: ${first.stderr.slice(0, 400)}`).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ clean: true, counts: { sealed: 2, failed: 0 } });
    expect(readState()["cli-a"].p).toBeNull();
    expect(readState()["cli-b"].p).toBeNull();
    const second = cli(["--apply"]);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout).counts).toMatchObject({ plaintextRows: 0, alreadySealed: 2, sealed: 0 });
    expect(leaks(`${first.all}\n${second.all}`)).toEqual([]);
  });

  it("[neg] exit 2 and no stdout for: no KEK, a typo'd flag, and a missing database file (which is not created)", () => {
    mixed();
    const before = readState();
    const noKek = cli(["--apply"], { PCC_CUSTODY_KEK: "" });
    expect(noKek.status).toBe(2);
    expect(noKek.stdout).toBe("");
    const typo = cli(["--aply"]);
    expect(typo.status).toBe(2);
    expect(typo.stdout).toBe("");
    const missing = join(dir, "missing.sqlite");
    const noDb = cli(["--apply"], { PCC_DB_PATH: missing });
    expect(noDb.status).toBe(2);
    expect(existsSync(missing)).toBe(false);
    expect(readState()).toEqual(before);
    expect(leaks(`${noKek.all}\n${typo.all}\n${noDb.all}`)).toEqual([]);
  });
});
