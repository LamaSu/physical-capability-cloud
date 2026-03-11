# Multi-stage build for PCC — Gateway + Dashboard
FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

# Install dependencies (layer cached by package.json changes only)
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY tsconfig.base.json ./
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

# Build everything (sequential to avoid OOM)
FROM deps AS build
COPY . .
RUN pnpm build --concurrency=1

# Production image
FROM node:22-slim AS production
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

# Copy entire workspace (node_modules + built dist)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-workspace.yaml ./
COPY --from=build /app/pnpm-lock.yaml ./

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 3200

ENV NODE_ENV=production
ENV PCC_NETWORK=base-sepolia
ENV PCC_DB_PATH=/app/data/pcc.sqlite
ENV SERVE_DASHBOARD=true
ENV DASHBOARD_PATH=/app/apps/dashboard/dist

CMD ["node", "packages/gateway/dist/server.js"]
