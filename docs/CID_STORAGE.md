# CID Blob Storage

Generic content-addressable storage for binary artifacts.

This is a **substrate primitive**: 6 of the 15 PCC capability categories cannot
ship without a way to store, retrieve, and reference arbitrary binary files:

| Category | Examples of artifacts |
|----------|-----------------------|
| C.4 manufacturing | STL files, gcode, photo evidence of finished parts |
| C.5 lab | raw instrument output (`.d` files, chromatograms, mass-spec dumps) |
| C.10 brokerage | booking confirmations, agency-side receipts |
| C.14 sensory | drone imagery (GB-scale), raw sensor data |
| C.15 creative | portfolio samples, WIP files, final deliverables, rights-transfer docs |
| cross-cutting | photo evidence used by ANY category for verification |

The gateway does **not interpret** these files. It stores them addressable by
CID, retrieves them on demand, and lets downstream consumers (e.g. the
`@pcc/evidence-judge` VLM) do interpretation.

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/storage` | Upload raw bytes. Body is the file. Returns CID + metadata. |
| GET | `/api/storage/:cid` | Retrieve bytes. Supports `Range: bytes=N-M`. |
| GET | `/api/storage/:cid/meta` | Metadata only. No bytes returned. |
| DELETE | `/api/storage/:cid` | Owner-only soft-delete. Sets `deleted_at`. |

### POST `/api/storage`

Upload raw binary in the request body. Content-Type is the declared media type
(auto-detected from magic bytes if you send `application/octet-stream`).

Optional query parameters:
- `label` — human-readable label (e.g. "production-photo-batch-42")
- `category` — categorical tag (manufacturing | lab | brokerage | sensory | creative | other)
- `related_offer_id` — link to an offer/job for public-read gating
- `public` — if `true` AND `related_offer_id` is set, the blob is readable
  without auth via `?public=true` (intended for VLM evidence fetch on
  publicly-discoverable offers)

```bash
# Upload a photo
curl -X POST https://capability.network/api/storage \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: image/jpeg" \
  --data-binary @part-photo.jpg \
  -G --data-urlencode "label=mk4-part-001" \
     --data-urlencode "category=manufacturing"
```

Response 201:
```json
{
  "cid": "bafkreig...",
  "size_bytes": 124388,
  "media_type": "image/jpeg",
  "backend": "local",
  "stored_at_iso": "2026-06-19T17:00:00.000Z",
  "label": "mk4-part-001",
  "category": "manufacturing",
  "related_offer_id": null,
  "public_read": false,
  "idempotent": false
}
```

Re-uploading the same bytes returns 200 (not 201) with `idempotent: true` — no
double-store happens.

### GET `/api/storage/:cid`

Auth-gated by default. Returns the raw bytes with the original `Content-Type`.

```bash
# Fetch a blob
curl -H "Authorization: Bearer $PCC_KEY" \
  https://capability.network/api/storage/bafkreig... \
  -o part-photo.jpg

# Range request (first 1KB)
curl -H "Authorization: Bearer $PCC_KEY" \
  -H "Range: bytes=0-1023" \
  https://capability.network/api/storage/bafkreig...
