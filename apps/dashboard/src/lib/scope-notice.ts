const FUNDS_NOTICE = "Moving funds needs a key issued by PCC; your wallet sign-in can do everything else.";
const CONTRIBUTOR_NOTICE = "Publishing a rate schedule needs your contributor key with schedule:publish permission.";
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function scopeErrorMessage(
  response: Response,
  path: string,
  method: string,
): Promise<string | null> {
  if (response.status !== 403 || !WRITE_METHODS.has(method.toUpperCase())) return null;
  let error: unknown;
  try {
    const body = await response.clone().json() as { error?: unknown };
    error = body.error;
  } catch {
    return null;
  }
  if (error !== "insufficient_scope") return null;
  const pathname = new URL(path, "https://gateway.invalid").pathname;
  if (/^\/api\/(escrow|fiat-ramp|settlement)(\/|$)/.test(pathname)) return FUNDS_NOTICE;
  if (method.toUpperCase() === "POST" && pathname === "/api/contributors/schedules") return CONTRIBUTOR_NOTICE;
  return null;
}
