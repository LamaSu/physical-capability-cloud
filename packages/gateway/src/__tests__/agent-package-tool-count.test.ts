import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { closeStore, initStore } from "../db.js";
import {
  agentPackageLinkSentence,
  agentPackageToolCount,
} from "../mcp/http-mcp-server.js";
import { contextPackRoutes } from "../routes/context-pack.js";
import { wellKnownAeoRoutes } from "../routes/well-known-aeo.js";

const canonicalPackagePath = fileURLToPath(
  new URL(
    "../../../../apps/dashboard/public/agent-package.json",
    import.meta.url,
  ),
);
const gatewaySourceDirectory = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function readCanonicalToolCount(): number {
  const pack = JSON.parse(readFileSync(canonicalPackagePath, "utf8")) as {
    tools: unknown[];
  };
  return pack.tools.length;
}

let previousAgentPackagePath: string | undefined;
const temporaryDirectories: string[] = [];

beforeEach(() => {
  previousAgentPackagePath = process.env.PCC_AGENT_PACKAGE_PATH;
  process.env.PCC_AGENT_PACKAGE_PATH = canonicalPackagePath;
});

afterEach(() => {
  if (previousAgentPackagePath === undefined) {
    delete process.env.PCC_AGENT_PACKAGE_PATH;
  } else {
    process.env.PCC_AGENT_PACKAGE_PATH = previousAgentPackagePath;
  }

  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function useInvalidAgentPackage(): void {
  const directory = mkdtempSync(join(tmpdir(), "pcc-agent-package-count-"));
  temporaryDirectories.push(directory);
  const packagePath = join(directory, "agent-package.json");
  writeFileSync(packagePath, "{ invalid JSON", "utf8");
  process.env.PCC_AGENT_PACKAGE_PATH = packagePath;
}

function nonTestTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") {
        files.push(...nonTestTypeScriptFiles(entryPath));
      }
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !/\.(?:test|spec)\.ts$/.test(entry.name)
    ) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

describe("agent-package count helpers", () => {
  it("reads the canonical catalog's tools.length", () => {
    expect(agentPackageToolCount()).toBe(readCanonicalToolCount());
  });

  it("returns null without throwing when the override contains invalid JSON", () => {
    useInvalidAgentPackage();

    expect(() => agentPackageToolCount()).not.toThrow();
    expect(agentPackageToolCount()).toBeNull();
  });

  it.each([0, 12])(
    "includes a known count of %i in the OpenAPI link sentence",
    (toolCount) => {
      expect(agentPackageLinkSentence(toolCount)).toBe(
        `See https://capability.network/agent-package.json for the ${toolCount}-tool agent package.`,
      );
    },
  );

  it("omits all digits from the OpenAPI link sentence when the count is unknown", () => {
    const sentence = agentPackageLinkSentence(null);

    expect(sentence).toBe(
      "See https://capability.network/agent-package.json for the agent package.",
    );
    expect(sentence).not.toMatch(/\d/);
  });
});

describe("public discovery routes use the live agent-package count", () => {
  let app: FastifyInstance;
  let previousDbPath: string | undefined;

  beforeAll(async () => {
    previousDbPath = process.env.PCC_DB_PATH;
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    app = Fastify({ logger: false });
    await app.register(wellKnownAeoRoutes);
    await app.register(contextPackRoutes);
    await app.ready();
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      try {
        closeStore();
      } finally {
        if (previousDbPath === undefined) {
          delete process.env.PCC_DB_PATH;
        } else {
          process.env.PCC_DB_PATH = previousDbPath;
        }
      }
    }
  });

  it("describes the MCP catalog entry with the canonical package count and helpers", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/ai-catalog.json",
    });

    expect(response.statusCode).toBe(200);
    const catalog = response.json<{
      entries: Array<{ identifier: string; description: string }>;
    }>();
    const mcpEntry = catalog.entries.find(
      (entry) => entry.identifier === "urn:ai:capability.network:mcp",
    );

    expect(mcpEntry?.description).toBe(
      `MCP server exposing all ${readCanonicalToolCount()} PCC agent-package tools, plus MCP-only helpers, to discover, hire, and verify real-world physical capability.`,
    );
  });

  it("labels the context-pack link with the canonical count of tools", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/agent-context-pack",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      `Full Agent Package (${readCanonicalToolCount()} tools)`,
    );
    expect(response.body).not.toContain("MCP tools)");
  });

  it("serves numberless fallbacks when the package becomes unreadable after registration", async () => {
    useInvalidAgentPackage();

    const catalogResponse = await app.inject({
      method: "GET",
      url: "/.well-known/ai-catalog.json",
    });
    expect(catalogResponse.statusCode).toBe(200);

    const catalog = catalogResponse.json<{
      entries: Array<{ identifier: string; description: string }>;
    }>();
    const mcpEntry = catalog.entries.find(
      (entry) => entry.identifier === "urn:ai:capability.network:mcp",
    );
    expect(mcpEntry?.description).toBe(
      "MCP server to discover, hire, and verify real-world physical capability.",
    );

    const contextResponse = await app.inject({
      method: "GET",
      url: "/agent-context-pack",
    });
    expect(contextResponse.statusCode).toBe(200);
    expect(contextResponse.body).toContain("\n- Full Agent Package: ");
    expect(contextResponse.body).not.toContain("Full Agent Package (");
    expect(contextResponse.body).not.toContain("MCP tools)");
  });
});

describe("gateway source guards prevent agent-package count drift", () => {
  it("contains no hand-typed agent-package counts in non-test TypeScript files", () => {
    const forbiddenCounts = [
      /\b\d+-tool (?:agent package|agent-pack|MCP server)\b/,
      /Agent Package \(\d+/i,
      /\(\d+ MCP tools\)/,
      /agentPackage:\s*\{[^}]*toolCount:\s*\d+/,
    ];
    const violations: string[] = [];

    for (const filePath of nonTestTypeScriptFiles(gatewaySourceDirectory)) {
      const source = readFileSync(filePath, "utf8");

      for (const pattern of forbiddenCounts) {
        const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
        for (const match of source.matchAll(globalPattern)) {
          const line = source.slice(0, match.index ?? 0).split("\n").length;
          violations.push(
            `${relative(repositoryRoot, filePath)}:${line}: ${match[0].replace(/\s+/g, " ")}`,
          );
        }
      }
    }

    expect(
      violations,
      `Hand-typed agent-package counts found:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("builds server.ts OpenAPI info.description with the live-count sentence helper", () => {
    const source = readFileSync(join(gatewaySourceDirectory, "server.ts"), "utf8");
    const description =
      source.match(
        /\bopenapi:\s*\{\s*info:\s*\{[^}]*?\bdescription:\s*([^,}]+),/,
      )?.[1] ?? "";

    expect(
      description,
      "server.ts OpenAPI info.description must call agentPackageLinkSentence(agentPackageToolCount())",
    ).toMatch(
      /\bagentPackageLinkSentence\(\s*agentPackageToolCount\(\s*\)\s*\)/,
    );
  });

  it("reads the agent-mode discovery count through the live-count helper", () => {
    const source = readFileSync(join(gatewaySourceDirectory, "server.ts"), "utf8");

    expect(source).toMatch(
      /agentPackage:\s*\{[^}]*toolCount:\s*agentPackageToolCount\(\s*\)/,
    );
  });
});
