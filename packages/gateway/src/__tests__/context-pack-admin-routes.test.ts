import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contextPackRoutes } from "../routes/context-pack.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(contextPackRoutes);
  await app.ready();
});

afterAll(async () => { await app?.close(); });

const isChainWrite = (method: string, path: string) => method !== "GET" && path.startsWith("/api/escrow/chain/");

describe("agent context pack: admin-only escrow routes", () => {
  it("CTX1 the endpoint tables and JSON groups list no escrow chain write, and keep the escrow reads", async () => {
    const markdown = await app.inject({ method: "GET", url: "/agent-context-pack" });
    expect(markdown.statusCode).toBe(200);
    const rows = markdown.body.split("\n").filter((line) => line.startsWith("| ")).map((line) => line.split("|").map((cell) => cell.trim()));
    expect(rows.filter((cells) => isChainWrite(cells[1] ?? "", cells[2] ?? "")).map((cells) => `${cells[1]} ${cells[2]}`)).toEqual([]);
    for (const row of [
      "| GET | /api/escrow/chain/:address/dispute/:milestoneIndex | Dispute details |",
      "| GET | /api/escrow/chain/write-status | Chain write capability status |",
    ]) expect(markdown.body).toContain(row);
    const json = await app.inject({ method: "GET", url: "/agent-context-pack.json" });
    expect(json.statusCode).toBe(200);
    const body = json.json() as { endpointGroups: Array<{ name: string; endpoints: Array<{ method: string; path: string }> }> };
    const endpoints = body.endpointGroups.flatMap((group) => group.endpoints);
    expect(endpoints.filter((e) => isChainWrite(e.method, e.path)).map((e) => `${e.method} ${e.path}`)).toEqual([]);
    const escrow = body.endpointGroups.find((group) => group.name === "Escrow & Settlement");
    expect(escrow).toBeDefined();
    for (const path of ["/api/escrow", "/api/escrow/:escrowId"]) {
      expect(escrow!.endpoints.some((e) => e.method === "GET" && e.path === path), path).toBe(true);
    }
  });

  it("CTX2 the user workflow names no escrow chain write, and its steps are numbered from 1 without a gap", async () => {
    const res = await app.inject({ method: "GET", url: "/agent-context-pack" });
    const lines = res.body.split("\n");
    const start = lines.indexOf('### For Users: "I want something manufactured"');
    const end = lines.indexOf('### For Operators: "I want to offer my equipment"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const steps = lines.slice(start + 1, end).filter((line) => /^\d+\. /.test(line));
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.filter((line) => /\bPOST \/api\/escrow\/chain\//.test(line))).toEqual([]);
    expect(steps.map((line) => Number(line.slice(0, line.indexOf("."))))).toEqual(steps.map((_, i) => i + 1));
  });

  it("CTX3 llms.txt names no escrow chain write", () => {
    const llms = readFileSync(fileURLToPath(new URL("../../../../apps/dashboard/public/llms.txt", import.meta.url)), "utf8");
    expect(llms.split("\n").filter((line) => /\bPOST \/api\/escrow\/chain\//.test(line))).toEqual([]);
  });
});
