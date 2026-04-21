/**
 * @pcc/alerts — public library surface.
 *
 * Other packages can consume the primitives directly. The server is the
 * "batteries-included" entrypoint; importing from this index lets consumers
 * embed a watcher/prober/heartbeat inside their own process.
 *
 * Author: implementer-alpha
 */

export type { Alert, Severity, AlertSource } from "./types.js";

export {
  alertsConfigSchema,
  loadAlertsConfig,
  type AlertsConfig,
  type ChainWatcherConfig,
  type ChainEventRule,
  type RpcProbeConfig,
  type HeartbeatConfig,
  type DiscordNotifierConfig,
  type NotifiersConfig,
} from "./config.js";

export { AlertRingBuffer } from "./ring-buffer.js";

export { NotifierRegistry, type Notifier } from "./notifiers/index.js";
export { createDiscordNotifier, type DiscordNotifierOptions } from "./notifiers/discord.js";

export {
  startChainWatcher,
  evaluateRule,
  logToAlert,
  type ChainWatcherHandle,
  type ChainClientFactory,
  type ViemLikeClient,
  type DecodedLog,
  type StartChainWatcherOptions,
} from "./chain-watcher.js";

export {
  startRpcHealth,
  quantile,
  type RpcHealthHandle,
  type BlockNumberProvider,
  type BlockNumberProviderFactory,
  type StartRpcHealthOptions,
} from "./rpc-health.js";

export {
  startHeartbeat,
  type HeartbeatHandle,
  type StartHeartbeatOptions,
} from "./heartbeat.js";

export { buildServer, main, type BuildServerOptions, type BuiltServer } from "./server.js";
