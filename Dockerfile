# Single-stage build -- pnpm symlinks preserved, simpler for demo deploy
FROM node:22-slim

RUN corepack enable && corepack prepare pnpm@9 --activate

# better-sqlite3 needs python3 + build tools for native compilation
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests first for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/spec/package.json packages/spec/
COPY packages/kernel/package.json packages/kernel/
COPY packages/contracts/package.json packages/contracts/
COPY packages/scheduler/package.json packages/scheduler/
COPY packages/verifier/package.json packages/verifier/
COPY packages/payments/package.json packages/payments/
COPY packages/contract-builder/package.json packages/contract-builder/
COPY packages/orchestrator/package.json packages/orchestrator/
COPY packages/a2a/package.json packages/a2a/
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY packages/agent-user/package.json packages/agent-user/
COPY packages/agent-broker/package.json packages/agent-broker/
COPY packages/agent-kernel/package.json packages/agent-kernel/
COPY packages/gateway/package.json packages/gateway/
COPY packages/ui/package.json packages/ui/
COPY packages/db/package.json packages/db/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/agent-evaluator/package.json packages/agent-evaluator/
COPY packages/agent-support/package.json packages/agent-support/
COPY packages/onboard-kit/package.json packages/onboard-kit/
COPY packages/identity-8004/package.json packages/identity-8004/
COPY packages/bundler/package.json packages/bundler/
COPY packages/dht/package.json packages/dht/
COPY packages/evidence-embeddings/package.json packages/evidence-embeddings/
COPY packages/touchstone/package.json packages/touchstone/
COPY packages/kernel-sdk/package.json packages/kernel-sdk/
COPY packages/workflow/package.json packages/workflow/
COPY packages/attestations/package.json packages/attestations/
# Workspace packages that were missing from the per-line COPY list — every
# new package needs a line here until we move to a glob/BuildKit pattern.
COPY packages/a2a-signing/package.json packages/a2a-signing/
COPY packages/adapter-pylabrobot/package.json packages/adapter-pylabrobot/
COPY packages/aggregator/package.json packages/aggregator/
COPY packages/bridge-directory/package.json packages/bridge-directory/
COPY packages/connectors-airbyte-bridge/package.json packages/connectors-airbyte-bridge/
COPY packages/connectors-csv/package.json packages/connectors-csv/
COPY packages/connectors-postgres/package.json packages/connectors-postgres/
COPY packages/connectors-salesforce/package.json packages/connectors-salesforce/
COPY packages/connectors-sap/package.json packages/connectors-sap/
COPY packages/connectors-sharepoint/package.json packages/connectors-sharepoint/
COPY packages/demand-intel/package.json packages/demand-intel/
COPY packages/demo-video/package.json packages/demo-video/
COPY packages/dht-core/package.json packages/dht-core/
COPY packages/federation/package.json packages/federation/
COPY packages/identity/package.json packages/identity/
COPY packages/intent-broker/package.json packages/intent-broker/
COPY packages/intent-collector/package.json packages/intent-collector/
COPY packages/intent-otel-exporter/package.json packages/intent-otel-exporter/
COPY packages/subgraph/package.json packages/subgraph/
COPY packages/tool-index/package.json packages/tool-index/
COPY packages/trilobio/package.json packages/trilobio/
COPY packages/pcc-node/pyproject.toml packages/pcc-node/
# Wave 2.5 SDK + first templates (don't rely on `COPY . .` fallback for these)
COPY packages/orchestrator-sdk/package.json packages/orchestrator-sdk/
COPY packages/agent-onboarder/package.json packages/agent-onboarder/
COPY packages/template-data-product/package.json packages/template-data-product/
# Full workspace coverage — every package.json must be present at install time,
# or pnpm never links that package's deps and the in-image turbo build fails on
# unresolved imports (kernel-sdk 2d9b4b6, then bridge-directory/zod broke every
# master image build since #64).
COPY packages/a2a-signing/package.json packages/a2a-signing/
COPY packages/adapter-pylabrobot/package.json packages/adapter-pylabrobot/
COPY packages/aggregator/package.json packages/aggregator/
COPY packages/bridge-directory/package.json packages/bridge-directory/
COPY packages/connectors-airbyte-bridge/package.json packages/connectors-airbyte-bridge/
COPY packages/connectors-csv/package.json packages/connectors-csv/
COPY packages/connectors-postgres/package.json packages/connectors-postgres/
COPY packages/connectors-salesforce/package.json packages/connectors-salesforce/
COPY packages/connectors-sap/package.json packages/connectors-sap/
COPY packages/connectors-sharepoint/package.json packages/connectors-sharepoint/
COPY packages/demand-intel/package.json packages/demand-intel/
COPY packages/demo-video/package.json packages/demo-video/
COPY packages/dht-core/package.json packages/dht-core/
COPY packages/federation/package.json packages/federation/
COPY packages/identity/package.json packages/identity/
COPY packages/intent-broker/package.json packages/intent-broker/
COPY packages/intent-collector/package.json packages/intent-collector/
COPY packages/intent-otel-exporter/package.json packages/intent-otel-exporter/
COPY packages/subgraph/package.json packages/subgraph/
COPY packages/tool-index/package.json packages/tool-index/
COPY packages/trilobio/package.json packages/trilobio/
COPY apps/dashboard/package.json apps/dashboard/

