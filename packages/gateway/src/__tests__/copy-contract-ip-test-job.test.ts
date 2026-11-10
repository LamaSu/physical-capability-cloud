import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contextPackRoutes } from "../routes/context-pack.js";
import { buildRoutes } from "../routes/build.js";
import { initStore, closeStore } from "../db.js";
import { createOperationIdTransform } from "../openapi/operation-id.js";

let packApp: FastifyInstance;
let specApp: FastifyInstance;

beforeAll(async () => {
  packApp = Fastify({ logger: false });
  await packApp.register(contextPackRoutes);
  await packApp.ready();
});

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  specApp = Fastify({ logger: false });
  await specApp.register(fastifySwagger, {
    transform: createOperationIdTransform(),
    openapi: {
      info: {
        title: "Physical Capability Cloud Gateway",
        version: "0.1.0",
        description: "Agent-native API for discovering and invoking physical capabilities.",
      },
      servers: [{ url: "https://capability.network" }],
      components: {
        securitySchemes: {
          bearer: { type: "http", scheme: "bearer" },
        },
      },
    },
  });
  await specApp.register(fastifySwaggerUi, { routePrefix: "/docs" });
  specApp.get("/openapi.json", async () => specApp.swagger());
  await specApp.register(buildRoutes);
  await specApp.ready();
});

afterAll(async () => {
  await packApp?.close();
  await specApp?.close();
  closeStore();
});

const readRepoFile = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), "utf8");

