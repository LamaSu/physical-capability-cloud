/**
 * Galaxy-SynBioCAD MCP tools — end-to-end over the in-memory transport.
 *
 * Boots the real server, connects a real MCP client, and calls the three
 * discovery tools the way a client would — proving the wiring dispatches to the
 * adapter catalog, not just that the tools registered.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "../index.js";

let client: Client;

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "galaxy-synbiocad-smoke", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
});

function parse(res: unknown): Record<string, unknown> {
  const content = (res as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0].text);
}

describe("Galaxy-SynBioCAD MCP tools", () => {
  it("registers the three discovery tools", async () => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const n of [
      "pcc_galaxy_synbiocad_stages",
      "pcc_galaxy_synbiocad_list_tools",
      "pcc_galaxy_synbiocad_tool_schema",
    ]) {
      expect(names.has(n), `missing ${n}`).toBe(true);
    }
  });

  it("list_tools returns the advertised catalog incl. retropath2", async () => {
    const data = parse(
      await client.callTool({ name: "pcc_galaxy_synbiocad_list_tools", arguments: {} }),
    );
    expect(data.count as number).toBeGreaterThan(40);
    expect((data.tools as Array<{ id: string }>).some((t) => t.id === "retropath2")).toBe(true);
  });

  it("list_tools filters by pipeline stage", async () => {
    const data = parse(
      await client.callTool({
        name: "pcc_galaxy_synbiocad_list_tools",
        arguments: { stage: "retrosynthesis" },
      }),
    );
    const tools = data.tools as Array<{ id: string; stage: string }>;
    expect(tools.every((t) => t.stage === "retrosynthesis")).toBe(true);
    expect(tools.some((t) => t.id === "retropath2")).toBe(true);
  });

  it("tool_schema returns the JSON-Schema I/O contract", async () => {
    const data = parse(
      await client.callTool({
        name: "pcc_galaxy_synbiocad_tool_schema",
        arguments: { toolId: "retropath2" },
      }),
    );
    const input = data.input_schema as { required?: string[]; properties: Record<string, unknown> };
    const output = data.output_schema as { properties: Record<string, unknown> };
    expect(input.required).toContain("rulesfile");
    expect(input.required).toContain("source_inchi");
    expect(output.properties.Reaction_Network).toBeTruthy();
  });

  it("tool_schema is helpful on an unknown id", async () => {
    const data = parse(
      await client.callTool({
        name: "pcc_galaxy_synbiocad_tool_schema",
        arguments: { toolId: "does-not-exist" },
      }),
    );
    expect(data.error as string).toMatch(/unknown/);
  });

  it("stages returns the pipeline overview", async () => {
    const data = parse(
      await client.callTool({ name: "pcc_galaxy_synbiocad_stages", arguments: {} }),
    );
    expect((data.stages as Record<string, string[]>).retrosynthesis).toContain("retropath2");
    expect(data.tool_count as number).toBeGreaterThan(50);
  });
});
