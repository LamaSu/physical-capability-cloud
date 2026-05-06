/**
 * Smoke test: every named export from index.ts resolves and is not undefined.
 * This catches barrel-file re-export typos early.
 */
import { describe, expect, it } from "vitest";

import * as bridge from "./index.js";

describe("@pcc/cypher-lims-bridge — barrel export smoke test", () => {
  it("CypherClient is exported and is a constructor", () => {
    expect(bridge.CypherClient).toBeDefined();
    expect(typeof bridge.CypherClient).toBe("function");
  });

  it("CypherApiError is exported and is a constructor", () => {
    expect(bridge.CypherApiError).toBeDefined();
    expect(typeof bridge.CypherApiError).toBe("function");
  });

  it("LimsPoller is exported and is a constructor", () => {
    expect(bridge.LimsPoller).toBeDefined();
    expect(typeof bridge.LimsPoller).toBe("function");
  });

  it("cypherServiceToPccCapability is exported as a function", () => {
    expect(bridge.cypherServiceToPccCapability).toBeDefined();
    expect(typeof bridge.cypherServiceToPccCapability).toBe("function");
  });

  it("cypherFederationServiceToMcpToolDef is exported as a function", () => {
    expect(bridge.cypherFederationServiceToMcpToolDef).toBeDefined();
    expect(typeof bridge.cypherFederationServiceToMcpToolDef).toBe("function");
  });

  it("pccCapabilityToCypherService is exported as a function", () => {
    expect(bridge.pccCapabilityToCypherService).toBeDefined();
    expect(typeof bridge.pccCapabilityToCypherService).toBe("function");
  });

  it("cypherBrowseFederationCatalog is exported as a function", () => {
    expect(bridge.cypherBrowseFederationCatalog).toBeDefined();
    expect(typeof bridge.cypherBrowseFederationCatalog).toBe("function");
  });

  it("cypherListLimsRequests is exported as a function", () => {
    expect(bridge.cypherListLimsRequests).toBeDefined();
    expect(typeof bridge.cypherListLimsRequests).toBe("function");
  });

  it("cypherGetLimsRequest is exported as a function", () => {
    expect(bridge.cypherGetLimsRequest).toBeDefined();
    expect(typeof bridge.cypherGetLimsRequest).toBe("function");
  });

  it("cypherAdvanceStep is exported as a function", () => {
    expect(bridge.cypherAdvanceStep).toBeDefined();
    expect(typeof bridge.cypherAdvanceStep).toBe("function");
  });

  it("cypherPostMeasurement is exported as a function", () => {
    expect(bridge.cypherPostMeasurement).toBeDefined();
    expect(typeof bridge.cypherPostMeasurement).toBe("function");
  });

  it("cypherRecordWork is exported as a function", () => {
    expect(bridge.cypherRecordWork).toBeDefined();
    expect(typeof bridge.cypherRecordWork).toBe("function");
  });

  it("cypherToolDefinitions is exported as an array with 6 entries", () => {
    expect(bridge.cypherToolDefinitions).toBeDefined();
    expect(Array.isArray(bridge.cypherToolDefinitions)).toBe(true);
    expect(bridge.cypherToolDefinitions).toHaveLength(6);
  });

  it("cypherToolHandlers is exported as an object with 6 keys", () => {
    expect(bridge.cypherToolHandlers).toBeDefined();
    expect(typeof bridge.cypherToolHandlers).toBe("object");
    expect(Object.keys(bridge.cypherToolHandlers)).toHaveLength(6);
  });
});