describe("copy contract: build, settlement, IP routes and test job", () => {
  it("CC1 user workflow step 7 names the settlement read and no settlement promise remains", async () => {
    const res = await packApp.inject({ method: "GET", url: "/agent-context-pack" });
    expect(res.statusCode).toBe(200);
    const lines = res.body.split("\n");
    expect(lines).toContain(
      "7. Check settlement: `GET /api/settlement/:jobId` reports what the job's escrow records show (settled only when a settlement read confirms it)",
    );
    expect(res.body).not.toContain("Settlement happens when evidence meets tier requirements");
  });

  it("CC2 test job row and operator steps describe the in-process limit and no automatic arrivals", async () => {
    const res = await packApp.inject({ method: "GET", url: "/agent-context-pack" });
    expect(res.statusCode).toBe(200);
    const lines = res.body.split("\n");
    expect(lines).toContain(
      "| POST | /api/setup/test-job | Submit a test job for one device; the gateway runs it only for a kernel it operates in-process |",
    );
    expect(lines).toContain(
      "6. `POST /api/setup/test-job` -- run a test job (only on a kernel the gateway operates in-process; it activates nothing)",
    );
    expect(lines).toContain(
      "7. `pcc-node` keeps the kernel online and takes no jobs: devices run only through the operating agent's typed operations",
    );
    expect(res.body).not.toContain("verify the full pipeline");
    expect(res.body).not.toContain("Jobs arrive automatically");
  });

  it("CC3 IP heading note, rows and steps record assets without on-chain claims", async () => {
    const res = await packApp.inject({ method: "GET", url: "/agent-context-pack" });
    expect(res.statusCode).toBe(200);
    const lines = res.body.split("\n");
    const headingIndex = lines.indexOf("### IP (Intellectual Property)");
    expect(headingIndex).toBeGreaterThan(-1);
    expect(lines[headingIndex + 1]).toBe(
      "Story Protocol (now The DATA Foundation). These routes make no on-chain call: nothing is registered, claimed or disputed on chain.",
    );
    for (const row of [
      "| POST | /api/ip/register-capability | Record a capability as an IP asset |",
      "| POST | /api/ip/register-job-evidence | Record job evidence as a derivative of a capability's IP asset |",
      "| POST | /api/ip/distribute-royalties | Set revenue splits for an IP asset; no revenue is paid from them |",
      "| POST | /api/ip/settle-royalties | Settles nothing on chain: no tokens move, and any transaction hash in the reply is a placeholder |",
      "| POST | /api/ip/:ipId/pay | Record a royalty payment to an IP asset; no tokens move |",
      "| POST | /api/ip/:ipId/claim | Claim an IP asset's recorded revenue; nothing is paid out |",
      "| GET | /api/ip/:ipId/revenue | Get the revenue PCC has recorded for an IP asset; no revenue has been paid |",
      "2. `POST /api/ip/register-capability` -- record it as an IP asset (no on-chain call)",
      "5. `POST /api/ip/:ipId/claim` -- claim its recorded revenue (nothing is paid out)",
    ]) {
      expect(lines).toContain(row);
    }
    for (const phrase of [
      "Story Protocol IP",
      "register as Story Protocol",
      "-- claim royalties",
      "Pay royalties for usage",
      "Distribute royalties for an IP asset",
      "Settle accumulated royalties",
      "Claim accumulated royalty revenue",
    ]) {
      expect(res.body).not.toContain(phrase);
    }
  });

  it("CC4 structured pack IP descriptions record without payment and no test job pipeline claim remains", async () => {
    const res = await packApp.inject({ method: "GET", url: "/agent-context-pack.json" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      endpointGroups: Array<{
        name: string;
        endpoints: Array<{ method: string; path: string; description: string }>;
      }>;
    };
    const group = body.endpointGroups.find((g) => g.name === "IP & Royalties");
    expect(group).toBeDefined();
    const byPath = new Map(group!.endpoints.map((e) => [`${e.method} ${e.path}`, e.description]));
    expect(byPath.get("POST /api/ip/register-capability")).toBe("Record an IP asset (no on-chain call)");
    expect(byPath.get("POST /api/ip/distribute-royalties")).toBe("Set revenue splits (no revenue is paid)");
    expect(byPath.get("POST /api/ip/:ipId/claim")).toBe("Claim recorded revenue (nothing is paid out)");
    for (const endpoint of body.endpointGroups.flatMap((g) => g.endpoints)) {
      expect(endpoint.description).not.toContain("verify the full pipeline");
    }
  });

  it("CC5 openapi build contract description ends with the no-escrow sentence and names no funding route", async () => {
    const res = await specApp.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json() as {
      paths: Record<string, { post?: { description?: string } }>;
    };
    expect(spec.paths["/api/build/contract"]?.post?.description).toBe(
      "Synchronously builds a contract for the given capability type with the provided parameter selections and assurance tier (0-3). Returns an unsigned contract. Building it creates no escrow and funds nothing.",
    );
    expect(JSON.stringify(spec)).not.toContain("/api/escrow/fund");
  });

  it("CC6 source copies carry the corrected sentences and no longer carry the old phrases", () => {
    const onboard = readRepoFile("packages/gateway/src/routes/onboard.ts");
    expect(onboard).toContain('message: "Evidence accepted \u2014 registration auto-approved and activated.",');
    expect(onboard).not.toContain("now live on the network");

    const a2a = readRepoFile("packages/gateway/src/routes/a2a-tasks.ts");
    expect(a2a).toContain(
      '? "POST /api/setup/test-job { kernelId, deviceId, assuranceTier }: the gateway runs a test job only for a kernel it operates in-process, and a test job activates nothing"',
    );
    expect(a2a).not.toContain("to prove + auto-activate");

    const setupAgent = readRepoFile("packages/agent-support/src/setup-agent.ts");
    expect(setupAgent).toContain(
      'description: "Submit a test job for one device on a kernel (Step 4 of onboarding). The gateway runs it only for a kernel it operates in-process; for any other kernel it refuses and runs nothing. Every reply says whether the job ran and passed.",',
    );
    expect(setupAgent).not.toContain("verify the full pipeline end-to-end");

    const mcpReadme = readRepoFile("packages/mcp-server/README.md");
    expect(mcpReadme).toContain("| `pcc_build_contract` | Full unsigned contract object. Building it funds nothing. |");
    expect(mcpReadme).not.toContain("ready for escrow funding");

    const mcpIndex = readRepoFile("packages/mcp-server/src/index.ts");
    expect(mcpIndex).toContain(
      '"Build a complete capability contract with all parameters, pricing, and assurance tier. Returns the full unsigned contract object; building it creates no escrow and funds nothing.",',
    );
    expect(mcpIndex).not.toContain("object ready for escrow.");
  });
});
