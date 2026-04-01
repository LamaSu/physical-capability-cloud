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
COPY packages/pcc-node/pyproject.toml packages/pcc-node/
COPY apps/dashboard/package.json apps/dashboard/

# Cache-bust: change this value to force pnpm install to re-run
ARG CACHE_BUST=5
RUN pnpm install --frozen-lockfile

# Verify correct @fastify/static version installed (must be 8.x for Fastify 4)
RUN cd packages/gateway && node -e "const v = require('@fastify/static/package.json').version; console.log('@fastify/static version:', v); if (v.startsWith('9.')) { console.error('ERROR: @fastify/static v9 requires Fastify 5!'); process.exit(1); }"

# Copy all source and build
COPY . .
ARG BUILD_BUST=5
ENV NODE_OPTIONS="--max-old-space-size=4096"
# Build all packages except dashboard and mcp-server (tsc only — turbo handles deps)
RUN npx turbo build --force --filter='!@pcc/dashboard' --filter='!@pcc/mcp-server' --filter='!@pcc/onboard-kit' --concurrency=1
# Build dashboard with vite only (skip tsc -b which OOMs on large workspace)
RUN cd apps/dashboard && npx vite build

# Verify the build artifacts exist and the full import chain works
RUN ls -la packages/gateway/dist/server.js && echo "[docker] gateway build output OK"
# Test that better-sqlite3 native module loads from within the @pcc/store context
RUN cd packages/db && node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close(); console.log('[docker] better-sqlite3 native module OK')"

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 3200

ENV NODE_ENV=production
ENV PCC_NETWORK=base-sepolia
ENV PCC_DB_PATH=/app/data/pcc.sqlite
ENV SERVE_DASHBOARD=true
ENV DASHBOARD_PATH=/app/apps/dashboard/dist

CMD ["node", "packages/gateway/dist/server.js"]