```

Returns:
- 200 + bytes — full retrieval
- 206 + bytes + `Content-Range` — partial retrieval via Range
- 404 — CID syntactically valid but unknown
- 400 — CID syntactically malformed
- 410 — CID was soft-deleted
- 401 — auth required and missing

### GET `/api/storage/:cid/meta`

Metadata only. Same auth gating as the byte retrieval.

```json
{
  "cid": "bafkreig...",
  "size_bytes": 124388,
  "media_type": "image/jpeg",
  "backend": "local",
  "stored_at_iso": "2026-06-19T17:00:00.000Z",
  "label": "mk4-part-001",
  "category": "manufacturing",
  "related_offer_id": null,
  "public_read": false
}
```

### DELETE `/api/storage/:cid`

Owner-only. Soft-deletes by setting `deleted_at`. The blob bytes are NOT removed
from the backend — hard delete is a separate ops job (see "Operations" below).

Subsequent GET returns 410 Gone. A re-upload of the same content will revive
the row (delete the tombstone, write a fresh row).

## CID Format

CIDv1 with:
- **codec**: `raw` (0x55) — bytes are stored as-is, not wrapped in dag-pb
- **multihash**: SHA-256 (0x12)
- **encoding**: base32 (default for CIDv1)

This format is deterministic — the same input bytes always produce the same
CID — and matches what Storacha emits for raw uploads, so the same CID works
against any of the three backends.

## Backend support matrix

Selected by the `EVIDENCE_STORAGE` env var (shared with evidence bundles so
operators only configure storage once).

| Backend | When to use | Operational notes |
|---------|-------------|-------------------|
| `local` (default) | Single-host gateway, dev, small ops | Writes to `<PCC_BLOB_DIR>` (default `./data/blobs`), sharded by first 2 chars of CID. No external dependencies. |
| `helia` | Self-hosted IPFS, multi-host | In-process Helia node. Pin-on-write. Be aware of disk growth — Helia caches everything. |
| `storacha` | Production, archival, durability | v0.1 ships mock-only — sees the right CID + returns it but only persists in-memory. Production wiring (real w3up uploads) is a follow-up; see "Follow-ups" below. |

If the chosen backend fails to initialize at startup (e.g. Helia can't open
its peer-id store), we **fall back to local** and log a warning. There is no
silent data loss — the CID returned to a client is always backed by SOMETHING
on disk or in the configured backend.

## Auth model

| Operation | Default | Override |
|-----------|---------|----------|
| POST | Bearer required | none |
| GET bytes | Bearer required | `public_read: true` + `related_offer_id` + `?public=true` query — unauth read OK |
| GET meta | Bearer required | same as bytes |
| DELETE | Bearer + owner match | none — non-owner always 403 |

The public-read carve-out exists so the `@pcc/evidence-judge` VLM can fetch
evidence linked to publicly-discoverable offers without holding a session
token. The uploader chooses at upload time by passing `?public=true&related_offer_id=...`.

## Max upload size

`STORAGE_MAX_UPLOAD_MB` env var, default **100 MB** per request. For larger
files use chunked upload (TODO follow-up) or split client-side and upload as
multiple CIDs.

The gateway buffers the request body in memory before computing the CID — for
the v0.1 100MB cap that's acceptable. A streaming path (Helia's
`unixfs.addFile()`) is required for >100MB and is a follow-up.

## Idempotency

The CID is derived purely from content bytes. Re-uploading identical content:
1. Computes the same CID locally on the gateway
2. Finds the existing `storage_blobs` row
3. Returns the existing row's metadata + `idempotent: true` (200)
4. Does NOT rewrite the backend, does NOT insert a new DB row

This means a client can safely retry an upload after a network failure — the
gateway will not duplicate.

## Worked examples per category

### C.4 manufacturing — production photo

Operator finishes a 3D print, takes a photo as evidence:

```bash
curl -X POST https://capability.network/api/storage \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: image/jpeg" \
  --data-binary @print-001.jpg \
  -G --data-urlencode "label=print-job-12345-final-shot" \
     --data-urlencode "category=manufacturing" \
     --data-urlencode "related_offer_id=offer-12345" \
     --data-urlencode "public=true"
# → { cid: "bafkreig...", ... }

# Later: evidence-judge VLM verifies the photo
curl https://capability.network/api/storage/bafkreig.../meta?public=true
```

### C.5 lab — raw instrument output

Lab operator uploads a 50MB raw HPLC `.d` file:

```bash
tar czf hplc-run-001.tar.gz hplc-run-001.d/
curl -X POST https://capability.network/api/storage \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/gzip" \
  --data-binary @hplc-run-001.tar.gz \
  -G --data-urlencode "label=hplc-run-001-raw" \
     --data-urlencode "category=lab"
# → { cid: "bafkreig...", ... }
```

### C.15 creative — portfolio sample

Designer uploads a portfolio piece as part of an ad-hoc capability listing:

```bash
curl -X POST https://capability.network/api/storage \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/pdf" \
  --data-binary @brand-book-v1.pdf \
  -G --data-urlencode "label=ariel-brand-book-v1" \
     --data-urlencode "category=creative" \
     --data-urlencode "related_offer_id=offer-ariel-7" \
     --data-urlencode "public=true"
# → portfolio is publicly discoverable + downloadable on the offer detail page
```

### C.10 brokerage — booking confirmation

Brokerage adapter saves a third-party booking confirmation screenshot:

```bash
curl -X POST https://capability.network/api/storage \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: image/png" \
  --data-binary @booking-conf.png \
  -G --data-urlencode "category=brokerage" \
     --data-urlencode "related_offer_id=offer-9876"
```

### C.14 sensory — drone imagery slice

Drone operator uploads one frame from a survey run:

```bash
curl -X POST https://capability.network/api/storage \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: image/jpeg" \
  --data-binary @frame-00042.jpg \
  -G --data-urlencode "label=survey-mrm2-frame-42" \
     --data-urlencode "category=sensory"
