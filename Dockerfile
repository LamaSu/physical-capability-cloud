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
COPY apps/dashboard/package.json apps/dashboard/

RUN pnpm install --frozen-lockfile

# Copy all source and build
COPY . .
RUN pnpm build --concurrency=1

# Verify the build output exists and better-sqlite3 native module loads
RUN node -e "require('better-sqlite3'); console.log('[docker] better-sqlite3 native module OK')"
RUN ls -la packages/gateway/dist/server.js && echo "[docker] gateway build output OK"

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 3200

ENV NODE_ENV=production
ENV PCC_NETWORK=base-sepolia
ENV PCC_DB_PATH=/app/data/pcc.sqlite
ENV SERVE_DASHBOARD=true
ENV DASHBOARD_PATH=/app/apps/dashboard/dist

CMD ["node", "packages/gateway/dist/server.js"]
