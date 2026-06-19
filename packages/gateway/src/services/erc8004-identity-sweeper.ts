/**
 * ERC-8004 IdentityRegistry retry sweeper.
 *
 * Runs on a setInterval. Picks up API keys with onchain_status='pending'
 * (or NULL) and attempts to write them to the IdentityRegistry. Best-
 * effort: a write that fails again is left pending for the next pass.
 *
 * Disabled if:
 *   - PCC_GATEWAY_PRIVATE_KEY is not set (write disabled), OR
 *   - ERC8004_SWEEPER_DISABLED=true, OR
 *   - in test env (NODE_ENV='test') — tests drive the helper directly.
 */

import {
  registerAgentOnChain,
  isIdentityWriteEnabled,
} from "./erc8004-identity-write.js";
import { getRepos } from "../db.js";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_BATCH_SIZE = 5;

let _timer: NodeJS.Timeout | undefined;

interface StartOptions {
  intervalMs?: number;
  batchSize?: number;
  gatewayUrl?: string;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

/** Start the sweeper. Safe to call once per process; no-op on re-entry. */
export function startIdentitySweeper(opts: StartOptions = {}): void {
  if (_timer) return;
  if (process.env.ERC8004_SWEEPER_DISABLED === "true") return;
  if (process.env.NODE_ENV === "test") return;
  if (!isIdentityWriteEnabled()) return;

  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const gatewayUrl =
    opts.gatewayUrl ?? process.env.PCC_GATEWAY_URL ?? "https://capability.network";
  const logger = opts.logger ?? {
    info: (m) => console.log(`[erc8004-sweeper] ${m}`),
    warn: (m) => console.warn(`[erc8004-sweeper] ${m}`),
  };

  logger.info(`starting (every ${intervalMs}ms, batch ${batchSize})`);
  _timer = setInterval(() => {
    runSweep({ batchSize, gatewayUrl, logger }).catch((err) => {
      logger.warn(`sweep error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, intervalMs);
  // Don't block process exit on this timer.
  if (typeof _timer?.unref === "function") _timer.unref();
}

/** Stop the sweeper (idempotent). */
export function stopIdentitySweeper(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = undefined;
  }
}

/**
 * Run a single sweep pass. Exported for tests + manual invocation.
 * Returns the number of writes attempted, succeeded, and failed.
 */
export async function runSweep(opts: {
  batchSize: number;
  gatewayUrl: string;
  logger: { info: (m: string) => void; warn: (m: string) => void };
}): Promise<{ attempted: number; succeeded: number; failed: number }> {
  const { batchSize, gatewayUrl, logger } = opts;
  const repo = getRepos().apiKeys;
  const pending = repo.listPendingOnchain(batchSize);
  if (pending.length === 0) {
    return { attempted: 0, succeeded: 0, failed: 0 };
  }

  let succeeded = 0;
  let failed = 0;
  for (const key of pending) {
    const operatorId = key.operatorId;
    const agentDid =
      operatorId.startsWith("0x") && /^0x[0-9a-fA-F]{40}$/.test(operatorId)
        ? `did:pcc:${operatorId.toLowerCase()}`
        : `did:pcc:${key.id}`;
    try {
      const result = await registerAgentOnChain({
        agentDid,
        agentUrl: gatewayUrl,
      });
      repo.recordOnchainSuccess(key.id, result);
      succeeded++;
      logger.info(
        `wrote agent ${result.agentId} for key ${key.id} (tx ${result.txHash})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        repo.recordOnchainFailure(key.id, msg);
      } catch {
        // non-fatal
      }
      failed++;
      logger.warn(`retry failed for key ${key.id}: ${msg.slice(0, 160)}`);
    }
  }
  return { attempted: pending.length, succeeded, failed };
}
