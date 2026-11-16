export function fundJobIdOf(pathname: string): string | null | undefined {
  const match = /^\/fund\/([^/]+)\/?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]) || null;
  } catch {
    return null;
  }
}
