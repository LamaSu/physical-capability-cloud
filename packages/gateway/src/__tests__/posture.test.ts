import { describe, it, expect, vi } from "vitest";
import { classifyEnv, parsePosturePolicy, buildPostureReport, logBootPosture } from "../services/posture.js";
import { readBuildInfo } from "../build-info.js";

const reads = { names: new Set(["SYN_LIVE"]), prefixes: ["SYN_PREFIX_"] };
const record = (name: string, value?: string) => classifyEnv(name, value === undefined ? {} : { [name]: value }, reads);
const policy = (all: unknown[], id = "syn-1") => JSON.stringify([{ id, all }]);
const report = (env: NodeJS.ProcessEnv = {}, extra = {}) => buildPostureReport({ env, envReads: reads, db: null, ...extra });
const check = (all: unknown[], env: NodeJS.ProcessEnv = {}, extra = {}) => report({ ...env, PCC_POSTURE_POLICY: policy(all) }, extra);
function boot(env: NodeJS.ProcessEnv = {}, extra = {}) {
  const log = { info: vi.fn(), warn: vi.fn() };
  logBootPosture(log, { env, envReads: reads, db: null, ...extra });
  return { info: log.info.mock.calls, warn: log.warn.mock.calls };
}

describe("posture classification", () => {
  it("C1: applies the classification order and only the class fields", () => {
    expect(record("SYN_ABSENT")).toEqual({ name: "SYN_ABSENT", class: "unset", readByCode: false });
    expect(record("SYN_EMPTY", "")).toEqual({ name: "SYN_EMPTY", class: "empty", readByCode: false });
    expect(record("SYN_SECRET", "synthetic-secret")).toEqual({ name: "SYN_SECRET", class: "set", readByCode: false });
    expect(record("SYN_LIVE", "x").readByCode).toBe(true);
    expect(record("SYN_PREFIX_ONE", "x").readByCode).toBe(true);
    expect(classifyEnv("SYN_LIVE", {}, null).readByCode).toBeNull();
    expect(record("NODE_ENV", "").class).toBe("empty");
    expect(record("PORT", "").class).toBe("platform");
    expect(record("PORT", "https://synthetic.test/secret")).toEqual({ name: "PORT", class: "platform", readByCode: false });
  });
  it("C2: policy itself is only unset, empty, or set", () => {
    expect(record("PCC_POSTURE_POLICY").class).toBe("unset");
    expect(record("PCC_POSTURE_POLICY", "").class).toBe("empty");
    expect(record("PCC_POSTURE_POLICY", "https://synthetic.test/secret")).toEqual({ name: "PCC_POSTURE_POLICY", class: "set", readByCode: false });
  });
  const publicEnums = [
    ["NODE_ENV", ["production", "development", "test"]],
    ["CDP_NETWORK", ["base", "base-sepolia"]],
    ["WISE_ENVIRONMENT", ["sandbox", "production"]],
    ["PCC_WILDCARD_KEY_MIGRATION", ["apply"]],
    ["PCC_RELAY_GATE", ["open"]],
    ["PCC_SEED_DATA", ["true", "false"]],
    ["PCC_COMPOSE_USE_FACADE", ["true", "false"]],
    ["PCC_COMPOSE_EXECUTE_REAL", ["true", "false"]],
  ] as const;
  it.each(publicEnums)("C3: public enum %s is exact", (name, values) => {
    for (const value of values) expect(record(name, value)).toEqual({ name, class: "public", readByCode: false, value });
    for (const value of ["other-input", ` ${values[0]}`, values[0].toUpperCase()]) expect(record(name, value).value).toBe("other");
  });
  it("C4: public decimal accepts every integer in range and rejects noncanonical input", () => {
    for (let n = 0; n <= 10000; n++) expect(record("PCC_PROTOCOL_FEE_BPS", String(n)).value).toBe(String(n));
    for (const value of ["01", "+1", "-1", "1.0", "10001", " 1", "1e2", "1\n"]) expect(record("PCC_PROTOCOL_FEE_BPS", value).value).toBe("other");
  });
  it.each(["PCC_PUBLIC_URL", "PCC_GATEWAY_URL", "PCC_API_BASE_URL"])("C5: public origin %s", (name) => {
    expect(record(name, "https://SYNTHETIC.test:443/").value).toBe("https://synthetic.test");
    expect(record(name, "https://synthetic.test:8443").value).toBe("https://synthetic.test:8443");
    for (const value of ["https://synthetic.test/path", "https://synthetic.test/?q=x", "https://u:p@synthetic.test/", "http://synthetic.test/", "not-a-url", "https://synthetic.test/#x"]) expect(record(name, value).value).toBe("other");
  });
  it("C6 NODE_ENV: public precedes platform; platform names never become set", () => {
    expect(record("NODE_ENV", "test").class).toBe("public");
    for (const name of ["PATH", "HOME", "HOSTNAME", "PORT", "PWD", "OLDPWD", "SHLVL", "TERM", "LANG", "LANGUAGE", "TZ", "USER", "LOGNAME", "SHELL", "_", "NODE_OPTIONS", "RAILWAY_ANYTHING", "NPM_CONFIG_X", "npm_x", "LC_ALL", "YARN_X", "COREPACK_X"]) {
      expect(record(name, "synthetic")).toEqual({ name, class: "platform", readByCode: false });
      expect(check([{ name, class: "set" }], { [name]: "synthetic" }).verdict).toBe("clear");
    }
  });
  it.each([
    ["coinbase", "coinbase.com"], ["alchemy", "alchemy.com"], ["alchemy", "alchemyapi.io"],
    ["infura", "infura.io"], ["quicknode", "quiknode.pro"], ["quicknode", "quicknode.com"],
    ["railway", "railway.app"], ["railway", "railway.internal"],
  ])("U1: provider %s suffix %s", (provider, suffix) => {
    for (const host of [suffix, `sub.${suffix}`, `${suffix.toUpperCase()}.`]) expect(record("SYN_URL", `https://${host}/v1/base`).provider).toBe(provider);
  });
  it.each(["evilcoinbase.com", "coinbase.com.evil.test", "synthetic.test"])("U2: lookalike %s is other", (host) => {
    expect(record("SYN_URL", `https://${host}/`).provider).toBe("other");
  });
  it.each(["http", "https", "ws", "wss"])("U3: protocol %s is url", (protocol) => {
    expect(record("SYN_URL", `${protocol}://synthetic.test/`).class).toBe("url");
  });
  it.each(["file:///tmp/synthetic", "ftp://synthetic.test/", "not-a-url", "https://"])("U4: invalid url %s is set", (value) => {
    expect(record("SYN_URL", value).class).toBe("set");
  });
  it.each(["https://user@synthetic.test/", "https://:password@synthetic.test/", "https://synthetic.test/?token=synthetic", "https://synthetic.test/#synthetic", "https://synthetic.test/abcdefghijklmnop"])("U5 credential: %s", (value) => {
    expect(record("SYN_URL", value).credentialShaped).toBe(true);
  });
  it.each(["https://synthetic.test/abcdefghijklmno", "https://synthetic.test/v1/base"])("U6: no credential %s", (value) => {
    expect(record("SYN_URL", value).credentialShaped).toBe(false);
  });
  it("U7 no-echo: url classification never includes hostname or path", () => {
    const value = record("SYN_URL", "https://u:p@private-synthetic.test/abcdefghijklmnop?q=synthetic");
    expect(value).toEqual({ name: "SYN_URL", class: "url", readByCode: false, provider: "other", credentialShaped: true });
    for (const marker of ["private-synthetic.test", "abcdefghijklmnop", "q=synthetic"]) expect(JSON.stringify(value)).not.toContain(marker);
  });
});

