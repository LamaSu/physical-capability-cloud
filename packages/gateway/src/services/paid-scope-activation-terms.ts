/**
 * Buyer funding, Stage 2 (readmodels): the two inputs reconcilePaidScope needs besides the record,
 * and where the accept route gets them (the steward's rulings 4 and 5, bulletin 7191; the wiring
 * reviewer-hotel proposed, fund-s2-r2-review.md section 6, adopted by the lane).
 *
 *   expectedChainId      The chain a buyer-funded V-next escrow lives on: the `chainId` of the ONE
 *                        operator-approved canonical V-next deployment record the economics lane commits,
 *                        packages/contracts/deployments/vnext/<network>/CANONICAL.json,
 *                        read from the @pcc/contracts package, so the image carries it. <network>
 *                        comes from explicit config with no default (PCC_VNEXT_RECORD_NETWORK).
 *                        Any PCC_VNEXT_RECORD_LABEL config is refused, including an empty value.
 *                        Never paid-job-flow's
 *                        resolveChainId, @pcc/contracts getDeployment or IDENTITY_REGISTRY_CHAIN_ID
 *                        (ruling 4). The verifier (S1.2) reads the same record.
 *   postActivationTtlMs  How long a scope stays live once activated: S1.1's prepared funding terms
 *                        for the scope's job, bounded so the work ends before the escrow's primary
 *                        verdict is due (reclaimAt − 9 days; ruling 5 (B)).
 *
 * The chain comes only from an explicitly configured, approved deployment record; S1.1 does not
 * exist yet, so the prepared TTL remains null. reconcilePaidScope refuses a null value
 * (expected_chain_unavailable, activation_ttl_unavailable) after funding_record_store_unavailable,
 * so production, which has no record store, answers exactly as before, and a test process with a
 * store but no installed terms fails closed too.
 *
 * A test process may install its own source (__setPaidScopeActivationTermsForTest); one installed is
 * never consulted outside a test process. The one logging exception is a fixed-code warning for a
 * refused V-next record (R-a through R-d); nothing it returns carries a request value.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isTestProcess } from "./settlement-mode.js";

/** reconcilePaidScope's two required inputs besides the record; null where no source supplies one. */
export interface PaidScopeActivationTerms {
  /** The EIP-155 id of the chain a buyer-funded V-next escrow must be on, or null. */
  expectedChainId: number | null;
  /** How long the scope stays live once activated, in milliseconds, or null. */
  postActivationTtlMs: number | null;
  /** Whether the resolved deployment permits only the explicitly allowed testnet buyers. */
  testnetOnly: boolean;
}

/** The scope fields a source may read. */
export interface ActivationScope {
  id: string;
  jobId: string | null;
  kernelId: string;
}

export type PaidScopeActivationTermsSource = (scope: ActivationScope) => PaidScopeActivationTerms;

/** VNextDeploySpec.networkSlug's outputs: base, base-sepolia, anvil, chain-<id>. */
const NETWORK_RE = /^(base|base-sepolia|anvil|chain-[1-9][0-9]{0,19})$/;

/** VNextDeploySpec.networkSlug: the directory under deployments/vnext a chain's records live in. */
export function vnextNetworkSlug(chainId: number): string {
  if (chainId === 8453) return "base";
  if (chainId === 84532) return "base-sepolia";
  if (chainId === 31337) return "anvil";
  return `chain-${chainId}`;
}

