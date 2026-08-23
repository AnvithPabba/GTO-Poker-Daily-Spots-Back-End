# Standalone backend image. Build context is this backend repository; the
# public contract arrives as the reviewed v0.3.1 tarball in vendor/.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV CI=true
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml ./
COPY vendor ./vendor
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
RUN pnpm exec prisma generate && pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist
EXPOSE 3000 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.WORKER_PORT || process.env.API_PORT || 3000) + '/health/live').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/server.js"]
