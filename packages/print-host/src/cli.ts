#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { acceptanceDigest, domainSeparator, jobPolicyHash } from "@pcc/contracts/vnext";
import { getAddress } from "viem";
import { createEvidenceBroadcaster, EvidenceChainConfigError } from "./chain.js";
import { checkHostConfig, HostConfigError, loadHostConfig, requireSubmissionCaps } from "./config.js";
import type { HostConfig } from "./config.js";
import { createGatewayClient, GatewayClientError, strictEmergencyStopReader } from "./gateway-client.js";
import type { GatewayClient, GatewayClientConfig } from "./gateway-client.js";
import { createHost, HOST_LOG_CODES, HostIdentityError } from "./host.js";
import { createJobJournal, JournalError } from "./journal.js";
import { defaultJobInputSource, fileJobInputSource } from "./job-inputs.js";
import { generateHostKeys, KeyGenerationError } from "./keygen.js";
import { KeyFileError, loadDeviceKey, loadOperatorKey, OperatorSigningError } from "./keys.js";
import { loadHostTerms, loadJobPolicyInput, PolicyJsonError } from "./policy-json.js";
import { readSecretFile, SecretFileError } from "./secret-file.js";
// The kernel barrel starts a shop server at import time. This existing private
// workspace leaf constructs only the printer adapter.
import { IppAdapter } from "../../kernel/dist/adapters/ipp-adapter.js";
import type { MachineAdapter } from "../../kernel/dist/adapters/types.js";

export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

const usage = "Usage: print-host keygen --out <dir> [--not-after <ISO>]\n"
  + "       print-host check-config <path>\n"
  + "       print-host run --config <path> [--once] [--poll-only] [--no-submit] [--inputs-dir <dir>]\n"
  + "       print-host sign-policy --config <cfg> --terms <terms.json> --input <policy.json> --out <sig.json>\n";

export interface CliPrintComponents {
  adapter: MachineAdapter;
  dispose(): Promise<void>;
}

/** Local factories let CLI tests exercise the real host without a network or printer. */
export interface CliRunRuntime {
  createGateway?: (config: GatewayClientConfig) => GatewayClient;
  createPrinter?: (config: HostConfig) => CliPrintComponents;
  createBroadcaster?: typeof createEvidenceBroadcaster;
}

interface RunOptions {
  configPath: string;
  once: boolean;
  pollOnly: boolean;
  noSubmit: boolean;
  inputsDir?: string;
}

function parseRunOptions(argv: string[]): RunOptions | undefined {
  let configPath: string | undefined;
  let inputsDir: string | undefined;
  let once = false;
  let pollOnly = false;
  let noSubmit = false;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--once" && !once) once = true;
    else if (flag === "--poll-only" && !pollOnly) pollOnly = true;
    else if (flag === "--no-submit" && !noSubmit) noSubmit = true;
    else if ((flag === "--config" && configPath === undefined)
      || (flag === "--inputs-dir" && inputsDir === undefined)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) return undefined;
      if (flag === "--config") configPath = value;
      else inputsDir = value;
    } else return undefined;
  }
  return configPath ? { configPath, once, pollOnly, noSubmit, inputsDir } : undefined;
}

function createPrinter(config: HostConfig): CliPrintComponents {
  const adapter = new IppAdapter(config.deviceId, {
    uri: config.printer.uri, kernelId: config.kernelId, mockMode: false,
  });
  return { adapter, dispose: () => adapter.dispose() };
}

async function runCommand(options: RunOptions, io: CliIo, runtime: CliRunRuntime): Promise<void> {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let printer: CliPrintComponents | undefined;
  let journal: ReturnType<typeof createJobJournal> | undefined;
  try {
    const config = await loadHostConfig(options.configPath);
    if (!options.pollOnly && !options.noSubmit) requireSubmissionCaps(config.chain);
    // Poll-only is usable before key provisioning and never opens the printer.
    const identity = options.pollOnly ? undefined : await checkHostConfig(config);
    const operator = identity ? await loadOperatorKey(config.keys.operatorKeyFile, config.chain.chainId) : undefined;
    const deviceKey = operator ? await loadDeviceKey(config.keys.deviceKeyFile, {
      delegationBinding: { chainId: config.chain.chainId, operator: getAddress(operator.address) },
    }) : undefined;
    // Each consumer receives only its own scoped closure; no policy acceptance
    // authority or general transaction signer enters the host run loop.
    const operatorKey = operator ? Object.freeze({ address: operator.address, signD1: operator.signD1 }) : undefined;
    const broadcaster = operator && !options.noSubmit ? (runtime.createBroadcaster ?? createEvidenceBroadcaster)({ chain: config.chain },
      Object.freeze({ address: operator.address, signSubmitEvidenceTx: operator.signSubmitEvidenceTx })) : undefined;
    const apiBytes = await readSecretFile(config.gateway.apiKeyFile);
    let gateway: GatewayClient;
    try {
      const text = apiBytes.toString("utf8");
      const apiKey = text.endsWith("\r\n") ? text.slice(0, -2)
        : text.endsWith("\n") ? text.slice(0, -1) : text;
      if (!apiKey || /\s/.test(apiKey)) throw new HostConfigError("bad_api_key", config.gateway.apiKeyFile);
      gateway = (runtime.createGateway ?? createGatewayClient)({
        baseUrl: config.gateway.baseUrl, kernelId: config.kernelId, apiKey,
        ...(operator === undefined ? {} : { wallet: operator.address }),
        emergencyStopReader: strictEmergencyStopReader,
      });
    } finally { apiBytes.fill(0); }
    if (!options.pollOnly) printer = (runtime.createPrinter ?? createPrinter)(config);
    journal = createJobJournal(config.dataDir);
    const host = createHost({
      config, gateway, adapter: printer?.adapter, deviceKey, operatorAddress: operator?.address,
      operatorKey, broadcaster,
      inputSource: options.inputsDir ? fileJobInputSource(options.inputsDir) : defaultJobInputSource,
      journal, pollOnly: options.pollOnly, noSubmit: options.noSubmit,
      stopSignal: shutdown.signal,
      logger: (code) => {
        // Preserve the runtime's closed logging contract at the CLI boundary.
        if ((HOST_LOG_CODES as readonly string[]).includes(code)) io.stdout.write(`${code}\n`);
      },
    });
    if (options.once) {
      const tick = await host.runOnce();
      if (tick.kind === "halted") {
        if (tick.code === "device_identity_mismatch" || tick.code === "compromised_device") throw new HostIdentityError(tick.code);
        throw new JournalError(tick.code === "data_dir_locked" ? "data_dir_locked" : "journal_write_failed");
      }
    }
    else await host.run(shutdown.signal);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    try { await printer?.dispose(); }
    finally { await journal?.close(); }
  }
}

