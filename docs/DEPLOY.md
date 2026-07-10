# Deploy Pipeline — Build-Once, Deploy-Many

PCC uses an artifact-promotion model: every merge to `master` produces **one** Docker image that is then retagged through `staging` → `prod` without rebuilding. Deploy time drops from ~10 min (rebuild-per-env) to seconds (manifest retag).

## Contract source-vs-deployed divergence — V3 Mode-A (2026-07-09)

`approveAndRelease` (V3 Mode-A: the oracle-free, fee-free payer-approval release) and its `PayerApprovedRelease` event were **removed from the contract source** (`packages/contracts/src/MilestoneEscrowV3.sol`, plus its V3 test coverage) on 2026-07-09, per the standing settlement directive — everything settles through the oracle; income is oracle-attested Mode-B only (see `ai/research/pcc-wiki/settlement-decisions.md` D1–D3).

**The deployed bytecode is unchanged.** The live prod V3 factory `0x786E85B17B288115E2F9230868e0BC94cBff5534` and every clone it has already minted **STILL carry `approveAndRelease`** — deployed bytecode is immutable. Mode-A is therefore **not on-chain-impossible** until the **O5 redeploy** ships a new `PCCProtocolV3` factory built from the trimmed source and new escrows are cut over to it. Until then the Mode-A rejection is enforced off-chain only (the gateway call path was removed in #194), not by the bytecode.

Implications:
- Do **not** assume the live factory lacks Mode-A because the source does. Verify the live surface with `cast` before asserting.
- `packages/contracts/ts/abi/MilestoneEscrowV3.ts` deliberately RETAINS the `approveAndRelease` / `PayerApprovedRelease` ABI members so the gateway can still encode/decode against the live contract. Regenerate it without them only after the O5 redeploy.
- O5 redeploy = deploy a fresh `PCCProtocolV3` factory from current source, then cut new escrows over to it. The old factory and its clones stay on-chain (no upgrade/destroy mechanism, same as the V2 rollback note in `docs/V2_DEPLOY.md`) but should no longer be used.

## Rollout Progress (as of 2026-04-15)

The pipeline is **wired but not yet running end-to-end**. Remaining steps, in order:

- [x] PR #1 merged (2026-04-15) — workflow files + release-please config + docs + CLAUDE.md rules on master.
- [x] GitHub environments `staging` + `production` created (no protection rules; manual workflow_dispatch is the prod gate).
- [x] Railway `staging` environment duplicated from `production` (still Dockerfile source; secrets cloned from prod).
- [x] Lockfile sync (`fix(deps):` commit `e8c664a`) — unblocked `pnpm install --frozen-lockfile`.
- [x] Dockerfile: COPY kernel-sdk/package.json (commit `2d9b4b6`) — unblocked `turbo build` of kernel-sdk inside the image.
- [x] GHCR lowercase image refs in retag steps (commit `97c489f`) — Docker image names must be lowercase; `${{ github.repository }}` returns `LamaSu/...`.
- [x] Full-SHA tag format via `format=long` (commit `0e59f16`) — aligned `docker/metadata-action` (was short SHA) with `${{ github.sha }}` (full SHA) so the retag source is findable.
- [x] **First green CI run** on master (`0e59f16`, run `24445868832`) — all 4 jobs success. `ghcr.io/lamasu/physical-capability-cloud:<full-sha>`, `:latest`, and `:staging` tags now exist on GHCR.
- [ ] **Swap Railway `staging` source** from Dockerfile → Docker Image. **CLI does NOT work on existing envs** — `railway environment edit --service-config pcc-gateway source.image ...` silently no-ops when `source.repo`/`source.branch` are already set (tried dot-path, JSON-object, empty-string-then-set — all ignored). Do it in the Railway UI: project `diplomatic-compassion` → environment `staging` → service `pcc-gateway` → Settings → Source → switch to "Docker Image" → `ghcr.io/lamasu/physical-capability-cloud:staging` → enable "Redeploy on image change" → Save. Confirm staging boots via its `*.up.railway.app` URL.
- [ ] Run the **Deploy to Prod** workflow manually (GitHub → Actions → Deploy to Prod → Run workflow → paste master SHA — **full 40-char SHA**, not short). Confirms `:prod` tag is produced and `capability.network/api/health` still returns 200.
- [ ] Swap Railway `production` service source Dockerfile → Docker Image `ghcr.io/lamasu/physical-capability-cloud:prod` via the Railway UI (same path as staging — CLI doesn't work here either). This is the "live" cutover; verify `capability.network` stays green.
- [ ] Delete stale Dockerfile builder config from Railway once GHCR-pull is proven stable (leave `railway.toml` as-is — Railway ignores it when service source is Image).

### Nice-to-haves (not blocking)

- [ ] Rotate `staging` secrets so the env has its own DEPLOYER_PRIVATE_KEY, LIT_API_KEY, Storacha token, etc. — the Railway duplicate cloned prod secrets. Low urgency on Sepolia testnet, but do this before staging hits a public URL anyone else consumes.
- [ ] Set repo variable `STAGING_URL=<staging-railway-url>` → enables the `deploy-staging` smoke check step that's currently skipped.
- [ ] Bump `actions/checkout@v4` / `actions/setup-node@v4` / `pnpm/action-setup@v4` to v5 once those exist (GitHub Actions annotation warned Node 20 runners are deprecated June 2026).
- [ ] If a reviewer-gated environment becomes worth $4/mo: upgrade to GH Pro, add required-reviewer rule to `production`, move `deploy-prod` job back into `ci.yml` with `environment: production`.
- [ ] First merged feature/fix commit on master after lockfile is green → verify release-please opens a "chore: release 0.1.0" PR with auto-generated CHANGELOG.

### Pending follow-ups (block consumer adoption)

- [ ] **Configure Railway volume + `WORKFLOW_DB_PATH` before any consumer of `@pcc/workflow` ships.** The new `@pcc/workflow` package (branch `feat/workflow-runtime`) writes to a SQLite file. Railway's default filesystem is ephemeral — every redeploy wipes it and we lose in-flight workflow state, idempotency dedup, and the ALCOA+ audit log. Mount a volume at `/app/data` (or wherever you choose) on `pcc-gateway` in **both** `staging` and `production` environments, then set `WORKFLOW_DB_PATH=/app/data/workflow.sqlite` alongside the existing `PCC_DB_PATH`. Until this is done, do NOT merge the Phase 1 escrow-as-Activity migration PR — it will work locally and silently lose data on Railway. See `docs/WORKFLOW_RUNTIME.md` §5.1 for the rationale.

## Pipeline at a glance

```
merge to master
    │
    ▼
┌───────────────┐   docker/build-push-action
│  build-image  │   ───► ghcr.io/lamasu/pcc:<sha>, :latest
└───────┬───────┘       (ONE build, ONE push)
        │
        ▼
┌──────────────────┐   buildx imagetools create
│  deploy-staging  │   ───► retag <sha> → :staging
│  [env: staging]  │        Railway(staging) pulls :staging, redeploys
│  smoke /health   │        curl loop up to 3 min
└────────┬─────────┘
         │
         ▼  ┌─── Manual gate (reel 2: "continuous delivery") ───┐
         │  │  Run the "Deploy to Prod" workflow from Actions  │
         │  │  and pass the SHA. Clicking "Run" IS the gate.    │
         │  └────────────────────────────────────────────────────┘
         ▼
┌──────────────────┐   buildx imagetools create
│  deploy-prod     │   ───► retag <sha> → :prod
│  [workflow_      │        Railway(prod) pulls :prod, redeploys
│   dispatch]      │        https://capability.network/api/health
└──────────────────┘
```

The **same Docker manifest** flows through every stage. `:sha`, `:staging`, and `:prod` are aliases for the same underlying layers — no rebuild, no drift between environments.

## Semver + CHANGELOG automation

`release-please` watches Conventional Commits on `master` and maintains a rolling release PR. Merging it:

1. Bumps the version in `package.json` and `.release-please-manifest.json`
2. Generates/updates `CHANGELOG.md` from commit messages (`feat:`, `fix:`, etc.)
3. Creates a GitHub release + `vX.Y.Z` git tag
4. A follow-up job retags `ghcr.io/lamasu/pcc:<sha>` → `ghcr.io/lamasu/pcc:vX.Y.Z`

Your commits should follow Conventional Commits (`feat:`, `fix:`, `feat(scope)!:`, etc.) for release-please to classify them correctly.

## One-time setup (required before this pipeline works)

### 1. GitHub environments & manual prod trigger

`staging` environment: already created (no protection rules needed). Add a repo variable `STAGING_URL` (e.g. `https://pcc-gateway-staging.up.railway.app`) if you want the staging smoke test to run; omit it to skip the smoke check.

`production` environment: exists for audit/activity logging only. **GitHub Free on private repos cannot enforce required-reviewer rules**, so prod promotion runs as a separate manual-dispatch workflow (`Deploy to Prod`) instead. The "Run workflow" click IS the gate.

To promote a build to prod:
1. Find the SHA you want to promote in the staging deploy run (it's the commit SHA of the master push).
2. GitHub → Actions → **Deploy to Prod** → **Run workflow** → paste the SHA → **Run**.
3. The workflow verifies the image exists, retags it as `:prod`, and smoke-tests `https://capability.network/api/health`.

If you upgrade to GitHub Pro ($4/mo) later, you can add a required-reviewer rule to the `production` environment and move the deploy-prod job back into `ci.yml` as an automatic push-to-master job — the Dockerfile/YAML is ready for that switch.

### 2. Railway services

In the Railway project for `pcc-gateway`:

1. **Change the production service's source** from `Dockerfile` to `Docker Image`:
   - Image: `ghcr.io/lamasu/physical-capability-cloud:prod`
   - Enable "Redeploy on image change" (Railway watches the manifest digest).
2. **Duplicate the production service** into a new **staging** environment:
   - Image: `ghcr.io/lamasu/physical-capability-cloud:staging`
   - Copy env vars (swap any prod-only secrets for test values).
   - Attach a staging-only domain (Railway provides `*.up.railway.app` by default).

### 3. GHCR pull access

If the image is **private**, Railway needs a Personal Access Token with `read:packages`. Add it as a registry credential in Railway. If the image is **public** (typical for open-source projects), no credential is needed.

### 4. Remove `railway.toml` DOCKERFILE builder

Once Railway is pulling from GHCR, `railway.toml` is no longer the build source. You can delete the `[build]` section or leave it — Railway ignores it when the service is set to `Docker Image` source.

## Rollback

Rollback is retagging:

```bash
# Find the previous good SHA
gh run list --workflow=ci.yml --branch=master --limit=5

# Retag any prior SHA as :prod
docker buildx imagetools create \
  --tag ghcr.io/lamasu/physical-capability-cloud:prod \
  ghcr.io/lamasu/physical-capability-cloud:<prev-sha>
```

Railway sees the manifest digest change and redeploys in seconds. No git revert, no rebuild.

## Workflow runtime SQLite path

The `@pcc/workflow` package (`packages/workflow/`, branch `feat/workflow-runtime`) embeds a SQLite-backed durable execution runtime inside the Fastify monolith. It writes idempotency rows, the ALCOA+ event log, step memoization cache, workflow run state, and data-port lineage to **one SQLite file**. The package itself reads no env vars — the consuming service decides where the file lives.

### Required env var (gateway)

`WORKFLOW_DB_PATH` — absolute path passed to `openSqliteStore({ path })` in `packages/gateway/src/bootstrap.ts` (or wherever the gateway constructs its store handle). Recommended default:

```
WORKFLOW_DB_PATH=/app/data/workflow.sqlite
```

Sit it alongside the existing `PCC_DB_PATH` so both DBs share the same persistent volume.

### Railway volume mount (REQUIRED before any `@pcc/workflow` consumer ships)

Railway's default filesystem is ephemeral — every redeploy mints a fresh container with an empty disk. If `WORKFLOW_DB_PATH` points anywhere outside a mounted volume:

- in-flight workflow runs are lost on every deploy,
- the idempotency dedup cache is wiped (operator retries can double-spend),
- the hash-chained ALCOA+ event log is lost (compliance evidence: gone).

**Required setup**, both `staging` and `production` services:

1. Railway UI → project `diplomatic-compassion` → environment `<env>` → service `pcc-gateway` → Settings → Volumes → **Add volume**.
2. Mount path: `/app/data` (or any path that does NOT collide with the build output).
3. Set env var `WORKFLOW_DB_PATH=/app/data/workflow.sqlite`.
4. Optionally set `PCC_DB_PATH=/app/data/pcc.sqlite` to share the same volume (no functional change to PCC's existing DB; just consolidates persistent state).
5. Redeploy — confirm the file appears via `railway run ls /app/data`.

**Until both Railway volumes are mounted, do NOT merge the Phase 1 escrow-as-Activity migration PR** (or any other PR that adds a consumer of `@pcc/workflow`). The package works locally with ephemeral disk, so the failure is silent — no log line, no error — and we'd lose every in-flight workflow on the next redeploy.

### Backup

Treat `workflow.sqlite` as production data:

```bash
# Hot backup (consistent with WAL mode, no process pause)
sqlite3 /app/data/workflow.sqlite ".backup '/tmp/workflow.sqlite.bak'"
```

Ship to S3/Storacha on a daily cron. Whole-file size stays under 100 MB even with months of history (typical PCC workload: 10k runs/month × ~15 events × ~1 KB ≈ 150 MB/month of `events` growth — see `docs/WORKFLOW_RUNTIME.md` §5.3).

### Reference

Full rationale, growth math, vacuum guidance, and recovery semantics: [`docs/WORKFLOW_RUNTIME.md`](./WORKFLOW_RUNTIME.md) §5 (Operational notes). Public API: [`packages/workflow/README.md`](../packages/workflow/README.md).

## What this does NOT yet include

- **Canary / weighted rollout** — would require Cloudflare Workers or a Railway replica layer to split traffic. Skipped until capability.network has enough traffic to warrant it.
- **Auto-rollback on error rate** — Sentry + Railway API could wire this up as a follow-up.
- **Multi-region** — single Railway region for now.
