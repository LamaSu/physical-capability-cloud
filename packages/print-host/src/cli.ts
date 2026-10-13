#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { acceptanceDigest, domainSeparator, jobPolicyHash } from "@pcc/contracts/vnext";
import { checkHostConfig, HostConfigError, loadHostConfig } from "./config.js";
import { generateHostKeys, KeyGenerationError } from "./keygen.js";
import { KeyFileError, loadOperatorKey, OperatorSigningError } from "./keys.js";
import { loadHostTerms, loadJobPolicyInput, PolicyJsonError } from "./policy-json.js";
import { SecretFileError } from "./secret-file.js";

export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

const usage = "Usage: print-host keygen --out <dir> [--not-after <ISO>]\n"
  + "       print-host check-config <path>\n"
  + "       print-host sign-policy --config <cfg> --terms <terms.json> --input <policy.json> --out <sig.json>\n";

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
      await file.close();
    } catch {
      await file.close().catch(() => undefined);
      await unlink(flags.get("--out")!).catch(() => undefined);
      throw new PolicyCliError("write_failed");
    }
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
export async function main(argv: string[], io: CliIo): Promise<number> {
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
    io.stderr.write(usage);
    return 2;
  } catch (error) {
    if (error instanceof SecretFileError || error instanceof KeyFileError
      || error instanceof HostConfigError || error instanceof KeyGenerationError) {
      io.stderr.write(`${error.message}\n`);
    } else {
      // Native/library errors may contain input values. Never format them.
      io.stderr.write("internal_error: print-host operation failed\n");
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
