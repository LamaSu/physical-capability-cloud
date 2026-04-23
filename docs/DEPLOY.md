# PCC Deploy Pipeline — Build-Once, Deploy-Many

PCC uses GHCR artifact promotion. **One** Docker image per master push is retagged through staging → prod without rebuilding. Any agent or engineer touching `.github/workflows/`, `Dockerfile`, or `railway.toml` MUST follow these rules.

## The pipeline

- **CI** (`.github/workflows/ci.yml`): `build-and-test` → `forge-tests` → `build-image` (pushes `ghcr.io/lamasu/physical-capability-cloud:<sha>` and `:latest`) → `deploy-staging` (retags `:sha` → `:staging`, smoke-checks `${{ vars.STAGING_URL }}/api/health` if set).
- **Prod promotion** (`.github/workflows/deploy-prod.yml`): `workflow_dispatch` with a `sha` input. Clicking "Run workflow" IS the gate (GH Free on a private repo can't enforce required-reviewer rules). Verifies the source tag exists, retags `:sha` → `:prod`, smoke-checks `https://capability.network/api/health`.
- **Release** (`.github/workflows/release.yml`): `release-please` watches Conventional Commits on master, maintains a rolling release PR, cuts `vX.Y.Z` + CHANGELOG on merge, retags GHCR image with the semver tag.

## Railway mapping (Ryan's `diplomatic-compassion` project)

| Railway env | Source (target) | GHCR tag watched |
|---|---|---|
| `production` | `Docker Image` (once switched) | `ghcr.io/lamasu/physical-capability-cloud:prod` |
| `staging` | `Docker Image` (once switched) | `ghcr.io/lamasu/physical-capability-cloud:staging` |

Both envs currently still use the Dockerfile builder — they will be switched to image-pull only after the first CI run populates each tag.

## Rules when touching CI/CD or Dockerfile

1. **Never rebuild when you can retag.** `docker buildx imagetools create --tag <new> <source>` is a manifest-level operation. No layers re-uploaded, no drift between envs.
2. **Never swap a Railway service's image source** to a tag that doesn't exist yet. Verify with `docker buildx imagetools inspect ghcr.io/.../...:<tag>` first. If the tag is missing, the service crashes on next deploy.
3. **Rollback = retag, not revert.** `docker buildx imagetools create --tag ghcr.io/lamasu/physical-capability-cloud:prod ghcr.io/lamasu/physical-capability-cloud:<prev-sha>` and Railway picks up the digest change in seconds.
4. **Prod promotion is always manual.** Do NOT add an automatic `push-to-master` → `:prod` path to `ci.yml` unless (a) the repo has upgraded to GH Pro AND (b) the `production` environment has a required-reviewer rule configured.
5. **Version bumps go through release-please.** Do NOT edit `package.json` `version`, `CHANGELOG.md`, or `.release-please-manifest.json` by hand. Merge the release PR instead.
6. **Conventional Commits are required.** `feat:` / `fix:` / `perf:` / `deps:` / `revert:` / `docs:` / `refactor:` / `ci:` / `chore:` / `test:` / `build:`. Without this, release-please classifies commits incorrectly and CHANGELOG entries go missing.
7. **Dockerfile is transitional.** The long-term path is GHCR-only on Railway. If you edit the Dockerfile, verify the resulting image still boots under the `:staging` tag before anyone promotes it to `:prod`.
8. **Staging secrets are duplicated from prod.** When the staging env was created, Railway cloned prod variables (DEPLOYER_PRIVATE_KEY, LIT_API_KEY, etc.). Treat staging with the same secret-handling care as prod until secrets are rotated.

## History

Originally written as a block in `CLAUDE.md` (commit `5a1b3b5`, 2026-04-15). Moved to `docs/DEPLOY.md` during the public-vs-operator-rules split (2026-04-23), because the rules are for humans + agents working on CI/CD, not for external integrators calling the PCC API.
