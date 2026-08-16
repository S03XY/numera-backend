# ---- Stage 1: build ----
FROM node:22-slim AS builder
WORKDIR /app

# Prisma needs openssl at generate/runtime.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# All deps including dev, since the build needs them. `ci` not `install`: the
# Unlink SDK is pinned to a canary build and only the lockfile records which one,
# so `install` is free to resolve a newer canary than the one that was tested.
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies for a lean runtime node_modules.
RUN npm prune --omit=dev

# ---- Stage 2: runtime ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y openssl postgresql-client && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package.json ./
COPY docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker/entrypoint.sh"]
CMD ["node", "dist/main.js"]
