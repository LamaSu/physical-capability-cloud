/**
 * MCP Apps runtime-asset integrity (audit directive 6).
 *
 * The gateway loads three asset groups from disk to serve the generative-UI +
 * docs MCP surfaces: pcc-ui.js and manifest.schema.json (mcp-app-view.ts) and the
 * committed prose docs (docs-mcp-server.ts). Before this change they were read at
 * REQUEST time, so a production image missing one would throw deep inside
 * tools/list / resources/read — making every PCC tool undiscoverable, silently.
 *
 * Now each asset is read + cached ONCE at startup via primeMcpAppAssets() /
 * primeDocsAssets(), called from the route registration (server.ts awaits it), and
 * a missing asset FAILS THE BOOT with a clear diagnostic. These tests prove both
 * the happy path (present assets prime cleanly) and the fail-fast path (a missing
 * asset throws a diagnostic that names it). The exact-image counterpart is
 * scripts/mcp-app-smoke.mjs + the Dockerfile asset-presence RUN assertion.
 */

import { afterEach, describe, expect, it } from "vitest";
import { primeMcpAppAssets, _resetMcpAppAssetCacheForTests } from "../mcp/mcp-app-view.js";
import { primeDocsAssets, _resetDocsAssetCacheForTests } from "../mcp/docs-mcp-server.js";

const ASSET_ENV = [
  "PCC_UI_KIT_PATH",
  "PCC_DASHBOARD_SCHEMA_PATH",
  "PCC_DOC_AGENT_GUIDE_PATH",
  "PCC_DOC_QUICKSTART_PATH",
];

describe("directive 6 — MCP-App runtime asset startup priming", () => {
  afterEach(() => {
    for (const key of ASSET_ENV) delete process.env[key];
    _resetMcpAppAssetCacheForTests();
    _resetDocsAssetCacheForTests();
  });

  it("primeMcpAppAssets() succeeds when the committed kit + schema are present (idempotent)", () => {
    _resetMcpAppAssetCacheForTests();
    expect(() => primeMcpAppAssets()).not.toThrow();
    // A second call is served from cache and also succeeds (once-at-startup, cached).
    expect(() => primeMcpAppAssets()).not.toThrow();
  });

  it("primeDocsAssets() succeeds when the committed docs are present", () => {
    _resetDocsAssetCacheForTests();
    expect(() => primeDocsAssets()).not.toThrow();
  });

  it("primeMcpAppAssets() FAILS FAST with a clear diagnostic that names the missing asset", () => {
    _resetMcpAppAssetCacheForTests();
    // An explicit override pointing nowhere is treated as a missing asset (a prod
    // image that dropped the file behaves the same way at the candidate-search level).
    process.env.PCC_UI_KIT_PATH = "/pcc/definitely/missing/pcc-ui.js";
    expect(() => primeMcpAppAssets()).toThrow(/MCP Apps assets are missing[\s\S]*pcc-ui\.js/);
  });

  it("primeDocsAssets() FAILS FAST with a clear diagnostic that names the missing doc", () => {
    _resetDocsAssetCacheForTests();
    process.env.PCC_DOC_AGENT_GUIDE_PATH = "/pcc/definitely/missing/AGENT_INTEGRATION.md";
    expect(() => primeDocsAssets()).toThrow(/docs assets are missing[\s\S]*AGENT_INTEGRATION\.md/);
  });
});
