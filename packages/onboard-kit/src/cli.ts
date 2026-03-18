#!/usr/bin/env node
/**
 * PCC Onboard CLI
 *
 * Usage:
 *   pcc-onboard scaffold --config ./onboard-config.json --output ./my-kernel
 *   pcc-onboard validate --config ./onboard-config.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { scaffold } from "./scaffolder.js";
import { validate } from "./validate.js";
import type { OnboardConfig } from "./types.js";

const args = process.argv.slice(2);
const command = args[0];

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function loadConfig(configPath: string): OnboardConfig {
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as OnboardConfig;
}

switch (command) {
  case "scaffold": {
    const configPath = getArg("--config");
    const outputDir = getArg("--output") ?? ".";

    if (!configPath) {
      console.error("Usage: pcc-onboard scaffold --config <path> [--output <dir>]");
      process.exit(1);
    }

    const config = loadConfig(configPath);

    // Validate first
    const validation = validate({ config });
    if (!validation.valid) {
      console.error("Configuration validation failed:\n");
      console.error(validation.summary);
      process.exit(1);
    }

    // Scaffold
    const result = scaffold({ config, outputDir });

    for (const file of result.files) {
      const fullPath = join(outputDir, file.path);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, file.content, "utf-8");
      console.log(`  Created: ${file.path} — ${file.description}`);
    }

    console.log("\n" + result.summary);
    break;
  }

  case "validate": {
    const configPath = getArg("--config");

    if (!configPath) {
      console.error("Usage: pcc-onboard validate --config <path>");
      process.exit(1);
    }

    const config = loadConfig(configPath);
    const result = validate({ config });
    console.log(result.summary);
    process.exit(result.valid ? 0 : 1);
  }

  default:
    console.log(`PCC Onboard Kit — Device onboarding for the Physical Capability Cloud

Commands:
  scaffold   Generate a complete kernel project from config
  validate   Validate an onboarding configuration

Options:
  --config <path>   Path to onboard-config.json
  --output <dir>    Output directory (scaffold only, default: .)

Example:
  pcc-onboard scaffold --config ./my-shop.json --output ./my-kernel
  pcc-onboard validate --config ./my-shop.json
`);
}
