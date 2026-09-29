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
 * ONE BLOCK. Every read, the code lookup, the time checks and the simulation run against a single block, pinned
 * first (the latest block, or the caller's `blockNumber`), and the result names it. So `ok` is a statement about
 * that block, never a blend of several heads (astra review of #367). That removes inconsistency DURING the
 * preflight only: the transaction lands in a later block, the contract re-checks everything at execution, and
 * nothing here replaces an on-chain check.
 *
 * THE COMPILED POLICY, NOT ANOTHER ONE. The acceptance's own `expiry` must equal the compiled expiry. Otherwise
 * the simulation could pass for a differently dated policy (signed over a different digest) while the named
 * expiry check judged the compiled one.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
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
  /** Every check passed AND the exact signed `fund()` simulated without reverting, all at `blockNumber`. */
  ok: boolean;
  checks: PreflightCheck[];
  simulation: { ok: boolean; error?: string };
  /** The one block every read, the code lookup and the simulation ran against. `null` only if it could not be read. */
  blockNumber: bigint | null;
  blockHash: Hex | null;
  /** That block's timestamp: the time every window and the expiry were checked against (0 if the block was unread). */
  blockTimestamp: bigint;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The revert's error name when the contract gave one, else the first line of the message. */
export function describeRevert(e: unknown): string {
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
  const { compiled: c, acceptance, sender } = p;
  const checks: PreflightCheck[] = [];
  const record = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    return ok;
  };

  // 0. the one block everything below runs against
  let blockNumber: bigint;
  let blockHash: Hex | null;
  let blockTimestamp: bigint;
  try {
    const b = p.blockNumber === undefined ? await client.getBlock() : await client.getBlock({ blockNumber: p.blockNumber });
    if (b.number === null) throw new Error("the node returned a pending block, which has no number to pin");
    blockNumber = b.number;
    blockHash = b.hash;
    blockTimestamp = b.timestamp;
  } catch (e) {
    record("pinned block", false, `could not read the block to pin: ${describeRevert(e)}`);
    return {
      ok: false,
      checks,
      simulation: { ok: false, error: "not simulated: no block to pin" },
      blockNumber: null,
      blockHash: null,
      blockTimestamp: 0n,
    };
  }
  record("pinned block", true, `every read and the simulation run at block ${blockNumber} (${blockHash})`);

  const read = async (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi, functionName, args, blockNumber } as never) as Promise<unknown>;
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

  // 1. the deployment the compile assumed
  await probe("chain id", async () => {
    const id = BigInt(await client.getChainId());
    return [id === c.chainId, `connected to ${id}; compiled for ${c.chainId}`];
  });
  await probe("implementation", async () => {
    const impl = (await read(c.factory, VNextSettlementEscrowFactoryABI, "implementation")) as Address;
    return [same(impl, c.implementation), `factory.implementation() = ${impl}; compiled with ${c.implementation}`];
  });
  await probe("predicted escrow", async () => {
    const predicted = (await read(c.factory, VNextSettlementEscrowFactoryABI, "predictEscrow", [identityArg])) as Address;
    return [same(predicted, c.escrow), `factory.predictEscrow() = ${predicted}; compiled ${c.escrow}`];
  });

  // 2. the clone
  const code = await client.getCode({ address: c.escrow, blockNumber }).catch(() => undefined);
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

  // 4. the acceptance is for THIS compiled policy, and time at the pinned block
  record(
    "acceptance expiry matches the compiled policy",
    acceptance.expiry === c.expiry,
    `acceptance.expiry ${acceptance.expiry}; compiled expiry ${c.expiry} (the digest the signatures must cover uses the compiled one)`,
  );
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

  // 6. the exact pull (diagnostics: only the simulation shows the token actually delivers it)
  await probe("payer balance", async () => {
    const bal = (await read(c.token, ERC20_ABI, "balanceOf", [c.identity.payer])) as bigint;
    return [bal >= c.totalGross, `balance ${bal}; needs ${c.totalGross}`];
  });
  await probe("payer allowance to the escrow", async () => {
    const allowance = (await read(c.token, ERC20_ABI, "allowance", [c.identity.payer, c.escrow])) as bigint;
    return [allowance >= c.totalGross, `allowance ${allowance}; needs ${c.totalGross}`];
  });

  // 7. the authority: simulate the exact signed call from the actual sender, at the pinned block
  let simulation: { ok: boolean; error?: string };
  if (!created) {
    simulation = { ok: false, error: "not simulated: the escrow does not exist yet" };
  } else {
    try {
      await client.simulateContract({
        address: c.escrow,
        abi: VNextSettlementEscrowABI,
        functionName: "fund",
        args: [c.configs.map((u) => ({ ...u, payouts: u.payouts.map((x) => ({ ...x })) })), acceptance],
        account: sender,
        blockNumber,
      } as never);
      simulation = { ok: true };
    } catch (e) {
      simulation = { ok: false, error: describeRevert(e) };
    }
  }

  return { ok: checks.every((x) => x.ok) && simulation.ok, checks, simulation, blockNumber, blockHash, blockTimestamp };
}