# Cache-bust: change this value to force pnpm install to re-run
ARG CACHE_BUST=5
RUN pnpm install --frozen-lockfile

# Verify correct @fastify/static version installed (must be 8.x for Fastify 4)
RUN cd packages/gateway && node -e "const v = require('@fastify/static/package.json').version; console.log('@fastify/static version:', v); if (v.startsWith('9.')) { console.error('ERROR: @fastify/static v9 requires Fastify 5!'); process.exit(1); }"

# Copy all source and build
COPY . .
ARG BUILD_BUST=7
ENV NODE_OPTIONS="--max-old-space-size=4096"
# Build all packages except dashboard and mcp-server (tsc only — turbo handles deps)
RUN rm -rf .turbo node_modules/.cache && npx turbo build --force --filter='!@pcc/dashboard' --filter='!@pcc/mcp-server' --filter='!@pcc/onboard-kit' --filter='!@pcc/onboard' --concurrency=1
# Build dashboard with vite only (skip tsc -b which OOMs on large workspace)
RUN cd apps/dashboard && npx vite build

# Verify the build artifacts exist and the full import chain works
RUN ls -la packages/gateway/dist/server.js && echo "[docker] gateway build output OK"
# Test that better-sqlite3 native module loads from within the @pcc/store context
RUN cd packages/db && node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close(); console.log('[docker] better-sqlite3 native module OK')"

# ── Security Hardening ────────────────────────────────────────────────────────

# Remove build tools from production image (reduces attack surface).
# Install gosu so the entrypoint can drop privileges to `pcc` after fixing volume ownership.
RUN apt-get update && apt-get install -y --no-install-recommends gosu && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --system --gid 1001 pcc && useradd --system --uid 1001 --gid pcc pcc

# Create data directory with correct ownership (build-time; re-applied at runtime by the entrypoint)
RUN mkdir -p /app/data && chown -R pcc:pcc /app/data

# NOTE: intentionally NOT `USER pcc` here. A Railway persistent volume mounts at
# /app/data ROOT-OWNED, which masks the build-time chown above. The entrypoint
# below starts as root, re-chowns /app/data AFTER the volume mounts, then drops
# to the non-root `pcc` user via gosu so the gateway can open its SQLite DBs.

EXPOSE 3200

ENV NODE_ENV=production
ENV PCC_NETWORK=base-sepolia
ENV PCC_DB_PATH=/app/data/pcc.sqlite
ENV SERVE_DASHBOARD=true
ENV DASHBOARD_PATH=/app/apps/dashboard/dist

# As root: ensure the (possibly volume-mounted) /app/data is writable by pcc, then drop to pcc.
ENTRYPOINT ["/bin/sh", "-c", "if [ \"$(id -u)\" = \"0\" ]; then mkdir -p /app/data && chown -R pcc:pcc /app/data && exec gosu pcc \"$@\"; fi; exec \"$@\"", "--"]
CMD ["node", "packages/gateway/dist/server.js"]
