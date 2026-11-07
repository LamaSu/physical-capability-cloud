import { readBuildInfo } from "../build-info.js";
import { getStore } from "../db.js";
import { readEnvReads } from "./env-reads.js";

const PUBLIC_VALUES: Record<string, readonly string[]> = {
  NODE_ENV: ["production", "development", "test"],
  CDP_NETWORK: ["base", "base-sepolia"],
  WISE_ENVIRONMENT: ["sandbox", "production"],
  PCC_WILDCARD_KEY_MIGRATION: ["apply"],
  PCC_RELAY_GATE: ["open"],
  PCC_SEED_DATA: ["true", "false"],
  PCC_COMPOSE_USE_FACADE: ["true", "false"],
  PCC_COMPOSE_EXECUTE_REAL: ["true", "false"],
};
const PUBLIC_ORIGINS = ["PCC_PUBLIC_URL", "PCC_GATEWAY_URL", "PCC_API_BASE_URL"];
const PUBLIC_NAMES = [...Object.keys(PUBLIC_VALUES), "PCC_PROTOCOL_FEE_BPS", ...PUBLIC_ORIGINS];
const PLATFORM_NAMES = new Set(["PATH", "HOME", "HOSTNAME", "PORT", "PWD", "OLDPWD", "SHLVL", "TERM", "LANG", "LANGUAGE", "TZ", "USER", "LOGNAME", "SHELL", "_"]);
const PLATFORM_PREFIXES = ["RAILWAY_", "NODE_", "NPM_CONFIG_", "npm_", "LC_", "YARN_", "COREPACK_"];
const PROVIDERS = {
  coinbase: ["coinbase.com"], alchemy: ["alchemy.com", "alchemyapi.io"],
  infura: ["infura.io"], quicknode: ["quiknode.pro", "quicknode.com"],
  railway: ["railway.app", "railway.internal"],
};
const CLASSES = ["unset", "empty", "public", "platform", "url", "set"] as const;
type EnvRecord = {
  name: string;
  class: typeof CLASSES[number];
  readByCode: boolean | null;
  value?: string;
  provider?: string;
  credentialShaped?: boolean;
};

function publicValue(name: string, value: string): string {
  if (Object.hasOwn(PUBLIC_VALUES, name)) return PUBLIC_VALUES[name].includes(value) ? value : "other";
  if (name === "PCC_PROTOCOL_FEE_BPS") return /^(0|[1-9][0-9]*)$/.test(value) && String(Number(value)) === value && Number(value) <= 10000 ? value : "other";
  try {
    const url = new URL(value);
    if (value === value.trim() && url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/") return url.origin;
  } catch { /* Never expose URL parser errors. */ }
  return "other";
}

/** Classifications are the only projection of raw environment values. */
export function classifyEnv(name: string, env: NodeJS.ProcessEnv, reads: ReturnType<typeof readEnvReads>): EnvRecord {
  const values = new Map(Object.entries(env));
  const readByCode = reads === null ? null : reads.names.has(name) || reads.prefixes.some((prefix) => name.startsWith(prefix));
  const base = { name, readByCode };
  const value = values.get(name);
  if (!values.has(name) || value === undefined) return { ...base, class: "unset" };
  if (name === "PCC_POSTURE_POLICY") return { ...base, class: value === "" ? "empty" : "set" };
  if (PUBLIC_NAMES.includes(name)) return value === "" ? { ...base, class: "empty" } : { ...base, class: "public", value: publicValue(name, value) };
  if (PLATFORM_NAMES.has(name) || PLATFORM_PREFIXES.some((prefix) => name.startsWith(prefix))) return { ...base, class: "platform" };
  if (value === "") return { ...base, class: "empty" };
  try {
    const url = new URL(value);
    if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && url.hostname) {
      const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
      const provider = Object.entries(PROVIDERS).find(([, suffixes]) => suffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)))?.[0] ?? "other";
      const credentialShaped = !!(url.username || url.password || url.search || url.hash) || url.pathname.split("/").some((segment) => /^[A-Za-z0-9_-]{16,}$/.test(segment));
      return { ...base, class: "url", provider, credentialShaped };
    }
  } catch { /* Error messages can contain the input; discard them. */ }
  return { ...base, class: "set" };
}

