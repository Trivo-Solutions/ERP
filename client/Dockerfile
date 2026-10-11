# --- build stage ---
FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json

RUN npm ci --workspace=client --include-workspace-root=false

COPY client ./client

# Build the counter-PC print agent into a standalone Windows .exe (bundles Node itself — no
# Node/npm prerequisite on the counter PC) and ship it as a browser download alongside the SPA,
# so store staff can get it from the ERP site itself instead of someone carrying a USB drive
# around. See printer-agent/README.md.
COPY printer-agent ./printer-agent
RUN apt-get update && apt-get install -y --no-install-recommends zip && rm -rf /var/lib/apt/lists/*
RUN npm --prefix printer-agent ci && npm --prefix printer-agent run package
RUN mkdir -p /tmp/printer-agent-download \
    && cp printer-agent/dist-exe/printer-agent.exe /tmp/printer-agent-download/ \
    && cp printer-agent/.env.example /tmp/printer-agent-download/ \
    && cp printer-agent/README.md /tmp/printer-agent-download/ \
    && mkdir -p client/public/downloads \
    && (cd /tmp/printer-agent-download && zip -r /app/client/public/downloads/printer-agent.zip .)

ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}

# Type-checking (tsc, incl. the vitest test files) runs in dev/CI; the image build only bundles, since vitest is a root devDependency this image does not install.
RUN npm exec --workspace=client -- vite build

# --- runtime stage ---
FROM nginx:1.27-alpine AS runtime
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/client/dist /usr/share/nginx/html
EXPOSE 80
