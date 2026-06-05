FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat curl
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN npm ci
RUN npx prisma generate
# Remove darwin binary if present (CI builds on Linux)
RUN find /app -name 'libquery_engine-darwin*' -delete

# Build
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PHASE=phase-production-build
# Dummy env vars for next build (validated at runtime, not build time)
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV JWT_SECRET="build-only-not-real-must-be-32-chars!!"
ENV TOKEN_ENCRYPTION_KEY="0000000000000000000000000000000000000000000000000000000000000000"
ENV NEXT_PUBLIC_APP_URL="http://localhost:3000"
ENV META_APP_ID="build"
ENV META_APP_SECRET="build"
ENV META_WEBHOOK_VERIFY_TOKEN="build"
ENV CRON_SECRET="build-only-not-real-must-be-32-chars!!"
RUN npx prisma generate
RUN npm run build
# Remove darwin binary from standalone output
RUN find /app/.next/standalone -name 'libquery_engine-darwin*' -delete

# Production runner
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Prisma schema + config for entrypoint migrations
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts
# Full node_modules from deps stage (prisma CLI needs many transitive deps)
COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/entrypoint.sh ./entrypoint.sh

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

ENTRYPOINT ["./entrypoint.sh"]