```

## Integration with `@pcc/evidence-judge`

When the user-agent calls `judgeEvidence`, it can either:

1. **Pass artifact data directly** for small payloads (inline base64).
2. **Pass a URL reference** for blobs uploaded via this endpoint:

```typescript
const verdict = await evidenceJudge.judgeEvidence({
  kind: "image",
  data: {
    url: `https://capability.network/api/storage/${cid}?public=true`,
  },
});
```

The VLM fetches the URL, the gateway streams the bytes back (subject to the
public-read gate), and the judgment proceeds without the user-agent having to
re-base64 the file.

## Database schema

Table `storage_blobs` (declared in `packages/db/src/migrate.ts`):

| Column | Type | Notes |
|--------|------|-------|
| `cid` | TEXT PRIMARY KEY | CIDv1 |
| `size_bytes` | INTEGER NOT NULL | Original byte length |
| `media_type` | TEXT NOT NULL | Final media type (detected or declared) |
| `backend` | TEXT NOT NULL | `local` \| `helia` \| `storacha` |
| `uploaded_by` | TEXT NOT NULL | Operator identifier (email / wallet) |
| `uploaded_by_agent_id` | TEXT | Optional agent identifier |
| `related_offer_id` | TEXT | Optional offer/job link for public-read gating |
| `label` | TEXT | Caller-supplied label |
| `category` | TEXT | Caller-supplied category tag |
| `public_read` | INTEGER | 0=auth required, 1=public read allowed |
| `created_at` | TEXT NOT NULL | ISO timestamp |
| `deleted_at` | TEXT | Soft-delete tombstone; NULL = active |

Indices: `uploaded_by`, `related_offer_id`, `category`, `created_at`.

## Operations

### Monitoring storage growth

```bash
# Total bytes stored (active blobs only)
sqlite3 data/pcc.sqlite \
  "SELECT SUM(size_bytes) FROM storage_blobs WHERE deleted_at IS NULL"

# Top 10 uploaders
sqlite3 data/pcc.sqlite \
  "SELECT uploaded_by, COUNT(*), SUM(size_bytes) FROM storage_blobs
   WHERE deleted_at IS NULL GROUP BY uploaded_by
   ORDER BY 3 DESC LIMIT 10"
```

### Hard delete (ops job)

Soft-deletes accumulate. A periodic job should hard-delete blobs whose
`deleted_at` is older than the retention window (e.g. 30 days):

```bash
# Pseudocode — implement as a scheduled job
SELECT cid FROM storage_blobs
  WHERE deleted_at IS NOT NULL
    AND deleted_at < datetime('now', '-30 days');

# For each CID: remove from backend, then DELETE FROM storage_blobs
```

### Backup strategy

- **Local backend**: rsync `<PCC_BLOB_DIR>` to off-host storage on a cron.
  Restore by rsyncing back — CIDs are content-addressed so the index always
  matches.
- **Helia backend**: pin to a remote Helia node OR use a periodic
  `helia-export` of the blockstore.
- **Storacha backend**: bytes are durable by construction — w3up replicates
  to Filecoin via the Storacha network.

### Restoring after disk loss

If the `storage_blobs` table is intact but `<PCC_BLOB_DIR>` is gone:
1. Restore the dir from backup.
2. Or: re-upload from original sources — same content → same CID → existing
   table rows match.

If the table is gone but the dir is intact: write a one-shot script that
walks `<PCC_BLOB_DIR>`, computes CID for each file, and re-inserts rows.
Upload metadata (uploader, label, category, etc.) is lost — only the CID +
bytes remain.

## Env vars

| Var | Default | Notes |
|-----|---------|-------|
| `EVIDENCE_STORAGE` | `local` | `local` \| `helia` \| `storacha` |
| `PCC_BLOB_DIR` | `./data/blobs` | Local backend root |
| `STORAGE_MAX_UPLOAD_MB` | `100` | Per-request cap |
| `STORACHA_PROOF` | none | Required for non-mock Storacha (currently mock-only — see follow-ups) |

## Why this is distinct from evidence storage

The existing `EvidenceStorageService` in `@pcc/kernel` is tightly coupled to
the ALCOA+ `EvidenceBundle` schema — it stores bundles with `jobId`, `stepId`,
`kernelId`, `assuranceTier`, ALCOA+ metadata, etc. That coupling is correct
for evidence bundles but wrong for generic binary storage.

Generic blobs need:
- Streaming uploads + range retrieval
- Idempotency by content hash, not bundle ID
- Media-type detection from magic bytes
- Operator-set category + label
- Optional public-read gating for cross-cutting consumers (VLMs)

This service is **alongside** `EvidenceStorageService`, not a replacement.
Both share the same backends (Helia/Storacha) under the hood, but expose
different surfaces.

## Follow-ups (out of scope for v0.1)

- **Real Storacha raw-byte upload** — current `StorachaBlobBackend` is mock-only. Production wiring goes through `@pcc/kernel`'s w3up client with an `uploadBytes()` extension.
- **Chunked uploads >100MB** — for drone-imagery and large lab files. Resumable upload + Helia's `unixfs.addFile()` streaming.
- **Signed pre-shared URLs** — for time-limited public access without an offer link.
- **CDN integration** — Cloudflare/Vercel edge cache for hot CIDs.
- **Replication policy** — automatic mirror to Helia + Storacha for ALCOA+ Enduring blobs that originated as local uploads.
- **Backup automation** — scheduled rsync / ipfs-export.
- **Hard-delete cron** — purge `deleted_at` rows older than retention.

## File layout

- `packages/gateway/src/services/cid-blob-storage.ts` — backends + factory
- `packages/gateway/src/routes/storage.ts` — HTTP routes
- `packages/gateway/src/__tests__/cid-storage.test.ts` — tests
- `packages/db/src/migrate.ts` — `storage_blobs` table DDL
