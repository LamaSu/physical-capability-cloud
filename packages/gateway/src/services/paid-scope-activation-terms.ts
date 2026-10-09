/**
 * Buyer funding, Stage 2 (readmodels): the two inputs reconcilePaidScope needs besides the record,
 * and where the accept route gets them (the steward's rulings 4 and 5, bulletin 7191; the wiring
 * reviewer-hotel proposed, fund-s2-r2-review.md section 6, adopted by the lane).
 *
 *   expectedChainId      The chain a buyer-funded V-next escrow lives on: the `chainId` of the ONE
 *                        pinned V-next deployment record that S0.1 commits,
 *                        packages/contracts/deployments/vnext/<network>/PROVISIONAL-<label>.json,
 *                        read from the @pcc/contracts package, so the image carries it. <network>
 *                        and <label> come from explicit config with no default
 *                        (PCC_VNEXT_RECORD_NETWORK, PCC_VNEXT_RECORD_LABEL). Never paid-job-flow's
 *                        resolveChainId, @pcc/contracts getDeployment or IDENTITY_REGISTRY_CHAIN_ID
 *                        (ruling 4). The verifier (S1.2) reads the same record.
 *   postActivationTtlMs  How long a scope stays live once activated: S1.1's prepared funding terms
 *                        for the scope's job, bounded so the work ends before the escrow's primary
 *                        verdict is due (reclaimAt − 9 days; ruling 5 (B)).
 *
 * Today both are null in every process: no deployment record is committed (deployments/vnext holds
 * only its README) and S1.1 does not exist. reconcilePaidScope refuses a null value
 * (expected_chain_unavailable, activation_ttl_unavailable) after funding_record_store_unavailable,
 * so production, which has no record store, answers exactly as before, and a test process with a
 * store but no installed terms fails closed too.
 *
 * A test process may install its own source (__setPaidScopeActivationTermsForTest); one installed is
 * never consulted outside a test process. Nothing here logs, and nothing it returns carries a request
 * value.
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
/** DeployVNextSettlement.s.sol's _requireValidLabel: [A-Za-z0-9_-]{1,64}. */
const LABEL_RE = /^[A-Za-z0-9_-]{1,64}$/;

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

/** The text of the regular file at `path`, never through a symlink, or null. */
function readRegularFile(path: string): string | null {
  try {
    if (lstatSync(path).isSymbolicLink()) return null;
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

/**
 * The chain id of the pinned record `<packageRoot>/deployments/vnext/<network>/PROVISIONAL-<label>.json`,
 * or null when anything is missing, unreadable or inconsistent (fail closed):
 *   - `network` or `label` is not a slug the deploy script writes, so no path is formed from it;
 *   - deployments, deployments/vnext or the network directory is a symlink or not a directory, or
 *     the record is a symlink or not a regular file (the directory README's rule);
 *   - the record is not a JSON object written by a broadcast PROVISIONAL run with this label:
 *     `broadcast` true (a dry run's tuple says false, and lives under a DRYRUN- name this never
 *     forms), `mode` "PROVISIONAL", `label` this label;
 *   - its `chainId` is not a positive safe integer, or not the chain whose directory it sits in.
 * Not covered (as in the README): a link swapped in for a directory between the check and the read.
 */
export function vnextRecordChainId(packageRoot: string, network: string, label: string): number | null {
  if (!NETWORK_RE.test(network) || !LABEL_RE.test(label)) return null;
  const deployments = join(packageRoot, "deployments");
  const vnext = join(deployments, "vnext");
  const networkDir = join(vnext, network);
  if (![deployments, vnext, networkDir].every(realDirectory)) return null;
  const text = readRegularFile(join(networkDir, `PROVISIONAL-${label}.json`));
  if (text === null) return null;
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) return null;
  const r = record as Record<string, unknown>;
  if (r.broadcast !== true || r.mode !== "PROVISIONAL" || r.label !== label) return null;
  const chainId = r.chainId;
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) return null;
  return vnextNetworkSlug(chainId) === network ? chainId : null;
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

/** The expected chain from the configured record (PCC_VNEXT_RECORD_NETWORK, PCC_VNEXT_RECORD_LABEL; no default), or null. */
export function configuredVNextChainId(): number | null {
  const network = process.env.PCC_VNEXT_RECORD_NETWORK;
  const label = process.env.PCC_VNEXT_RECORD_LABEL;
  if (typeof network !== "string" || typeof label !== "string") return null;
  const root = contractsPackageRoot();
  return root === null ? null : vnextRecordChainId(root, network, label);
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
  return { expectedChainId: configuredVNextChainId(), postActivationTtlMs: preparedActivationTtlMs(scope) };
}

/**
 * Installs (or, with null, removes) the source a TEST process reads. Throws in any other process, so
 * production reads only the configured sources.
 */
export function __setPaidScopeActivationTermsForTest(source: PaidScopeActivationTermsSource | null): void {
  if (!isTestProcess()) throw new Error("paid-scope activation terms: test processes only");
  testSource = source;
}
