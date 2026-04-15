# Deploy Pipeline — Build-Once, Deploy-Many

PCC uses an artifact-promotion model: every merge to `master` produces **one** Docker image that is then retagged through `staging` → `prod` without rebuilding. Deploy time drops from ~10 min (rebuild-per-env) to seconds (manifest retag).

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

## What this does NOT yet include

- **Canary / weighted rollout** — would require Cloudflare Workers or a Railway replica layer to split traffic. Skipped until capability.network has enough traffic to warrant it.
- **Auto-rollback on error rate** — Sentry + Railway API could wire this up as a follow-up.
- **Multi-region** — single Railway region for now.
