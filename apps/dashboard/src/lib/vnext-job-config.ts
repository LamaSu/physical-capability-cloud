/** Public build-time membership from the run trace; malformed entries fail closed. */
export function parseVnextJobIds(raw: unknown): ReadonlySet<string> {
  const ids = new Set<string>();
  if (typeof raw !== "string") return ids;
  for (const entry of raw.split(",")) {
    const id = entry.trim();
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) ids.add(id);
  }
  return ids;
}

export function configuredVnextJobIds(): ReadonlySet<string> {
  return parseVnextJobIds(import.meta.env.VITE_VNEXT_JOB_IDS);
}
