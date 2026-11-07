/**
 * The funding preflight: the LIVE half of the funding rules (docs/VNEXT_SETTLEMENT_ABI.md §5.2).
 *
 * `compileVNextPolicy` is pure. It refuses every rule a config breaks by its content alone (§5.1), but
 * whether a job actually FUNDS also depends on chain state no pure function can see:
 *   - the deployment the compile assumed (chain id, implementation, predicted clone, settlement token);
 *   - the clone itself: created, initialized, not yet sealed, and holding the compiled identity;
 *   - both oracle cohorts enabled (a disabled cohort makes `fund()` revert);
 *   - the policy nonce still at or above the factory's floor, and the job not already funded;
 *   - the acceptance unexpired and every reclaim window valid at the LIVE block time;
 *   - a payer signature when someone other than the payer sends;
 *   - the payer's balance and allowance covering the exact pull;
 *   - and signature VALIDITY, which only the contract decides (EOA vs ERC-1271, with the clone as the caller).
 * This reads each of those, then SIMULATES the exact signed `fund()` call from the actual sender. The
 * simulation is the authority: the named checks exist so a failure says WHY.
 *
 * ONE BLOCK, BY IDENTITY. Every read, the code lookup, the time checks and the simulation run against a single
 * block, pinned first (the latest block, or the caller's `blockNumber`) and then addressed by its HASH (EIP-1898,
 * `requireCanonical: true`), so a reorganized block number can never answer for the block that was read (astra
 * round 2 on #367, F1). A node that cannot serve hash-pinned calls fails the preflight closed. The chain id is read
 * before and after, and must match the compiled one both times. This removes inconsistency DURING the preflight
 * only: the transaction lands in a later block, the contract re-checks everything at execution, and nothing here
 * replaces an on-chain check.
 *
 * FROZEN INPUTS. The compiled policy and the acceptance are deep-copied before the first await, and only that copy
 * is checked and simulated (astra round 2, F2). The result returns the exact `fund()` arguments it judged, so a
 * caller submits what was checked, not whatever its own objects hold by then.
 *
 * THE COMPILED POLICY, NOT ANOTHER ONE. The acceptance's own `expiry` must equal the compiled expiry (a static
 * check). Otherwise the simulation could pass for a differently dated policy (signed over a different digest)
 * while the named expiry check judged the compiled one.
 *
 * DIAGNOSTICS. The payer's balance and allowance are read and reported, but they never decide `ok`: only the
 * simulation shows whether the token actually delivers the pull (astra round 2, F3).
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { VNextSettlementEscrowABI, VNextSettlementEscrowFactoryABI } from "./abi.js";
import { VNEXT, checkAcceptance, type CompiledVNextPolicy, type PolicyAcceptance } from "./compiler.js";

const ATTESTER_ABI = parseAbi(["function enabled() view returns (bool)"]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VNextFundingPreflight {
  /** Every check passed AND the exact signed `fund()` simulated without reverting, all at the block `blockHash`. */
  ok: boolean;
  checks: PreflightCheck[];
  /** Reported, never deciding `ok`: the payer's balance and allowance. The simulation is the authority on the pull. */
  diagnostics: PreflightCheck[];
  simulation: { ok: boolean; error?: string };
  /** The exact `fund(configs, acceptance)` arguments every check and the simulation judged (a deep copy taken at the call). */
  fundArgs: readonly [CompiledVNextPolicy["configs"], PolicyAcceptance];
  /** The one block every read, the code lookup and the simulation ran against. `null` only if it could not be read. */
  blockNumber: bigint | null;
  blockHash: Hex | null;
  /** That block's timestamp: the time every window and the expiry were checked against (0 if the block was unread). */
  blockTimestamp: bigint;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Revert data carried anywhere in an error's cause chain (a raw JSON-RPC eth_call revert puts it in `data`). */
function revertDataOf(e: unknown): Hex | undefined {
  for (let x: unknown = e, i = 0; x && i < 8; x = (x as { cause?: unknown }).cause, i++) {
    const data = (x as { data?: unknown }).data;
    if (typeof data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(data)) return data as Hex;
    if (data && typeof (data as { data?: unknown }).data === "string") return (data as { data: Hex }).data;
  }
  return undefined;
}

