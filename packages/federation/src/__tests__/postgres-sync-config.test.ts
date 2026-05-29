import { describe, expect, it } from "vitest";
import {
  DEFAULT_SYNC_TABLES,
  generatePostgresSyncConfig,
  parseStandbyNames,
} from "../mesh/postgres-sync-config.js";

describe("generatePostgresSyncConfig", () => {
  it("emits remote_apply and FIRST quorum line", () => {
    const cfg = generatePostgresSyncConfig({
      standbyNames: ["mesh_a_follower_1", "mesh_a_follower_2"],
    });
    expect(cfg).toContain("synchronous_commit = remote_apply");
    expect(cfg).toContain(
      `synchronous_standby_names = 'FIRST 1 ("mesh_a_follower_1", "mesh_a_follower_2")'`,
    );
  });

  it("respects syncRequiredCount", () => {
    const cfg = generatePostgresSyncConfig({
      standbyNames: ["s1", "s2", "s3"],
      syncRequiredCount: 2,
    });
    expect(cfg).toContain("FIRST 2");
  });

  it("rejects empty standby list", () => {
    expect(() =>
      generatePostgresSyncConfig({ standbyNames: [] }),
    ).toThrow(/at least one/);
  });

  it("rejects out-of-range syncRequiredCount", () => {
    expect(() =>
      generatePostgresSyncConfig({
        standbyNames: ["s1"],
        syncRequiredCount: 5,
      }),
    ).toThrow(/between 1 and standbyNames/);
    expect(() =>
      generatePostgresSyncConfig({
        standbyNames: ["s1", "s2"],
        syncRequiredCount: 0,
      }),
    ).toThrow(/between 1 and standbyNames/);
  });

  it("enables wal_level=logical for Phase 2 CDC", () => {
    const cfg = generatePostgresSyncConfig({ standbyNames: ["s1"] });
    expect(cfg).toContain("wal_level = logical");
    expect(cfg).toContain("max_replication_slots = 16");
    expect(cfg).toContain("max_wal_senders = 16");
  });

  it("lists the default federation tables as comments", () => {
    const cfg = generatePostgresSyncConfig({ standbyNames: ["s1"] });
    for (const t of DEFAULT_SYNC_TABLES) {
      expect(cfg).toContain(`#   - ${t}`);
    }
  });

  it("respects a custom tables list", () => {
    const cfg = generatePostgresSyncConfig({
      standbyNames: ["s1"],
      tables: ["custom_a", "custom_b"],
    });
    expect(cfg).toContain("#   - custom_a");
    expect(cfg).toContain("#   - custom_b");
    expect(cfg).not.toContain("indexed_tools");
  });

  it("uses configured statement_timeout in ms", () => {
    const cfg = generatePostgresSyncConfig({
      standbyNames: ["s1"],
      syncCommitTimeoutMs: 9999,
    });
    expect(cfg).toContain("statement_timeout = 9999");
  });

  it("idempotent: regenerating with same opts gives same output", () => {
    const a = generatePostgresSyncConfig({ standbyNames: ["s1", "s2"] });
    const b = generatePostgresSyncConfig({ standbyNames: ["s1", "s2"] });
    expect(a).toBe(b);
  });
});

describe("parseStandbyNames", () => {
  it("parses FIRST N (...) form", () => {
    expect(parseStandbyNames(`FIRST 1 ("a", "b")`)).toEqual(["a", "b"]);
  });

  it("parses ANY N (...) form", () => {
    expect(parseStandbyNames(`ANY 2 (s1, s2, s3)`)).toEqual(["s1", "s2", "s3"]);
  });

  it("parses plain CSV", () => {
    expect(parseStandbyNames(`s1, s2, s3`)).toEqual(["s1", "s2", "s3"]);
  });

  it("strips quotes and whitespace", () => {
    expect(parseStandbyNames(`'  a  ', "  b  "`)).toEqual(["a", "b"]);
  });

  it("ignores empty entries", () => {
    expect(parseStandbyNames(`a,,b,`)).toEqual(["a", "b"]);
  });
});
