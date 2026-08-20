# Health-only Express and worker runtime image. The production application
# routes, Prisma repositories, and business queues arrive in later blocks.
# Build from the webapp directory while contracts use the local sibling package:
#   docker build -f backend/Dockerfile -t poker-trainer-backend:dev .

FROM node:22-bookworm-slim AS build

WORKDIR /workspace
ENV CI=true

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY contracts/package.json contracts/pnpm-lock.yaml ./contracts/
COPY contracts/tsconfig.base.json contracts/tsconfig.json contracts/tsconfig.build.json ./contracts/
COPY contracts/src ./contracts/src
RUN pnpm --dir contracts install --frozen-lockfile && pnpm --dir contracts build
COPY backend/package.json backend/pnpm-lock.yaml ./backend/
RUN pnpm --dir backend install --frozen-lockfile

COPY backend/tsconfig.base.json backend/tsconfig.json backend/tsconfig.build.json ./backend/
COPY backend/prisma ./backend/prisma
COPY backend/src ./backend/src
RUN pnpm --dir backend exec prisma generate
RUN pnpm --dir backend build

FROM node:22-bookworm-slim AS runtime

WORKDIR /workspace
ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY --from=build /workspace/contracts/package.json /workspace/contracts/pnpm-lock.yaml ./contracts/
COPY --from=build /workspace/contracts/dist ./contracts/dist
COPY backend/package.json backend/pnpm-lock.yaml ./backend/
COPY --from=build /workspace/backend/prisma ./backend/prisma
RUN pnpm --dir backend install --frozen-lockfile --prod=false \
    && pnpm --dir backend exec prisma generate \
    && pnpm --dir backend prune --prod
COPY --from=build /workspace/backend/dist ./backend/dist

WORKDIR /workspace/backend
EXPOSE 3000 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.WORKER_PORT || process.env.API_PORT || 3000) + '/health/live').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/server.js"]