/**
 * The revert's error name when the contract gave one, else the first line of the message.
 *
 * `extraAbi` is OPTIONAL and additive only: every existing caller that omits it decodes against exactly
 * `VNextSettlementEscrowABI`, unchanged. A caller that reads through a local, hand-declared fragment not in
 * that frozen ABI (read.ts's `UNIT_READ_ABI`, e.g. for `UnitNotFound`) passes its own fragment here so a
 * revert from THAT selector still decodes by name, without adding anything to the frozen ABI itself.
 */
export function describeRevert(e: unknown, extraAbi?: Abi): string {
  const data = revertDataOf(e);
  if (data) {
    try {
      const abi = extraAbi ? [...VNextSettlementEscrowABI, ...extraAbi] : VNextSettlementEscrowABI;
      return decodeErrorResult({ abi, data }).errorName;
    } catch {
      // not an error either ABI declares; fall through to the message
    }
  }
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name) return name;
      if (reverted.reason) return reverted.reason;
    }
    return e.shortMessage;
  }
  return e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
}

export async function preflightVNextFunding(
  client: PublicClient,
  p: {
    compiled: CompiledVNextPolicy;
    acceptance: PolicyAcceptance;
    sender: Address;
    /** Pin a specific block. Default: the latest block, read once at the start. */
    blockNumber?: bigint;
  },
): Promise<VNextFundingPreflight> {
  // Frozen before the first await: nothing the caller does to its own objects from here on is judged (F2).
  const c: CompiledVNextPolicy = structuredClone(p.compiled);
  const acceptance: PolicyAcceptance = structuredClone(p.acceptance);
  const sender = p.sender;
  const requestedBlockNumber = p.blockNumber; // read at the call, like every other input (sol, 26d follow-up)
  const fundArgs = [c.configs, acceptance] as const;
  const checks: PreflightCheck[] = [];
  const diagnostics: PreflightCheck[] = [];
  const record = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    return ok;
  };
  const failedResult = (error: string, blockNumber: bigint | null, blockHash: Hex | null, blockTimestamp: bigint) => ({
    ok: false,
    checks,
    diagnostics,
    simulation: { ok: false, error },
    fundArgs,
    blockNumber,
    blockHash,
    blockTimestamp,
  });

  // STATIC, before any read: the acceptance is for THIS compiled policy (§5.1).
  record(
    "acceptance expiry matches the compiled policy",
    acceptance.expiry === c.expiry,
    `acceptance.expiry ${acceptance.expiry}; compiled expiry ${c.expiry} (the digest the signatures must cover uses the compiled one)`,
  );

  // The chain id, before anything is pinned (it is read again at the end).
  let chainIdBefore: bigint | undefined;
  try {
    chainIdBefore = BigInt(await client.getChainId());
  } catch {
    chainIdBefore = undefined;
  }

  // 0. the one block everything below runs against, addressed by its hash
  let blockNumber: bigint;
  let blockHash: Hex;
  let blockTimestamp: bigint;
  try {
    const b =
      requestedBlockNumber === undefined ? await client.getBlock() : await client.getBlock({ blockNumber: requestedBlockNumber });
    if (b.number === null || b.hash === null) throw new Error("the node returned a pending block, which has no number or hash to pin");
    blockNumber = b.number;
    blockHash = b.hash;
    blockTimestamp = b.timestamp;
  } catch (e) {
    record("pinned block", false, `could not read the block to pin: ${describeRevert(e)}`);
    return failedResult("not simulated: no block to pin", null, null, 0n);
  }
  const pin = { blockHash, requireCanonical: true } as const;
  const rpc = (method: "eth_call" | "eth_getCode", params: unknown[]) =>
    client.request({ method, params: [...params, pin] } as never) as Promise<Hex>;
  // A node that cannot serve calls pinned by block hash (EIP-1898) fails the preflight closed.
  try {
    await rpc("eth_getCode", [c.factory]);
  } catch (e) {
    record(
      "pinned block",
      false,
      `block ${blockNumber} (${blockHash}) could not be addressed by hash (EIP-1898, requireCanonical): ${describeRevert(e)}`,
    );
    return failedResult("not simulated: the node cannot pin calls to the block hash", blockNumber, blockHash, blockTimestamp);
  }
  record("pinned block", true, `every read and the simulation run at block ${blockNumber}, addressed by hash ${blockHash}`);

  const read = async (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => {
    const data = encodeFunctionData({ abi, functionName, args } as never);
    const ret = await rpc("eth_call", [{ to: address, data }]);
    return decodeFunctionResult({ abi, functionName, data: ret } as never) as unknown;
  };
  /** Run one read-based check. A read that throws is a FAILED check, never a skipped one. */
  const probe = async (name: string, fn: () => Promise<[boolean, string]>) => {
    try {
      const [ok, detail] = await fn();
      return record(name, ok, detail);
    } catch (e) {
      return record(name, false, `read failed: ${describeRevert(e)}`);
    }
  };
  const identityArg = { ...c.identity };

  // 1. the deployment the compile assumed (the chain id is compared again, after every read, at the end)
  record(
    "chain id",
    chainIdBefore === c.chainId,
    chainIdBefore === undefined ? "could not read the chain id" : `connected to ${chainIdBefore}; compiled for ${c.chainId}`,
  );
  await probe("implementation", async () => {
    const impl = (await read(c.factory, VNextSettlementEscrowFactoryABI, "implementation")) as Address;
    return [same(impl, c.implementation), `factory.implementation() = ${impl}; compiled with ${c.implementation}`];
  });
  await probe("predicted escrow", async () => {
    const predicted = (await read(c.factory, VNextSettlementEscrowFactoryABI, "predictEscrow", [identityArg])) as Address;
    return [same(predicted, c.escrow), `factory.predictEscrow() = ${predicted}; compiled ${c.escrow}`];
  });

  // 2. the clone
  const code = await rpc("eth_getCode", [c.escrow]).catch(() => undefined);
  const created = record(
    "escrow created",
    !!code && code !== "0x",
    code && code !== "0x" ? "the clone has code" : "no code at the predicted address: call factory.createEscrow(identity) first",
  );
  if (created) {
    await probe("escrow initialized, not sealed", async () => {
      const init = (await read(c.escrow, VNextSettlementEscrowABI, "initialized")) as boolean;
      const sealed = (await read(c.escrow, VNextSettlementEscrowABI, "configurationSealed")) as boolean;
      return [init && !sealed, `initialized=${init} configurationSealed=${sealed}`];
    });
    await probe("escrow identity", async () => {
      const [op, nonce, preRoot, policyHash, apd] = (await read(c.escrow, VNextSettlementEscrowABI, "policy")) as [
        Address,
        bigint,
        string,
        string,
        string,
      ];
      const payer = (await read(c.escrow, VNextSettlementEscrowABI, "payer")) as Address;
      const job = (await read(c.escrow, VNextSettlementEscrowABI, "jobIdHash")) as string;
      const terms = (await read(c.escrow, VNextSettlementEscrowABI, "termsHash")) as string;
      const ok =
        same(op, c.identity.operator) &&
        same(payer, c.identity.payer) &&
        nonce === c.identity.policyNonce &&
        same(preRoot, c.identity.prePolicyRoot) &&
        same(apd, c.identity.acceptedPolicyDigest) &&
        same(job, c.identity.jobIdHash) &&
        same(terms, c.identity.termsHash) &&
        /^0x0{64}$/.test(policyHash);
      return [ok, ok ? "the clone holds the compiled identity and is unfunded" : "the clone's identity differs from the compile"];
    });
    await probe("settlement token", async () => {
      const usdc = (await read(c.escrow, VNextSettlementEscrowABI, "USDC")) as Address;
      return [same(usdc, c.token), `USDC() = ${usdc}; compiled with ${c.token}`];
    });
    for (const [name, getter] of [
      ["primary cohort enabled", "authorizedOracle"],
      ["escalation cohort enabled", "escalationAttester"],
    ] as const) {
      await probe(name, async () => {
        const attester = (await read(c.escrow, VNextSettlementEscrowABI, getter)) as Address;
        const enabled = (await read(attester, ATTESTER_ABI, "enabled")) as boolean;
        return [enabled, `${getter}() = ${attester}; enabled() = ${enabled}`];
      });
    }
  }

  // 3. the policy generation
  await probe("policy nonce not revoked or superseded", async () => {
    const floor = (await read(c.factory, VNextSettlementEscrowFactoryABI, "policyNonceFloor", [c.policyKey])) as bigint;
    return [c.identity.policyNonce >= floor, `nonce ${c.identity.policyNonce}; floor ${floor}`];
  });
  await probe("job not already funded", async () => {
    const funded = (await read(c.factory, VNextSettlementEscrowFactoryABI, "fundedEscrowOf", [c.policyKey])) as Address;
    return [same(funded, zeroAddress), same(funded, zeroAddress) ? "no funded escrow for this job" : `already funded by ${funded}`];
  });

  // 4. time at the pinned block
  record("acceptance not expired", blockTimestamp <= c.expiry, `block time ${blockTimestamp}; expiry ${c.expiry}`);
  c.configs.forEach((u, i) => {
    const d = u.reclaimAt - blockTimestamp;
    record(
      `units[${i}] reclaim window`,
      u.reclaimAt > blockTimestamp && d >= VNEXT.MIN_RECLAIM_DELAY && d <= VNEXT.MAX_RECLAIM_DELAY,
      `reclaimAt - block time = ${d}s; must be in [${VNEXT.MIN_RECLAIM_DELAY}, ${VNEXT.MAX_RECLAIM_DELAY}]`,
    );
  });

  // 5. the acceptance's shape (signature VALIDITY is left to the simulation)
  try {
    checkAcceptance(acceptance, { sender, payer: c.identity.payer });
    record("acceptance shape", true, "signature sizes ok; a payer signature is present or the payer sends");
  } catch (e) {
    record("acceptance shape", false, (e as Error).message);
  }

  // 6. the exact pull: DIAGNOSTICS, reported but never deciding `ok` (only the simulation shows the token delivers it)
  const diagnose = async (name: string, fn: () => Promise<[boolean, string]>) => {
    try {
      const [ok, detail] = await fn();
      diagnostics.push({ name, ok, detail });
    } catch (e) {
      diagnostics.push({ name, ok: false, detail: `read failed: ${describeRevert(e)}` });
    }
  };
  await diagnose("payer balance", async () => {
    const bal = (await read(c.token, ERC20_ABI, "balanceOf", [c.identity.payer])) as bigint;
    return [bal >= c.totalGross, `balance ${bal}; needs ${c.totalGross}`];
  });
  await diagnose("payer allowance to the escrow", async () => {
    const allowance = (await read(c.token, ERC20_ABI, "allowance", [c.identity.payer, c.escrow])) as bigint;
    return [allowance >= c.totalGross, `allowance ${allowance}; needs ${c.totalGross}`];
  });

  // 7. the authority: simulate the exact signed call from the actual sender, at the pinned block (by hash)
  let simulation: { ok: boolean; error?: string };
  if (!created) {
    simulation = { ok: false, error: "not simulated: the escrow does not exist yet" };
  } else {
    try {
      const data = encodeFunctionData({ abi: VNextSettlementEscrowABI, functionName: "fund", args: fundArgs } as never);
      await rpc("eth_call", [{ from: sender, to: c.escrow, data }]);
      simulation = { ok: true };
    } catch (e) {
      simulation = { ok: false, error: describeRevert(e) };
    }
  }

  // The chain id again: the node must still be on the compiled chain after every read.
  let chainIdAfter: bigint | undefined;
  try {
    chainIdAfter = BigInt(await client.getChainId());
  } catch {
    chainIdAfter = undefined;
  }
  record(
    "chain id unchanged",
    chainIdAfter === c.chainId && chainIdAfter === chainIdBefore,
    `before ${chainIdBefore ?? "unread"}; after ${chainIdAfter ?? "unread"}; compiled for ${c.chainId}`,
  );

  return {
    ok: checks.every((x) => x.ok) && simulation.ok,
    checks,
    diagnostics,
    simulation,
    fundArgs,
    blockNumber,
    blockHash,
    blockTimestamp,
  };
}
