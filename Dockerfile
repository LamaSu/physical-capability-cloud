# Multi-stage build for PCC Gateway
FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json ./
COPY packages/spec/package.json packages/spec/
COPY packages/kernel/package.json packages/kernel/
COPY packages/contracts/package.json packages/contracts/
COPY packages/scheduler/package.json packages/scheduler/
COPY packages/verifier/package.json packages/verifier/
COPY packages/payments/package.json packages/payments/
COPY packages/contract-builder/package.json packages/contract-builder/
COPY packages/a2a/package.json packages/a2a/
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY packages/agent-user/package.json packages/agent-user/
COPY packages/agent-broker/package.json packages/agent-broker/
COPY packages/agent-kernel/package.json packages/agent-kernel/
COPY packages/gateway/package.json packages/gateway/
RUN pnpm install --frozen-lockfile

# Build
FROM deps AS build
COPY . .
RUN pnpm build

# Production image — gateway only
FROM node:22-slim AS production
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-workspace.yaml ./

EXPOSE 3200

ENV NODE_ENV=production
ENV PCC_NETWORK=base-sepolia

CMD ["node", "packages/gateway/dist/server.js"]
