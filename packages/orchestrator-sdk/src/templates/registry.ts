// Template registry — the contract every orchestrator template implements.
//
// A template is a tiny declarative manifest plus a deferred-import flow.
// Anything universal (state-machine walking, tool execution, event bus,
// adapter wiring) lives in this SDK; the template just declares "here's my
// slug, my system prompt, my flow, and the connectors I'll need."
//
// See docs/agent-onboarder/NAVI-V2.5-SDK-REFRAME.md §3 for design rationale.
//
// Today the registry is in-memory; a future iteration will hydrate templates
// at gateway boot from the workspace, and emit `/api/orchestrator/<slug>/*`
// routes automatically. Public surface is intentionally minimal — extend by
// adding fields to `TemplateManifest` rather than splitting into multiple
// types.

export type CapabilityClass = "physical" | "digital";

export interface TemplateProduces {
  /** What kind of PCC entity does this template produce? */
  kind: string;
  /** Physical (kernel-agent for shop/lab) vs digital (data-product, etc). */
  capability_class: CapabilityClass;
}

export interface TemplateAdapter {
  required: boolean;
  /** Optional fallback adapter slug if this one is unavailable. */
  fallback?: string;
}

export interface TemplateAdapters {
  chat?: TemplateAdapter;
  voice?: TemplateAdapter;
  mcp?: TemplateAdapter;
}

export interface TemplateManifest {
  /** URL-safe identifier, e.g., "physical-operator". Routes use this. */
  slug: string;
  /** Human-readable name shown in dashboards. */
  display_name: string;
  /** One-sentence description for the picker. */
  description: string;
  /** What entity this template produces on PCC. */
  produces: TemplateProduces;
  /** Adapter requirements — SDK auto-wires what's available. */
  adapters: TemplateAdapters;
  /** Connectors the template might want to attach (suggestion only). */
  connectors_optional?: string[];
  /** System prompt that drives the LLM during the flow. */
  system_prompt: string;
  /** Lazy-import the flow module (state machine + tool wirings). */
  flow: () => Promise<unknown>;
}

/** Validate + return a template manifest. Throws on malformed input so
 *  authoring errors surface at module-load time rather than first invocation. */
export function defineTemplate(manifest: TemplateManifest): TemplateManifest {
  if (!manifest.slug || !/^[a-z][a-z0-9-]*$/.test(manifest.slug)) {
    throw new Error(`defineTemplate: slug must be lowercase-kebab; got "${manifest.slug}"`);
  }
  if (!manifest.display_name) {
    throw new Error(`defineTemplate("${manifest.slug}"): display_name is required`);
  }
  if (!manifest.description) {
    throw new Error(`defineTemplate("${manifest.slug}"): description is required`);
  }
  if (!manifest.system_prompt) {
    throw new Error(`defineTemplate("${manifest.slug}"): system_prompt is required`);
  }
  if (typeof manifest.flow !== "function") {
    throw new Error(`defineTemplate("${manifest.slug}"): flow must be a function`);
  }
  if (!manifest.produces || !manifest.produces.kind || !manifest.produces.capability_class) {
    throw new Error(`defineTemplate("${manifest.slug}"): produces.{kind,capability_class} required`);
  }
  if (!["physical", "digital"].includes(manifest.produces.capability_class)) {
    throw new Error(
      `defineTemplate("${manifest.slug}"): produces.capability_class must be "physical" | "digital"`
    );
  }
  return manifest;
}

/** In-memory registry. Cheap; safe to instantiate per-process. */
export class TemplateRegistry {
  private readonly templates = new Map<string, TemplateManifest>();

  /** Register a template. Throws if slug already exists. */
  register(template: TemplateManifest): void {
    if (this.templates.has(template.slug)) {
      throw new Error(`TemplateRegistry: slug "${template.slug}" already registered`);
    }
    this.templates.set(template.slug, template);
  }

  /** Look up a template by slug. */
  get(slug: string): TemplateManifest | undefined {
    return this.templates.get(slug);
  }

  /** All registered templates, in registration order. */
  list(): TemplateManifest[] {
    return [...this.templates.values()];
  }

  /** Filter by capability class for dashboard pickers. */
  listByClass(cls: CapabilityClass): TemplateManifest[] {
    return this.list().filter((t) => t.produces.capability_class === cls);
  }

  /** Test/setup helper — clear all registrations. */
  clear(): void {
    this.templates.clear();
  }
}

/** Default singleton — most callers can use this directly. */
export const templates = new TemplateRegistry();
