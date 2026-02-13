# Stage 1: Build everything
FROM node:20-slim AS builder

# Install build tools for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
COPY tools/package.json tools/

# Install all dependencies (including devDependencies for building)
RUN npm ci

# Copy source code
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
COPY client/ client/

# Build: shared -> server -> client (tools not needed for production)
RUN npm run build --workspace=shared && npm run build --workspace=server && npm run build --workspace=client

# Copy static files that TypeScript doesn't handle
RUN cp -r server/src/static server/dist/static

# Stage 2: Production runtime
FROM node:20-slim

# Install only what's needed for better-sqlite3 at runtime
RUN apt-get update && apt-get install -y libsqlite3-0 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files (all workspaces needed for npm ci to resolve)
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
COPY tools/package.json tools/

# Install production dependencies only
RUN npm ci --omit=dev

# Copy compiled shared library
COPY --from=builder /app/shared/dist shared/dist

# Copy compiled server + static files + data
COPY --from=builder /app/server/dist server/dist
COPY server/data server/data

# Copy built client for Caddy to serve
COPY --from=builder /app/client/dist /app/client-dist

# Map.json is loaded relative to server/dist/simulation/
# Path: ../../data/map.json -> server/data/map.json ✓

ENV PORT=3456
ENV NODE_ENV=production

EXPOSE 3456

CMD ["node", "server/dist/index.js"]
