import { describe, it, expect } from "vitest";
import {
  inferLocatorType,
  KNOWN_MODULES,
  lookupDomainId,
  lookupSkillId,
} from "../catalog.js";

describe("lookupSkillId", () => {
  it("returns OASF baseline IDs for known skills", () => {
    expect(lookupSkillId("agent_orchestration/task_decomposition")).toBe(1001);
    expect(lookupSkillId("natural_language_processing/summarization")).toBe(2002);
  });

  it("returns PCC bridge IDs for manufacturing skills", () => {
    expect(lookupSkillId("manufacturing/cnc-5axis")).toBe(9102);
    expect(lookupSkillId("manufacturing/fdm")).toBe(9103);
  });

  it("returns undefined for unknown skills", () => {
    expect(lookupSkillId("nope/not-real")).toBeUndefined();
  });
});

describe("lookupDomainId", () => {
  it("returns known domain IDs", () => {
    expect(lookupDomainId("manufacturing/cnc")).toBe(9011);
    expect(lookupDomainId("biotech/analytical")).toBe(9511);
  });

  it("returns undefined for unknown domains", () => {
    expect(lookupDomainId("not/a/domain")).toBeUndefined();
  });
});

describe("inferLocatorType", () => {
  it("recognizes ipfs://", () => {
    expect(inferLocatorType("ipfs://bafy123")).toBe("ipfs");
  });

  it("recognizes GitHub source code", () => {
    expect(inferLocatorType("https://github.com/lamasu/pcc")).toBe("source_code");
    expect(inferLocatorType("https://gitlab.com/foo/bar.git")).toBe("source_code");
  });

  it("recognizes docker images", () => {
    expect(inferLocatorType("https://ghcr.io/lamasu/pcc:latest")).toBe(
      "docker_image",
    );
  });

  it("recognizes MCP servers by URL path", () => {
    expect(inferLocatorType("https://capability.network/mcp")).toBe("mcp_server");
    expect(inferLocatorType("https://example.com/mcp.json")).toBe("mcp_server");
  });

  it("recognizes a2a cards", () => {
    expect(
      inferLocatorType("https://example.com/.well-known/agent-card.json"),
    ).toBe("a2a_card");
  });

  it("falls back to rest_endpoint for plain https", () => {
    expect(inferLocatorType("https://example.com/api/v1/x")).toBe("rest_endpoint");
  });

  it("falls back to binary for unknown schemes", () => {
    expect(inferLocatorType("magnet:?xt=urn:btih:abc")).toBe("binary");
  });
});

describe("KNOWN_MODULES", () => {
  it("exposes the canonical PCC + integration module slugs", () => {
    expect(KNOWN_MODULES.PHYSICAL_CAPABILITY_V1).toBe("physical-capability/v1");
    expect(KNOWN_MODULES.TOOL_SCHEMA_V1).toBe("tool-schema/v1");
    expect(KNOWN_MODULES.INTEGRATION_AGENTSPEC).toBe("integration/agentspec");
  });
});
