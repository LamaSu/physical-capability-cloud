import { getRegisteredTypes } from "@pcc/contract-builder";
import { loadBuiltinCsds } from "@pcc/spec";

let knownTypes: ReadonlySet<string> | undefined;

export function getKnownCapabilityTypes(): ReadonlySet<string> {
  if (knownTypes) return knownTypes;
  const types = new Set<string>(getRegisteredTypes());
  for (const csd of loadBuiltinCsds().list()) {
    const record = csd as Record<string, unknown>;
    if (typeof record.type === "string" && record.type.trim()) {
      types.add(record.type.trim());
    } else if (typeof record.url === "string") {
      const slug = /^pcc:\/\/capabilities\/([^/]+)\//i.exec(record.url)?.[1];
      if (slug) types.add(slug);
    }
  }
  knownTypes = types;
  return knownTypes;
}
