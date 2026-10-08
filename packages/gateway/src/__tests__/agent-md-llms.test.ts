import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = new URL("../../../../", import.meta.url);
const readSource = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, repoRoot)), "utf8");

describe("agent golden path public index", () => {
  const llms = readSource("apps/dashboard/public/llms.txt");
  const prerequisites = readSource("starter/runbook/00-prerequisites.md");

  it("makes agent.md the first start-here link", () => {
    const startHere = llms.match(/## Start here[^\n]*\n([\s\S]*?)(?:\n## |$)/)?.[1];
    expect(startHere, "llms.txt must retain its Start here section").toBeDefined();
    const firstLink = startHere?.match(/^- \[([^\]]+)\]\(([^)]+)\)/m);
    expect(firstLink?.[2]).toBe("https://capability.network/.well-known/agent.md");
  });

  it("does not publish hand-kept tool counts", () => {
    // Opus r1 F6: a number within two words of "tool" or "tools", on either side, so "256 MCP tools",
    // "253 tool definitions", "250+ tools" and "tools: 77" are caught, not only "254 real tools".
    const toolCounts = [/\b\d[\d,]*\+?\s+(?:\S+\s+){0,2}tools?\b/i, /\btools?\b\W*(?:\S+\s+){0,2}\(?\d/i];
    for (const [name, text] of [["llms.txt", llms], ["agent.md", readSource("apps/dashboard/public/.well-known/agent.md")]]) {
      for (const pattern of toolCounts) expect(text.match(pattern)?.[0], `${name} states a tool count`).toBeUndefined();
    }
    expect(llms).not.toContain("254");
  });

  it("copies the crypto PyPI requirement and exact pinned source fallback from the runbook", () => {
    const installCommands = prerequisites.match(/^python3 -m pip install '[^'\n]+'/gm) ?? [];
    expect(installCommands).toHaveLength(2);
    expect(installCommands[0]).toBe("python3 -m pip install 'pcc-node[crypto]>=0.1.1'");
    expect(installCommands[1]).toMatch(
      /^python3 -m pip install 'pcc-node\[crypto\] @ git\+https:\/\/github\.com\/LamaSu\/physical-capability-cloud@[a-f0-9]{40}#subdirectory=packages\/pcc-node'$/,
    );
    for (const command of installCommands) expect(llms).toContain(command);
    expect(llms).not.toMatch(/pip install pcc-node(?:\s|`)/);
  });

  it("explains the source fallback while 0.1.1 is unavailable on PyPI", () => {
    expect(llms).toMatch(/Until 0\.1\.1 is on PyPI/);
    expect(llms).toMatch(/0\.1\.0 was withdrawn/);
  });

  it("preserves all three provider lanes and scopes the supply path to machines", () => {
    expect(llms).toContain("- Machine — a robot, printer, instrument, or lab. Bound by an adapter (`octoprint`, `modbus`, `opcua`, `sila`, `generic-http`, `mock`). The `pcc-node` daemon polls for jobs and runs them locally; your endpoint never faces the network.");
    expect(llms).toContain("- Human skill — a person offering a skill. Gets pinged, accepts within a window, finishes by a deadline.");
    expect(llms).toContain("- Asset — a thing that posts outbound demand on its own behalf, bidding for capabilities within an owner-set budget.");
    expect(llms).toContain("agent.md's supply path covers the machine lane, through the");
    expect(llms).not.toContain("CLI alternative:");
  });

  it("lists registered composition and single-capability assembly routes with the approval boundary", () => {
    const server = readSource("packages/gateway/src/server.ts");
    const compose = readSource("packages/gateway/src/routes/compose.ts");
    const build = readSource("packages/gateway/src/routes/build.ts");
    expect(server).toContain("await app.register(composeRoutes)");
    expect(server).toContain("await app.register(buildRoutes)");
    expect(compose).toContain('app.post("/api/compose"');
    expect(compose).toContain('"/api/compose/:id",');
    expect(llms).toContain("- Composition: `POST /api/compose`, `GET /api/compose/:id`");
    for (const endpoint of ["options", "price", "contract"]) {
      expect(build).toContain(`"/api/build/${endpoint}",`);
      expect(llms).toContain(`\`POST /api/build/${endpoint}\``);
    }
    expect(llms).toContain("single-capability contract assembly (spending requires the human's approval)");
  });

  it("lists the maintained integration reference alongside the other docs MCP resources", () => {
    const docsMcp = llms.split("A second, read-only MCP surface")[1]?.split("\n")[0];
    expect(docsMcp).toBeDefined();
    for (const uri of ["agent-guide", "api", "quickstart", "integration"]) {
      expect(docsMcp).toContain(`docs://pcc/${uri}`);
    }
  });

  it("updates the claim ledger for the retired onboarding document", () => {
    const claims = readSource("apps/dashboard/src/lib/public-claims.ts");
    const onboardEntry = claims.match(
      /"packages\/onboard-kit\/AGENT_INSTRUCTIONS\.md":\s*\n\s*"([^"]+)"/,
    )?.[1];
    expect(onboardEntry).toBeDefined();
    expect(onboardEntry).not.toContain("served as /docs/agent-guide");
    expect(onboardEntry).toContain("/.well-known/agent.md");
  });
});
