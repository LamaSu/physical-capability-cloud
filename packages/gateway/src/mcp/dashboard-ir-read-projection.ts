/**
 * Server-side IR read projection (row 37; astra #562 r1 F1). When the gateway lets an unknown
 * origin read a closed-IR route (the credential-less CORS wildcard, middleware/security-hardening.ts),
 * the response is THIS projection, never the raw body: only the fields the closed IR reads.
 *
 * The raw anonymous bodies carry fields the IR never shows: operator addresses, precise locations
 * and physical addresses. Client-side filtering is not a confidentiality boundary, so the server
 * drops them before any cross-origin script can see them.
 *
 * Server-only: the browser kit never imports this module.
 */
import { irReadShape } from "./dashboard-ir.js";
import { SCHEMA_FIELDS } from "./dashboard-ir-renderer.js";

const PROTO_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isPrimitive = (v: unknown): boolean => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
/** Only a primitive, or an array of primitives, is ever copied. An OBJECT leaf could carry fields
 *  the IR never reads, so it is dropped whole. */
const isLeaf = (v: unknown): boolean => isPrimitive(v) || (Array.isArray(v) && v.every(isPrimitive));

/** Copy ONE dotted path of OWN properties from `src` to `dst` when its leaf is a primitive (or an
 *  array of primitives). A missing, inherited, prototype-key or object-valued path copies nothing. */
function copyPath(src: Record<string, unknown>, dst: Record<string, unknown>, path: string): void {
  const segs = path.split(".");
  let cur: unknown = src;
  for (const seg of segs) {
    if (PROTO_KEYS.has(seg) || !isPlain(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return;
    cur = cur[seg];
  }
  if (!isLeaf(cur)) return;
  let d = dst;
  for (const seg of segs.slice(0, -1)) {
    if (!isPlain(d[seg])) d[seg] = {};
    d = d[seg] as Record<string, unknown>;
  }
  d[segs[segs.length - 1]!] = Array.isArray(cur) ? [...cur] : cur;
}

/** The projection of a bindable route's response body: only the fields the closed IR reads.
 *  An unknown path or a non-object body gives {}, which the IR view renders as unavailable. A
 *  non-array rows value is dropped the same way ("unexpected response shape"), and so is a
 *  non-object row (the row has no title, so the collection is partial). */
export function projectIrRead(path: string, body: unknown): Record<string, unknown> {
  const shape = irReadShape(path);
  if (!shape || !isPlain(body)) return {};
  const fields = new Set(shape.fields);
  for (const schema of shape.schemas) {
    for (const f of SCHEMA_FIELDS[schema].fields) for (const k of Array.isArray(f.key) ? f.key : [f.key as string]) fields.add(k);
  }
  const out: Record<string, unknown> = {};
  for (const f of fields) copyPath(body, out, f);
  if (shape.rowsKey !== null && Object.prototype.hasOwnProperty.call(body, shape.rowsKey)) {
    const rows = body[shape.rowsKey];
    if (Array.isArray(rows)) {
      out[shape.rowsKey] = rows.map((r) => {
        const o: Record<string, unknown> = {};
        if (isPlain(r)) for (const f of shape.rowFields) copyPath(r, o, f);
        return o;
      });
    }
  }
  return out;
}
