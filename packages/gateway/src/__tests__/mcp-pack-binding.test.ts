/**
 * The MCP server names the pack it runs (hosted agent review, Q5-A).
 *
 * A client that pinned an agent package by version and digest needs the server
 * to say which package it is executing. `serverInfo.version` carries the pack
 * version plus the sha256 of the EXACT bytes the server read, as SemVer build
 * metadata (legal, and ignored for precedence): `<version>+sha256.<hex>`.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appsHttpMcpRoutes, httpMcpRoutes, loadAgentPackage } from "../mcp/http-mcp-server.js";

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const here = dirname(fileURLToPath(import.meta.url));
const SERVED_PACK = resolve(here, "../../../../apps/dashboard/public/agent-package.json");

let dir: string;
let savedPath: string | undefined;
const apps: FastifyInstance[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mcp-pack-binding-"));
  savedPath = process.env.PCC_AGENT_PACKAGE_PATH;
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  if (savedPath === undefined) delete process.env.PCC_AGENT_PACKAGE_PATH;
  else process.env.PCC_AGENT_PACKAGE_PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

/** Point the gateway at a pack file with these exact bytes. */
function servePack(bytes: string): string {
  const file = join(dir, "agent-package.json");
  writeFileSync(file, bytes);
  process.env.PCC_AGENT_PACKAGE_PATH = file;
  return file;
}

async function gateway(...routes: Array<typeof httpMcpRoutes>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  for (const r of routes) await app.register(r);
  await app.ready();
  apps.push(app);
  return app;
}

async function reportedVersion(app: FastifyInstance, url: "/mcp" | "/mcp/apps"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url,
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pack-binding-test", version: "1.0.0" } },
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().result.serverInfo.version as string;
}

// Deliberately not what JSON.stringify would write: key order, CRLF, tabs, blank lines.
const ODD_BYTES = '{\n  "tools": [],\r\n\t"version":"9.9.9",   "name":"Odd Pack","description":"d"\n}\n\n';

describe("serverInfo.version binds the session to the exact pack bytes (Q5-A)", () => {
  it("Q5-A: the version is the pack version plus the sha256 of the EXACT bytes read, never of a re-serialization", async () => {
    servePack(ODD_BYTES);
    expect(sha256(ODD_BYTES)).not.toBe(sha256(JSON.stringify(JSON.parse(ODD_BYTES)))); // the test is meaningful
    const app = await gateway(httpMcpRoutes);
    expect(await reportedVersion(app, "/mcp")).toBe(`9.9.9+sha256.${sha256(ODD_BYTES)}`);
  });

  it("Q5-A: the served agent package reports its own bytes' digest, as legal SemVer build metadata", async () => {
    delete process.env.PCC_AGENT_PACKAGE_PATH;
    const bytes = readFileSync(SERVED_PACK);
    const version = (JSON.parse(bytes.toString("utf8")) as { version: string }).version;
    const app = await gateway(httpMcpRoutes);
    const reported = await reportedVersion(app, "/mcp");
    expect(reported).toBe(`${version}+sha256.${sha256(bytes)}`);
    expect(reported).toMatch(/^\d+\.\d+\.\d+\+sha256\.[0-9a-f]{64}$/);
  });

  it("Q5-A: the digest follows the file on the next session, with no restart (the pack is read per session)", async () => {
    servePack(ODD_BYTES);
    const app = await gateway(httpMcpRoutes);
    const first = await reportedVersion(app, "/mcp");
    const changed = ODD_BYTES.replace('"d"', '"e"'); // one byte, same version
    servePack(changed);
    const second = await reportedVersion(app, "/mcp");
    expect(first).toBe(`9.9.9+sha256.${sha256(ODD_BYTES)}`);
    expect(second).toBe(`9.9.9+sha256.${sha256(changed)}`);
    expect(second).not.toBe(first);
  });

  it("Q5-A: the read-only /mcp/apps surface reports the same binding as /mcp", async () => {
    servePack(ODD_BYTES);
    const app = await gateway(httpMcpRoutes, appsHttpMcpRoutes);
    expect(await reportedVersion(app, "/mcp/apps")).toBe(await reportedVersion(app, "/mcp"));
  });

  it("Q5-A: loadAgentPackage() still returns the bare pack version, for the callers that read it (docs MCP, server card)", () => {
    servePack(ODD_BYTES);
    expect(loadAgentPackage().version).toBe("9.9.9");
  });
});