type PolicyCliErrorCode = "bad_arguments" | "output_exists" | "write_failed";
class PolicyCliError extends Error {
  readonly code: PolicyCliErrorCode;
  constructor(code: PolicyCliErrorCode) { super(code); this.code = code; }
}

async function signPolicy(argv: string[], io: CliIo): Promise<number> {
  try {
    const flags = new Map<string, string>();
    for (let index = 1; index < argv.length; index += 2) {
      const flag = argv[index];
      const value = argv[index + 1];
      if (!flag || !["--config", "--terms", "--input", "--out"].includes(flag)
        || !value || value.startsWith("--") || flags.has(flag)) throw new PolicyCliError("bad_arguments");
      flags.set(flag, value);
    }
    if (flags.size !== 4) throw new PolicyCliError("bad_arguments");
    const [config, terms, input] = await Promise.all([
      loadHostConfig(flags.get("--config")!), loadHostTerms(flags.get("--terms")!),
      loadJobPolicyInput(flags.get("--input")!),
    ]);
    const key = await loadOperatorKey(config.keys.operatorKeyFile, config.chain.chainId, { terms });
    const signature = await key.signJobPolicyAcceptance(input);
    const output = {
      operator: key.address, chainId: config.chain.chainId, escrow: input.policy.escrow,
      acceptanceDigest: acceptanceDigest(domainSeparator(input.policy.chainId, input.policy.escrow), jobPolicyHash(input.policy)),
      signature,
    };
    let file;
    try { file = await open(flags.get("--out")!, "wx", 0o644); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        throw new PolicyCliError("output_exists");
      }
      throw new PolicyCliError("write_failed");
    }
    try {
      // Explicit chmod makes the hand-off mode independent of the operator's umask.
      await file.chmod(0o644);
      await file.writeFile(`${JSON.stringify(output)}\n`, "utf8");
    } catch { throw new PolicyCliError("write_failed"); }
    finally { await file.close().catch(() => undefined); }
    return 0;
  } catch (error) {
    if (error instanceof OperatorSigningError || error instanceof PolicyJsonError
      || error instanceof PolicyCliError || error instanceof KeyFileError
      || error instanceof HostConfigError || error instanceof SecretFileError) {
      io.stderr.write(`${error.code}\n`);
    } else io.stderr.write("internal_error\n");
    return error instanceof PolicyCliError && error.code === "bad_arguments" ? 2 : 1;
  }
}

/** Parse arguments without ever interpolating an untrusted argument into output. */
export async function main(argv: string[], io: CliIo, runtime: CliRunRuntime = {}): Promise<number> {
  if (argv[0] === "sign-policy") return signPolicy(argv, io);
  try {
    if (argv[0] === "keygen") {
      let outDir: string | undefined;
      let notAfter: string | undefined;
      for (let index = 1; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          io.stderr.write(usage);
          return 2;
        }
        if (flag === "--out" && outDir === undefined) outDir = value;
        else if (flag === "--not-after" && notAfter === undefined) notAfter = value;
        else {
          io.stderr.write(usage);
          return 2;
        }
      }
      if (!outDir) {
        io.stderr.write(usage);
        return 2;
      }
      const generated = await generateHostKeys(outDir, { notAfter });
      io.stdout.write(`${JSON.stringify(generated)}\n`);
      return 0;
    }
    if (argv[0] === "check-config" && argv.length === 2 && argv[1]) {
      const identity = await checkHostConfig(await loadHostConfig(argv[1]));
      io.stdout.write(`${JSON.stringify(identity)}\n`);
      return 0;
    }
    if (argv[0] === "run") {
      const options = parseRunOptions(argv);
      if (options) {
        await runCommand(options, io, runtime);
        return 0;
      }
    }
    io.stderr.write(usage);
    return 2;
  } catch (error) {
    if (error instanceof SecretFileError || error instanceof KeyFileError
      || error instanceof HostConfigError || error instanceof KeyGenerationError) {
      io.stderr.write(`${argv[0] === "run" ? error.code : error.message}\n`);
    } else if (error instanceof GatewayClientError || error instanceof JournalError || error instanceof HostIdentityError
      || error instanceof EvidenceChainConfigError || error instanceof OperatorSigningError) {
      io.stderr.write(`${error.code}\n`);
    } else {
      // Native/library errors may contain input values. Never format them.
      io.stderr.write(argv[0] === "run" ? "internal_error\n" : "internal_error: print-host operation failed\n");
    }
    return 1;
  }
}

function executedDirectly(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (executedDirectly()) {
  process.exitCode = await main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
}