type EnvCondition = {
  name: string | string[];
  class?: EnvRecord["class"];
  present?: boolean;
  value?: string;
  valueNot?: string;
  credentialShaped?: boolean;
  readByCode?: boolean;
};
type TableCondition = { table: string; countGt: number };
type Rule = { id: string; all: (EnvCondition | TableCondition)[] };
type Policy = { policy: "unset" | "unreadable"; rules: [] } | { policy: "ok"; rules: Rule[] };
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const envName = (v: unknown): v is string => typeof v === "string" && ENV_NAME.test(v) && !/[\r\n]/.test(v);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));

function validCondition(v: unknown): boolean {
  if (!object(v)) return false;
  if (Object.hasOwn(v, "table")) return exactKeys(v, ["table", "countGt"]) && envName(v.table) && Number.isInteger(v.countGt) && (v.countGt as number) >= 0 && (v.countGt as number) <= 2147483647;
  const keys = Object.keys(v);
  if (!Object.hasOwn(v, "name") || keys.length < 2 || keys.some((key) => !["name", "class", "present", "value", "valueNot", "credentialShaped", "readByCode"].includes(key))) return false;
  if (!(v.name === "*" || envName(v.name) || Array.isArray(v.name) && v.name.length >= 1 && v.name.length <= 32 && v.name.every(envName))) return false;
  if (Object.hasOwn(v, "class") && !CLASSES.includes(v.class as EnvRecord["class"])) return false;
  for (const key of ["present", "credentialShaped", "readByCode"]) if (Object.hasOwn(v, key) && typeof v[key] !== "boolean") return false;
  for (const key of ["value", "valueNot"]) if (Object.hasOwn(v, key) && typeof v[key] !== "string") return false;
  return true;
}

export function parsePosturePolicy(raw: string | undefined): Policy {
  if (raw === undefined) return { policy: "unset", rules: [] };
  const unreadable: Policy = { policy: "unreadable", rules: [] };
  if (raw.length > 16384) return unreadable;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length < 1 || value.length > 64) return unreadable;
    const ids = new Set<string>();
    for (const rule of value) {
      if (!object(rule) || !exactKeys(rule, ["id", "all"]) || typeof rule.id !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(rule.id) || /[\r\n]/.test(rule.id) || ids.has(rule.id) || !Array.isArray(rule.all) || rule.all.length < 1 || rule.all.length > 16 || !rule.all.every(validCondition)) return unreadable;
      ids.add(rule.id);
    }
    return { policy: "ok", rules: value as Rule[] };
  } catch {
    return unreadable;
  }
}

type Sqlite = { prepare(sql: string): { all(): unknown[]; get(): unknown } };
type Options = { env?: NodeJS.ProcessEnv; envReads?: ReturnType<typeof readEnvReads>; db?: Sqlite | null };
function rawDatabase(): Sqlite | null {
  try { return (getStore().db as unknown as { $client?: Sqlite }).$client ?? null; } catch { return null; }
}

function tableCounts(db: Sqlite | null, only?: Set<string>): { name: string; count: number | null }[] {
  if (!db || only?.size === 0) return [];
  let tables: { name: string }[];
  try {
    tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all() as { name: string }[];
  } catch { return []; }
  return tables.filter(({ name }) => !only || only.has(name)).map(({ name }) => {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n: number };
      return { name, count: row.n };
    } catch { return { name, count: null }; }
  });
}

