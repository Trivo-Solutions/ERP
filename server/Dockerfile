# --- deps + build stage ---
FROM node:20-bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Root workspace manifests first (npm workspaces monorepo)
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json

# Only need the server workspace's deps to build/run the server image
RUN npm ci --workspace=server --include-workspace-root=false

COPY server ./server
RUN npm run db:generate --workspace=server \
 && npm run build --workspace=server

# --- runtime stage ---
FROM node:20-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app

# npm workspaces hoists shared deps to the root node_modules (not server/node_modules) —
# copy it to the same relative location so Node's upward module resolution finds it.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/prisma ./server/prisma
COPY server/package.json ./server/package.json

WORKDIR /app/server
EXPOSE 3001

CMD ["node", "dist/index.js"]
