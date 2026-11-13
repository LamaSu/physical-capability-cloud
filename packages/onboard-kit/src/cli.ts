#!/usr/bin/env node
/** PCC Onboard CLI: local validation and project scaffolding. */

import { writeFileSync, mkdirSync, existsSync, realpathSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold } from "./scaffolder.js";
import { validate } from "./validate.js";
import type { OnboardConfig } from "./types.js";

const HELP = `PCC Onboard Kit — Device onboarding for the Physical Capability Cloud

Commands:
  scaffold   Generate a complete kernel project from config
  validate   Validate an onboarding configuration

Options:
  --config <path>   Path to onboard-config.json
  --output <dir>    Output directory (scaffold only, default: .)
  --json            Print the result as one JSON object (validate only)

Example:
  pcc-onboard scaffold --config ./my-shop.json --output ./my-kernel
  pcc-onboard validate --config ./my-shop.json
`;

const CHECKED = ["config", "adapters", "capabilities"];
const NOT_CHECKED = ["evidence bundles", "signing key", "wallet", "adapter modules", "kernel agent", "machine-profile template fit"];

export function runCli(argv: string[], io: { log(line: string): void; error(line: string): void }): number {
  if (argv.some(token => ["--signing-key", "--private-key", "--seed"].includes(token.split("=", 1)[0]!))) {
    io.error("keys are read from files only");
    return 2;
  }

  const command = argv[0];
  if (command === undefined || ["help", "--help", "-h"].includes(command)) {
    io.log(HELP);
    return 0;
  }
  if (command !== "validate" && command !== "scaffold") {
    io.error("Unknown command");
    io.error(HELP);
    return 2;
  }

  const usage = command === "validate"
    ? "Usage: pcc-onboard validate --config <path> [--json]"
    : "Usage: pcc-onboard scaffold --config <path> [--output <dir>]";
  let configPath: string | undefined;
  let outputDir: string | undefined;
  let json = false;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--config" || (token === "--output" && command === "scaffold")) {
      const value = argv[i + 1];
      const duplicate = token === "--config" ? configPath !== undefined : outputDir !== undefined;
      if (value === undefined || value.startsWith("-") || duplicate) {
        io.error(usage);
        return 2;
      }
      if (token === "--config") configPath = value;
      else outputDir = value;
      i++;
    } else if (token === "--json" && command === "validate") {
      if (json) {
        io.error(usage);
        return 2;
      }
      json = true;
    } else if (token.startsWith("-")) {
      const equals = token.indexOf("=");
      io.error(`Unknown flag ${equals < 0 ? token : token.slice(0, equals + 1)}`);
      return 2;
    } else {
      io.error("Unexpected argument");
      return 2;
    }
  }
  if (configPath === undefined) {
    io.error(usage);
    return 2;
  }

  let raw: string;
  let fd: number | undefined;
  try {
    fd = openSync(configPath, "r");
    const buffer = Buffer.alloc(1_048_577);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > 1_048_576) {
      io.error(`Cannot read config ${configPath}: larger than 1 MiB`);
      return 2;
    }
    raw = buffer.toString("utf-8", 0, length);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? "unreadable";
    io.error(`Cannot read config ${configPath}: ${code}`);
    return 2;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  let config: OnboardConfig;
  try {
    config = JSON.parse(raw) as OnboardConfig;
  } catch (error) {
    const position = / JSON at position (\d+)(?: \(line \d+ column \d+\))?$/.exec((error as Error).message)?.[1];
    io.error(`Cannot read config ${configPath}: not valid JSON${position ? ` (position ${position})` : ""}`);
    return 2;
  }

  const result = validate({ config });
  if (command === "validate") {
    if (json) {
      const out = {
        valid: result.valid,
        scope: "local",
        checked: CHECKED,
        notChecked: NOT_CHECKED,
        checks: result.checks,
        errors: result.errors,
        warnings: result.warnings,
        summary: result.summary,
      };
      io.log(JSON.stringify(out, null, 2));
    } else {
      io.log(result.summary);
      io.log(`Input: onboard config ${configPath} (not a kernel runtime config; see POST /api/setup/validate)`);
      io.log(`Checked: ${CHECKED.join(", ")}`);
      io.log(`Not checked: ${NOT_CHECKED.join(", ")}`);
      io.log("This checks shape and local consistency by the rules in this copy of the kit. It registers nothing, and it does not show that a gateway will list, quote, fund or pay for anything.");
    }
    return result.valid ? 0 : 1;
  }

  if (!result.valid) {
    io.error("Configuration validation failed:\n");
    io.error(result.summary);
    return 1;
  }
  const generated = scaffold({ config, outputDir: outputDir ?? "." });
  for (const file of generated.files) {
    const fullPath = join(outputDir ?? ".", file.path);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, file.content, "utf-8");
    io.log(`  Created: ${file.path} — ${file.description}`);
  }
  io.log("\n" + generated.summary);
  return 0;
}

export function isMainModule(argv1: string | undefined, moduleUrl: string): boolean {
  try {
    return !!argv1 && realpathSync(argv1) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

if (isMainModule(process.argv[1], import.meta.url)) process.exitCode = runCli(process.argv.slice(2), { log: (l) => console.log(l), error: (l) => console.error(l) });