function matches(record: EnvRecord, condition: EnvCondition): boolean {
  const present = record.class !== "unset" && record.class !== "empty";
  return (condition.class === undefined || record.class === condition.class)
    && (condition.present === undefined || present === condition.present)
    && (condition.value === undefined || record.class === "public" && record.value === condition.value)
    && (condition.valueNot === undefined || present && record.value !== condition.valueNot)
    && (condition.credentialShaped === undefined || record.class === "url" && record.credentialShaped === condition.credentialShaped)
    && (condition.readByCode === undefined || record.readByCode === condition.readByCode);
}

function makeReport(opts: Options, boot: boolean) {
  const env = opts.env ?? process.env;
  const reads = opts.envReads === undefined ? readEnvReads() : opts.envReads;
  const parsed = parsePosturePolicy(env.PCC_POSTURE_POLICY);
  const names = new Set([...Object.keys(env), ...(reads?.names ?? []), ...PUBLIC_NAMES]);
  const namedTables = new Set<string>();
  for (const rule of parsed.rules) for (const condition of rule.all) {
    if ("table" in condition) namedTables.add(condition.table);
    else if (condition.name !== "*") for (const name of typeof condition.name === "string" ? [condition.name] : condition.name) names.add(name);
  }
  const records = [...names].sort().map((name) => classifyEnv(name, env, reads));
  const byName = new Map(records.map((record) => [record.name, record]));
  const db = opts.db === undefined ? rawDatabase() : opts.db;
  const tables = tableCounts(db, boot ? namedTables : undefined);
  const counts = new Map(tables.map((table) => [table.name, table.count]));
  const flags: string[] = [];
  const errors: string[] = [];
  for (const rule of parsed.rules) {
    let failed = false;
    let errored = false;
    for (const condition of rule.all) {
      if ("table" in condition) {
        const count = counts.get(condition.table);
        if (count === undefined || count === null) errored = true;
        else if (count <= condition.countGt) failed = true;
      } else {
        const candidates = condition.name === "*" ? records : (typeof condition.name === "string" ? [condition.name] : condition.name).map((name) => byName.get(name)!);
        if (!candidates.some((record) => matches(record, condition))) failed = true;
      }
    }
    if (errored) errors.push(rule.id);
    else if (!failed) flags.push(rule.id);
  }
  const verdict = parsed.policy === "unset" ? "no_policy" : parsed.policy === "unreadable" ? "policy_unreadable" : flags.length ? "flagged" : errors.length ? "error" : "clear";
  const { commit, commitSource, buildArg, sourceDigest, sourceDigestSpec } = readBuildInfo();
  return { spec: "pcc.posture/v1" as const, build: { commit, commitSource, buildArg, sourceDigest, sourceDigestSpec }, envReads: reads ? "ok" as const : "unavailable" as const, env: records, tables, policy: parsed.policy, verdict, flags, errors };
}

export function buildPostureReport(opts: Options = {}) {
  return makeReport(opts, false);
}

/** Exactly one string-only log call; posture can never refuse boot. */
export function logBootPosture(log: { info(message: string): unknown; warn(message: string): unknown }, opts: Options = {}): void {
  try {
    const result = makeReport(opts, true);
    let message: string;
    let warn = false;
    if (result.policy === "unset") message = "[posture] no policy set";
    else if (result.policy === "unreadable") { message = "[posture] policy unreadable"; warn = true; }
    else if (result.verdict === "clear") message = "[posture] clear";
    else {
      const parts = [];
      if (result.flags.length) parts.push(`flagged: ${result.flags.join(",")}`);
      if (result.errors.length) parts.push(`errors: ${result.errors.join(",")}`);
      message = `[posture] ${parts.join("; ")}`;
      warn = true;
    }
    if (result.envReads === "unavailable") message += " (env-read list unavailable)";
    if (warn) log.warn(message); else log.info(message);
  } catch {
    try { log.warn("[posture] check failed"); } catch { /* Even a logger failure cannot refuse boot. */ }
  }
}
