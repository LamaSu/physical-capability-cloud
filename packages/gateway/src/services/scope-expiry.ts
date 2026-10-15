/**
 * An execution scope's expiry, in epoch ms, read fail-closed (board N133 follow-up).
 *
 * expires_at is TEXT NOT NULL and every writer stores Date#toISOString(), so a well-formed row
 * parses. One that does not (an empty or garbled string, epoch milliseconds stored as text: a hand
 * edit, a restore, another writer) read as never expiring: `new Date(x) < new Date()` is false when
 * x does not parse, so the relay admitted, dispatched and started writes under such a scope, its
 * read reported it active, and the operator's accept route accepted it. Here an expiry that does
 * not parse reads as long past, so each caller's own comparison with now (`<`, `<=`) refuses it, as
 * an unreadable claim time is a stale claim (POST /api/relay/:kernelId/tool-call/:callId/start).
 * Anything that parses is read exactly as `new Date(x)` reads it.
 */
export function scopeExpiryMs(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime();
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}