describe("policy parsing", () => {
  it("P0: unset", () => expect(parsePosturePolicy(undefined).policy).toBe("unset"));
  const malformed: [string, unknown][] = [
    ["not array", {}], ["null", null], ["empty rules", []], ["too many rules", Array.from({ length: 65 }, (_, n) => ({ id: `syn-${n}`, all: [{ name: "SYN_A", present: true }] }))],
    ["null rule", [null]], ["array rule", [[]]], ["missing id", [{ all: [{ name: "SYN_A", present: true }] }]],
    ["unknown rule key", [{ id: "syn", all: [{ name: "SYN_A", present: true }], extra: 1 }]],
    ["invalid id", [{ id: "bad id", all: [{}] }]], ["nonstring id", [{ id: 1, all: [{}] }]], ["long id", [{ id: "x".repeat(33), all: [{}] }]],
    ["duplicate id", [{ id: "syn", all: [{ name: "SYN_A", present: true }] }, { id: "syn", all: [{ name: "SYN_A", present: true }] }]],
    ["missing all", [{ id: "syn" }]], ["all not array", [{ id: "syn", all: {} }]], ["empty all", [{ id: "syn", all: [] }]],
    ["too many conditions", [{ id: "syn", all: Array(17).fill({ name: "SYN_A", present: true }) }]],
    ...[
      ["null condition", null], ["array condition", []], ["empty condition", {}], ["name only", { name: "SYN_A" }],
      ["unknown-key", { name: "SYN_A", present: true, unknown: true }], ["missing name", { present: true }],
      ["mixed kinds", { name: "SYN_A", table: "SYN_T", countGt: 0 }], ["bad name", { name: "bad-name", present: true }],
      ["long name", { name: "x".repeat(129), present: true }], ["name wrong type", { name: 1, present: true }],
      ["empty names", { name: [], present: true }], ["too many names", { name: Array(33).fill("SYN_A"), present: true }],
      ["nonstring names", { name: [1], present: true }], ["wildcard in list", { name: ["*"], present: true }],
      ["invalid class", { name: "SYN_A", class: "secret" }], ["nonboolean present", { name: "SYN_A", present: 1 }],
      ["nonstring value", { name: "SYN_A", value: 1 }], ["nonstring valueNot", { name: "SYN_A", valueNot: 1 }],
      ["nonboolean credential", { name: "SYN_A", credentialShaped: 1 }], ["nonboolean read", { name: "SYN_A", readByCode: 1 }],
      ["bad table", { table: "bad-table", countGt: 0 }], ["long table", { table: "x".repeat(129), countGt: 0 }],
      ["nonstring table", { table: 1, countGt: 0 }], ["missing count", { table: "SYN_T" }],
      ["negative count", { table: "SYN_T", countGt: -1 }], ["large count", { table: "SYN_T", countGt: 2147483648 }],
      ["fractional count", { table: "SYN_T", countGt: 0.5 }], ["string count", { table: "SYN_T", countGt: "0" }],
      ["unknown table key", { table: "SYN_T", countGt: 0, extra: 1 }],
    ].map(([label, condition]) => [label, [{ id: "syn", all: [condition] }]]),
  ] as [string, unknown][];
  it.each(malformed)("P1 %s is unreadable", (_label, input) => expect(parsePosturePolicy(JSON.stringify(input)).policy).toBe("unreadable"));
  it.each(["", "{synthetic-policy-marker", " ".repeat(16385)])("P2: malformed or oversized text is unreadable", (raw) => expect(parsePosturePolicy(raw).policy).toBe("unreadable"));
  it("P3: exact length cap and valid full shape", () => {
    const raw = policy([{ name: ["SYN_A", "SYN_B"], class: "url", present: true, value: "other", valueNot: "x", credentialShaped: false, readByCode: true }, { table: "SYN_T", countGt: 2147483647 }]);
    expect(parsePosturePolicy(raw).policy).toBe("ok");
    expect(parsePosturePolicy(raw.padEnd(16384)).policy).toBe("ok");
    expect(parsePosturePolicy(raw.padEnd(16385)).policy).toBe("unreadable");
  });
});

