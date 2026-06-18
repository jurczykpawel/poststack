# Node base for reproducible `npm ci`; Bun binary for the runtime.
FROM node:22-alpine AS base
RUN apk add --no-cache curl libc6-compat
COPY --from=oven/bun:1-alpine /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# LANDING1: build the Astro marketing site (served by the app at `/`). Isolated stage so its
# dev-deps (astro, tailwind) never reach the runtime image — only the static dist is copied over.
FROM node:22-alpine AS landing
WORKDIR /landing
COPY landing/package.json landing/package-lock.json* ./
RUN npm ci
COPY landing/ ./
# Public (non-secret) analytics IDs — Astro inlines PUBLIC_* at build time. Passed as build-args
# from CI (release.yml build job ← repo Variables). Empty by default → no tracker loads, build green.
ARG PUBLIC_UMAMI_WEBSITE_ID=""
ARG PUBLIC_UMAMI_SRC=""
ARG PUBLIC_GTM_ID=""
ENV PUBLIC_UMAMI_WEBSITE_ID=$PUBLIC_UMAMI_WEBSITE_ID \
    PUBLIC_UMAMI_SRC=$PUBLIC_UMAMI_SRC \
    PUBLIC_GTM_ID=$PUBLIC_GTM_ID
RUN npm run build

# Production runner — Bun runs the TypeScript entrypoint directly (no build step).
FROM base AS runner
ENV NODE_ENV=production
# Pin the process clock to UTC so app-clock writes/reads share the DB session's UTC domain — a
# non-UTC host skews the retention cutoff and silently over-deletes in-window messages.
ENV TZ=UTC

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 app

COPY --from=deps --chown=app:nodejs /app/node_modules ./node_modules
COPY --chown=app:nodejs tsconfig.json package.json ./
COPY --chown=app:nodejs src ./src
# Drizzle migrations + runner applied at startup by entrypoint.sh.
COPY --chown=app:nodejs drizzle ./drizzle
COPY --chown=app:nodejs scripts ./scripts
# Built marketing site, served at `/` by src/server/routes/landing.ts (CWD=/app → landing/dist).
COPY --from=landing --chown=app:nodejs /landing/dist ./landing/dist
COPY --chown=app:nodejs entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

USER app

EXPOSE 3000
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

ENTRYPOINT ["./entrypoint.sh"]
