# Node base for reproducible `npm ci` + Prisma CLI; Bun binary for the runtime.
FROM node:22-alpine AS base
RUN apk add --no-cache curl libc6-compat
COPY --from=oven/bun:1-alpine /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

# Install dependencies; postinstall runs `prisma generate` into src/generated.
FROM base AS deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN npm ci --omit=dev

# Production runner — Bun runs the TypeScript entrypoint directly (no build step).
FROM base AS runner
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 app

COPY --from=deps --chown=app:nodejs /app/node_modules ./node_modules
COPY --chown=app:nodejs prisma ./prisma
COPY --chown=app:nodejs prisma.config.ts tsconfig.json package.json ./
COPY --chown=app:nodejs src ./src
# Prisma client generated inside the image (portable TS via the pg driver adapter).
COPY --from=deps --chown=app:nodejs /app/src/generated ./src/generated
COPY --chown=app:nodejs entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

USER app

EXPOSE 3000
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

ENTRYPOINT ["./entrypoint.sh"]
