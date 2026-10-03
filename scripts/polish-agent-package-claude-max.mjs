#!/usr/bin/env node
/**
 * RETIRED 2026-09-29 (ADK track item 2: the agent pack has one writer).
 *
 * This script used to rewrite apps/dashboard/public/agent-package.json from
 * in-script templates (title, system_prompt, examples, auth, categories).
 * Those templates are older than the live package. A re-run would:
 *   - drop the "Report failures automatically" trigger that
 *     agent-package-auto-feedback.test.ts pins;
 *   - bring back a route and three packages that do not exist;
 *   - downgrade the version.
 * Its code is gone (git history keeps it). Edit the package directly;
 * agent-pack-truth.test.ts and agent-package-auto-feedback.test.ts
 * (packages/gateway) guard it.
 *
 * Run directly, it prints this refusal and exits 1. Importing it does nothing.
 */
import { pathToFileURL } from "node:url";

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.error(
    "scripts/polish-agent-package-claude-max.mjs is retired: its templates are older than the live agent " +
      "package, so a re-run would regress it. Edit apps/dashboard/public/agent-package.json directly.",
  );
  process.exit(1);
}