describe("policy evaluation and report", () => {
  it("E1: class, absent names, present, value and valueNot", () => {
    for (const condition of [{ name: "SYN_MISSING", class: "unset" }, { name: "SYN_MISSING", present: false }, { name: "SYN_EMPTY", present: false }, { name: "SYN_SET", present: true }, { name: "NODE_ENV", value: "test" }, { name: "SYN_SET", valueNot: "test" }]) {
      expect(check([condition], { SYN_EMPTY: "", SYN_SET: "synthetic", NODE_ENV: "test" }).flags).toEqual(["syn-1"]);
    }
    for (const condition of [{ name: "SYN_MISSING", valueNot: "x" }, { name: "SYN_EMPTY", valueNot: "x" }, { name: "SYN_SET", value: "synthetic" }, { name: "NODE_ENV", valueNot: "test" }]) {
      expect(check([condition], { SYN_EMPTY: "", SYN_SET: "synthetic", NODE_ENV: "test" }).verdict).toBe("clear");
    }
  });
  it("E2: wildcard, lists, and all fields must match the same record", () => {
    expect(check([{ name: "*", class: "set", readByCode: true }], { SYN_LIVE: "synthetic" }).flags).toEqual(["syn-1"]);
    expect(check([{ name: ["SYN_ABSENT", "SYN_LIVE"], present: true }], { SYN_LIVE: "synthetic" }).verdict).toBe("flagged");
    expect(check([{ name: ["SYN_ABSENT", "SYN_LIVE"], class: "unset", present: true }], { SYN_LIVE: "synthetic" }).verdict).toBe("clear");
  });
  it("E3: credentialShaped only matches urls; readByCode true and false", () => {
    expect(check([{ name: "SYN_URL", credentialShaped: true }], { SYN_URL: "https://synthetic.test/?q=x" }).verdict).toBe("flagged");
    expect(check([{ name: "SYN_URL", credentialShaped: false }], { SYN_URL: "https://synthetic.test/" }).verdict).toBe("flagged");
    expect(check([{ name: "SYN_SET", credentialShaped: false }], { SYN_SET: "x" }).verdict).toBe("clear");
    expect(check([{ name: "SYN_LIVE", readByCode: true }]).verdict).toBe("flagged");
    expect(check([{ name: "SYN_ABSENT", readByCode: false }]).verdict).toBe("flagged");
  });
  it("E4 null: unavailable readByCode never matches false or true", () => {
    for (const value of [false, true]) expect(check([{ name: "SYN_LIVE", readByCode: value }], {}, { envReads: null }).verdict).toBe("clear");
  });
  it("E5: report union, code-unit sorting, exact build shape, and no-policy verdict", () => {
    const result = check([{ name: ["SYN_NAMED", "SYN_ABSENT"], present: false }], { SYN_z: "x", SYN_A: "x" });
    const names = result.env.map((r) => r.name);
    expect(names).toEqual([...names].sort());
    for (const name of ["SYN_NAMED", "SYN_ABSENT", "SYN_LIVE", "NODE_ENV", "SYN_z", "SYN_A"]) expect(names).toContain(name);
    expect(names).not.toContain("SYN_PREFIX_");
    const { commit, commitSource, buildArg, sourceDigest, sourceDigestSpec } = readBuildInfo();
    expect(result.build).toEqual({ commit, commitSource, buildArg, sourceDigest, sourceDigestSpec });
    expect(report()).toMatchObject({ spec: "pcc.posture/v1", envReads: "ok", policy: "unset", verdict: "no_policy", flags: [], errors: [], tables: [] });
    expect(report({}, { envReads: null }).envReads).toBe("unavailable");
  });
  it("E6: table true, false, missing, null and error precedes false conditions", () => {
    expect(check([{ table: "SYN_T", countGt: 2 }], {}, { db: fakeDb() }).verdict).toBe("flagged");
    expect(check([{ table: "SYN_T", countGt: 3 }], {}, { db: fakeDb() }).verdict).toBe("clear");
    for (const table of ["SYN_MISSING", "SYN_BROKEN"]) expect(check([{ name: "SYN_A", present: true }, { table, countGt: 0 }], {}, { db: fakeDb() })).toMatchObject({ verdict: "error", errors: ["syn-1"] });
  });
  it("E7: verdict priority and policy-order ids", () => {
    const rules = [{ id: "syn-error", all: [{ table: "SYN_MISSING", countGt: 0 }] }, { id: "syn-z", all: [{ name: "SYN_A", present: false }] }, { id: "syn-a", all: [{ name: "SYN_A", class: "unset" }] }];
    expect(report({ PCC_POSTURE_POLICY: JSON.stringify(rules) })).toMatchObject({ verdict: "flagged", flags: ["syn-z", "syn-a"], errors: ["syn-error"] });
    expect(report({ PCC_POSTURE_POLICY: "{" }).verdict).toBe("policy_unreadable");
    expect(check([{ name: "SYN_A", present: true }]).verdict).toBe("clear");
  });
  it("B1 boot-line: exact messages and string-only calls", () => {
    expect(boot()).toEqual({ info: [["[posture] no policy set"]], warn: [] });
    expect(boot({ PCC_POSTURE_POLICY: "synthetic-policy-marker" })).toEqual({ info: [], warn: [["[posture] policy unreadable"]] });
    expect(boot({ PCC_POSTURE_POLICY: policy([{ name: "SYN_A", present: true }]) })).toEqual({ info: [["[posture] clear"]], warn: [] });
    expect(boot({ PCC_POSTURE_POLICY: policy([{ name: "SYN_A", present: false }]) })).toEqual({ info: [], warn: [["[posture] flagged: syn-1"]] });
    expect(boot({ PCC_POSTURE_POLICY: policy([{ table: "SYN_MISSING", countGt: 0 }]) })).toEqual({ info: [], warn: [["[posture] errors: syn-1"]] });
    const mixed = JSON.stringify([{ id: "syn-z", all: [{ name: "SYN_A", present: false }] }, { id: "syn-a", all: [{ name: "SYN_A", present: false }] }, { id: "syn-e", all: [{ table: "SYN_MISSING", countGt: 0 }] }]);
    expect(boot({ PCC_POSTURE_POLICY: mixed })).toEqual({ info: [], warn: [["[posture] flagged: syn-z,syn-a; errors: syn-e"]] });
    for (const env of [{}, { PCC_POSTURE_POLICY: "{" }, { PCC_POSTURE_POLICY: policy([{ name: "SYN_A", present: true }]) }, { PCC_POSTURE_POLICY: policy([{ name: "SYN_A", present: false }]) }, { PCC_POSTURE_POLICY: policy([{ table: "SYN_T", countGt: 0 }]) }]) {
      const normal = boot(env);
      const unavailable = boot(env, { envReads: null });
      const level = normal.info.length ? "info" : "warn";
      expect(unavailable[level]).toEqual([[`${normal[level][0][0]} (env-read list unavailable)`]]);
    }
  });
  it("B2: unexpected input throw logs check failed without error text", () => {
    const env = new Proxy({}, { get() { throw new Error("synthetic-secret"); } });
    expect(boot(env)).toEqual({ info: [], warn: [["[posture] check failed"]] });
  });
  it("B3 boot-count: boot counts named tables once; admin counts every table and quotes names", () => {
    const prepared: string[] = [];
    const db = fakeDb(prepared);
    const env = { PCC_POSTURE_POLICY: policy([{ table: "SYN_T", countGt: 0 }, { table: "SYN_T", countGt: 1 }, { table: "SYN_MISSING", countGt: 0 }]) };
    boot(env, { db });
    expect(prepared.filter((s) => s.startsWith("SELECT COUNT"))).toEqual(['SELECT COUNT(*) AS n FROM "SYN_T"']);
    prepared.length = 0;
    const result = report(env, { db });
    expect(prepared[0]).toBe("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name");
    expect(prepared.slice(1)).toEqual(['SELECT COUNT(*) AS n FROM "SYN_T"', 'SELECT COUNT(*) AS n FROM "SYN_OTHER"', 'SELECT COUNT(*) AS n FROM "SYN_BROKEN"', 'SELECT COUNT(*) AS n FROM "SYN_""QUOTED"']);
    expect(result.tables).toEqual([{ name: "SYN_T", count: 3 }, { name: "SYN_OTHER", count: 3 }, { name: "SYN_BROKEN", count: null }, { name: 'SYN_"QUOTED', count: 3 }]);
  });
  it("B4 no-leak: report and boot never include secrets or policy text markers", () => {
    const env = { SYN_TOKEN: "synthetic-secret-never-echo", SYN_URL: "https://u:p@synthetic-private.test/abcdefghijklmnop?private=query", PCC_POSTURE_POLICY: policy([{ name: "SYN_TOKEN", valueNot: "synthetic-policy-marker-never-echo" }]) };
    const outputs = JSON.stringify([report(env), boot(env), boot({ PCC_POSTURE_POLICY: "{synthetic-policy-marker-never-echo" })]);
    for (const value of [env.SYN_TOKEN, "synthetic-policy-marker-never-echo", "synthetic-private.test", "abcdefghijklmnop", "private=query"]) expect(outputs).not.toContain(value);
  });
});

function fakeDb(prepared: string[] = []) {
  return { prepare(sql: string) {
    prepared.push(sql);
    return {
      all: () => ["SYN_T", "SYN_OTHER", "SYN_BROKEN", 'SYN_"QUOTED'].map((name) => ({ name })),
      get: () => { if (sql.includes('"SYN_BROKEN"')) throw new Error("synthetic-private-error"); return { n: 3 }; },
    };
  } };
}
