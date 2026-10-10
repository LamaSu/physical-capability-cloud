#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkHostConfig, HostConfigError, loadHostConfig } from "./config.js";
import { generateHostKeys, KeyGenerationError } from "./keygen.js";
import { KeyFileError } from "./keys.js";
import { SecretFileError } from "./secret-file.js";

export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

const usage = "Usage: print-host keygen --out <dir> [--not-after <ISO>]\n"
  + "       print-host check-config <path>\n";

/** Parse arguments without ever interpolating an untrusted argument into output. */
export async function main(argv: string[], io: CliIo): Promise<number> {
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
      io.stderr.write(`${error.code}: ${error.message}\n`);
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
