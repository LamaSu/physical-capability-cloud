/**
 * Protocol template registry.
 *
 * In-memory store of reusable ProtocolTemplates that can be browsed,
 * searched by tag/capability, and bound to kernels via the ProtocolEngine.
 */

import type { ProtocolTemplate } from "@pcc/spec";

const templates = new Map<string, ProtocolTemplate>();

/** Register a protocol template in the registry */
export function registerProtocolTemplate(template: ProtocolTemplate): void {
  templates.set(template.id, template);
}

/** Get a protocol template by ID */
export function getProtocolTemplate(id: string): ProtocolTemplate | undefined {
  return templates.get(id);
}

/** Get all registered protocol templates */
export function getAllProtocolTemplates(): ProtocolTemplate[] {
  return [...templates.values()];
}

/** Search protocol templates by tags, required capabilities, or free-text */
export function searchProtocolTemplates(query: {
  tags?: string[];
  capabilities?: string[];
  search?: string;
}): ProtocolTemplate[] {
  let results = [...templates.values()];

  if (query.tags && query.tags.length > 0) {
    results = results.filter((t) =>
      query.tags!.some((tag) => t.tags.includes(tag)),
    );
  }

  if (query.capabilities && query.capabilities.length > 0) {
    results = results.filter((t) =>
      query.capabilities!.some((cap) => t.requiredCapabilities.includes(cap)),
    );
  }

  if (query.search) {
    const lowerSearch = query.search.toLowerCase();
    results = results.filter(
      (t) =>
        t.name.toLowerCase().includes(lowerSearch) ||
        t.description.toLowerCase().includes(lowerSearch),
    );
  }

  return results;
}

/** Clear all templates (useful for testing) */
export function clearProtocolTemplates(): void {
  templates.clear();
}
