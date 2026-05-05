// Verifies the data-product manifest is well-formed and registers cleanly.

import { describe, it, expect } from "vitest";
import { TemplateRegistry } from "@pcc/orchestrator-sdk";
import manifest from "./manifest.js";
import { ALL_STATES, canTransition, nextStates } from "./flow.js";

describe("template-data-product manifest", () => {
  it("has the expected slug + capability_class", () => {
    expect(manifest.slug).toBe("data-product");
    expect(manifest.produces.capability_class).toBe("digital");
    expect(manifest.produces.kind).toBe("data-product");
  });

  it("requires the chat adapter", () => {
    expect(manifest.adapters.chat?.required).toBe(true);
  });

  it("registers cleanly", () => {
    const reg = new TemplateRegistry();
    expect(() => reg.register(manifest)).not.toThrow();
    expect(reg.get("data-product")).toBe(manifest);
  });

  it("imports its flow without throwing", async () => {
    const flow = await manifest.flow();
    expect(flow).toBeTruthy();
  });
});

describe("data-product flow state machine", () => {
  it("declares 5 states", () => {
    expect(ALL_STATES).toEqual(["identify", "describe", "schema", "price", "publish"]);
  });

  it("transitions identify -> describe -> schema -> price -> publish", () => {
    expect(canTransition("identify", "describe")).toBe(true);
    expect(canTransition("describe", "schema")).toBe(true);
    expect(canTransition("schema", "price")).toBe(true);
    expect(canTransition("price", "publish")).toBe(true);
  });

  it("rejects out-of-order transitions", () => {
    expect(canTransition("identify", "publish")).toBe(false);
    expect(canTransition("publish", "identify")).toBe(false);
  });

  it("publish is terminal", () => {
    expect(nextStates("publish")).toEqual([]);
  });
});