/** Whether `path` is a real directory: not a symlink (lstat), and a directory. */
function realDirectory(path: string): boolean {
  try {
    const st = lstatSync(path);
    return !st.isSymbolicLink() && st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * The text of the regular file at `path`, never through a symlink, or null. Anything but a regular
 * file is refused before it is opened: opening a FIFO to read blocks until a writer comes, and the
 * read is synchronous, so it would stall the gateway (r3 review NIT-1).
 */
function readRegularFile(path: string): string | null {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    // O_NOFOLLOW where the platform has it: a link swapped in after the lstat is refused by open.
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!fstatSync(fd).isFile()) return null;
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** The fields this gateway reads from a schema-checked canonical deployment. */
interface VNextRecordTerms {
  chainId: number;
  testnetOnly: boolean;
}

type RecordRule = "R-a" | "R-b" | "R-c" | "R-d";

/** No request logger exists here: follow the services' console.warn convention, with fixed data only. */
function recordRefused(rule: RecordRule): null {
  console.warn(`vnext_record_refused ${rule}`);
  return null;
}

const RECORD_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * CANONICAL.schema.json's required, const, enum, pattern and numeric bounds for the fields read
 * here. The structural agreement test pins these hand-written checks to the committed schema.
 * The schedule's oneOf also pairs its id with scheduleTestnetOnly; its windows are not read here.
 */
function hasCanonicalReadFields(r: Record<string, unknown>): boolean {
  return r.canonical === true && r.doNotPin === false && r.mode === "CANONICAL"
    && r.label === "" && r.broadcast === true
    && [r.factory, r.implementation, r.usdc].every((v) => typeof v === "string" && RECORD_ADDRESS_RE.test(v))
    && typeof r.chainId === "number" && Number.isSafeInteger(r.chainId) && r.chainId >= 1
    && typeof r.blockNumber === "number" && Number.isSafeInteger(r.blockNumber) && r.blockNumber >= 0
    && r.scheduleId === (r.scheduleTestnetOnly ? "vnext-testnet-short-v1" : "vnext-mainnet-v1");
}

/**
 * Read the canonical record from real directories and a regular file (never a link or FIFO),
 * retaining the existing path and explicit canonical-approval checks. R-a through R-d fail closed
 * before the chain can be used. Unavailable paths have no record to diagnose and remain silent.
 */
function vnextRecordTerms(packageRoot: string, network: string): VNextRecordTerms | null {
  if (!NETWORK_RE.test(network)) return null;
  const deployments = join(packageRoot, "deployments");
  const vnext = join(deployments, "vnext");
  const networkDir = join(vnext, network);
  if (![deployments, vnext, networkDir].every(realDirectory)) return null;
  const text = readRegularFile(join(networkDir, "CANONICAL.json"));
  if (text === null) return null;
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return recordRefused("R-d");
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) return recordRefused("R-d");
  const r = record as Record<string, unknown>;
  if (r.specVersion !== 2) return recordRefused("R-a");
  if (typeof r.scheduleTestnetOnly !== "boolean"
    || (r.scheduleTestnetOnly && r.chainId !== 84532 && r.chainId !== 31337)) return recordRefused("R-b");
  if (r.scheduleTestnetOnly && process.env.PCC_VNEXT_ALLOW_TESTNET_RECORD !== "1") return recordRefused("R-c");
  if (!hasCanonicalReadFields(r)) return recordRefused("R-d");
  const chainId = r.chainId as number;
  if (vnextNetworkSlug(chainId) !== network) return recordRefused("R-d");
  return { chainId, testnetOnly: r.scheduleTestnetOnly };
}

/** The chain of the one approved canonical record, or null on an unavailable or refused record. */
export function vnextRecordChainId(packageRoot: string, network: string): number | null {
  return vnextRecordTerms(packageRoot, network)?.chainId ?? null;
}

/** The @pcc/contracts package root (where deployments/ lives), found as Node resolves the package, or null. */
export function contractsPackageRoot(): string | null {
  try {
    // ".../packages/contracts/dist/index.js": the package's entry, two levels below its root.
    return dirname(dirname(createRequire(import.meta.url).resolve("@pcc/contracts")));
  } catch {
    return null;
  }
}

/**
 * The expected chain from CANONICAL.json in the explicitly configured PCC_VNEXT_RECORD_NETWORK
 * directory (no default), or null. Legacy PCC_VNEXT_RECORD_LABEL config is refused even when empty.
 * The record is looked for under `packageRoot`, by default the @pcc/contracts package; a test gives
 * its own, so the no-default rule is checked against a record that exists.
 */
export function configuredVNextChainId(packageRoot?: string | null): number | null {
  return configuredVNextRecord(packageRoot)?.chainId ?? null;
}

function configuredVNextRecord(packageRoot?: string | null): VNextRecordTerms | null {
  const network = process.env.PCC_VNEXT_RECORD_NETWORK;
  if (typeof network !== "string" || process.env.PCC_VNEXT_RECORD_LABEL !== undefined) return null;
  const root = packageRoot === undefined ? contractsPackageRoot() : packageRoot;
  return root === null ? null : vnextRecordTerms(root, network);
}

/**
 * The post-activation TTL S1.1's prepared funding terms give the scope's job, or null. S1.1 (the
 * prepare step) does not exist yet, so there are no prepared terms to read: null.
 */
export function preparedActivationTtlMs(_scope: ActivationScope): number | null {
  return null;
}

let testSource: PaidScopeActivationTermsSource | null = null;

/** reconcilePaidScope's inputs for `scope`: a test process's installed source, else the configured ones. */
export function paidScopeActivationTerms(scope: ActivationScope): PaidScopeActivationTerms {
  if (isTestProcess() && testSource) return testSource(scope);
  const record = configuredVNextRecord();
  return {
    expectedChainId: record?.chainId ?? null,
    postActivationTtlMs: preparedActivationTtlMs(scope),
    testnetOnly: record?.testnetOnly ?? false,
  };
}

/**
 * Installs (or, with null, removes) the source a TEST process reads. Throws in any other process, so
 * production reads only the configured sources.
 */
export function __setPaidScopeActivationTermsForTest(source: PaidScopeActivationTermsSource | null): void {
  if (!isTestProcess()) throw new Error("paid-scope activation terms: test processes only");
  testSource = source;
}
