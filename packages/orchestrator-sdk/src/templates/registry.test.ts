// Registry contract tests — register two fakes, verify lookup + listing,
// guard against duplicate registration and malformed manifests.

import { describe, it, expect, beforeEach } from "vitest";
import { defineTemplate, TemplateRegistry, type TemplateManifest } from "./registry.js";

function fakePhysical(slug = "fake-physical"): TemplateManifest {
  return defineTemplate({
    slug,
    display_name: "Fake Physical",
    description: "test",
    produces: { kind: "kernel-agent", capability_class: "physical" },
    adapters: { chat: { required: true } },
    system_prompt: "test prompt",
    flow: async () => ({}),
  });
}

function fakeDigital(slug = "fake-digital"): TemplateManifest {
  return defineTemplate({
    slug,
    display_name: "Fake Digital",
    description: "test",
    produces: { kind: "data-product", capability_class: "digital" },
    adapters: { chat: { required: true } },
    system_prompt: "test prompt",
    flow: async () => ({}),
  });
}

describe("defineTemplate", () => {
  it("validates slug format (lowercase-kebab)", () => {
    expect(() =>
      defineTemplate({ ...fakePhysical(), slug: "Bad Slug" })
    ).toThrow(/lowercase-kebab/);
    expect(() =>
      defineTemplate({ ...fakePhysical(), slug: "" })
    ).toThrow(/lowercase-kebab/);
  });

  it("requires display_name, description, system_prompt", () => {
    expect(() => defineTemplate({ ...fakePhysical(), display_name: "" })).toThrow(/display_name/);
    expect(() => defineTemplate({ ...fakePhysical(), description: "" })).toThrow(/description/);
    expect(() => defineTemplate({ ...fakePhysical(), system_prompt: "" })).toThrow(/system_prompt/);
  });

  it("requires produces.{kind,capability_class}", () => {
    expect(() =>
      defineTemplate({
        ...fakePhysical(),
        produces: { kind: "", capability_class: "physical" },
      })
    ).toThrow(/produces/);
  });

  it("rejects unknown capability_class values", () => {
    expect(() =>
      defineTemplate({
        ...fakePhysical(),
        // @ts-expect-error — testing a runtime validation path
        produces: { kind: "x", capability_class: "weird" },
      })
    ).toThrow(/capability_class/);
  });
});

describe("TemplateRegistry", () => {
  let registry: TemplateRegistry;

  beforeEach(() => {
    registry = new TemplateRegistry();
  });

  it("registers and retrieves by slug", () => {
    const phys = fakePhysical();
    const dig = fakeDigital();
    registry.register(phys);
    registry.register(dig);

    expect(registry.get("fake-physical")).toBe(phys);
    expect(registry.get("fake-digital")).toBe(dig);
    expect(registry.get("missing")).toBeUndefined();
  });

  it("rejects duplicate slugs", () => {
    registry.register(fakePhysical());
    expect(() => registry.register(fakePhysical())).toThrow(/already registered/);
  });

  it("lists all in registration order", () => {
    const phys = fakePhysical("a");
    const dig = fakeDigital("b");
    registry.register(phys);
    registry.register(dig);
    expect(registry.list().map((t) => t.slug)).toEqual(["a", "b"]);
  });

  it("filters by capability_class", () => {
    registry.register(fakePhysical("p1"));
    registry.register(fakePhysical("p2"));
    registry.register(fakeDigital("d1"));
    expect(registry.listByClass("physical").map((t) => t.slug)).toEqual(["p1", "p2"]);
    expect(registry.listByClass("digital").map((t) => t.slug)).toEqual(["d1"]);
  });

  it("clear() resets the store", () => {
    registry.register(fakePhysical());
    registry.clear();
    expect(registry.list()).toEqual([]);
  });
});
