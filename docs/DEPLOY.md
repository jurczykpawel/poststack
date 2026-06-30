# Deploying & Updating PostStack

Canonical, step-by-step runbook for **standing up a new instance** and **updating an existing
one**. Written to be followed equally well by a human operator or an AI agent: every step has an
exact command and an expected result. For local development see the [README Quick Start](../README.md#quick-start).

> **Self-host model.** A production instance is a single Docker Compose stack — `nginx` →
> `web` (Hono) + `worker` (graphile-worker) + `postgres`. All state lives in Postgres
> (the `postgres_data` volume); there is no other store. Images are pulled from GHCR
> (`ghcr.io/jurczykpawel/poststack` and `ghcr.io/jurczykpawel/poststack-worker`), built and published
> by the `release.yml` GitHub Actions workflow on every `v*` tag.

---

## 0. Easiest path: StackPilot (managed, one command)

If you'd rather not hand-edit `.env`, generate secrets, or stand up a TLS proxy yourself, use
**[StackPilot](https://github.com/jurczykpawel/stackpilot)** — a self-host toolbox that does the
whole §1 below for you in one command, **including the HTTPS front (Cloudflare/Caddy + TLS)** that
Meta requires.

```bash
# Fully managed: installs the stack AND configures a Cloudflare/Caddy domain with TLS.
./local/deploy.sh poststack --domain-type=cloudflare --domain=inbox.example.com

# Or run on the target server (installs the stack with auto-generated secrets; you then
# put your own reverse proxy / Cloudflare in front for HTTPS):
curl -fsSL https://stackpilot.techskills.academy/poststack | bash
```

What it does for you, with no questions asked:

- Generates and stores all secrets in `/opt/stacks/poststack/.env` (`chmod 600`):
  `POSTGRES_PASSWORD`, `ENCRYPTION_KEY`, `JWT_SECRET`, `CRON_SECRET`, `ALTCHA_HMAC_KEY`.
- Sets `APP_URL` from `--domain`, `NODE_ENV=production`, and `TRUSTED_PROXY`
  (`cloudflare` for `--domain-type=cloudflare`, otherwise `proxy`).
- Brings up the full `nginx + web + worker + postgres` stack from the public GHCR images and
  runs migrations on cold start.

After it finishes, open `APP_URL/register` to create the owner account (§1.5), then connect Meta
(§1.6). Re-running the installer **preserves the existing `.env`** (so `ENCRYPTION_KEY` stays stable
and stored tokens keep decrypting). Update later with `./local/deploy.sh poststack --update`. What
StackPilot does **not** decide for you — Meta/Google app credentials and a PRO license — are set in
the dashboard afterward.

Everything below (§1–§5) is the **manual equivalent**: do it by hand when you want full control over
the proxy, the registry, or the host, or when you're not using StackPilot.

---

## 1. New instance

### 1.1 Prerequisites

- Docker + Docker Compose v2 on the target host.
- Network access to GHCR. The images are **public** — no login needed. (Private forks only:
  `docker login ghcr.io` with a PAT that has `read:packages`.)
- **A public HTTPS endpoint in front of the stack.** The bundled `nginx` serves plain **HTTP on
  port 80**; Meta OAuth **and** webhooks only work over HTTPS, so you must terminate TLS in front:
  - **Cloudflare** (simplest): a proxied DNS record at your host → free edge TLS forwarding to `:80`.
    Set `TRUSTED_PROXY=cloudflare` in `.env` so per-IP rate limiting reads the real client IP.
  - **or a TLS reverse proxy** (Caddy / Traefik / nginx-with-certs) forwarding `https://your-domain`
    → `http://host:80`.
  `APP_URL` (below) must be that public `https://` URL.

### 1.2 Get the code and configure

```bash
git clone https://github.com/jurczykpawel/poststack.git
cd poststack
cp .env.example .env
```

Edit `.env`. **Required** (the app validates env with zod at boot — a missing/invalid value means
`web` refuses to start, by design):

| Var | How to generate / what to set |
|-----|-------------------------------|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Any values; the bundled Postgres is initialized with them. |
| `ENCRYPTION_KEY` | Passphrase ≥ 32 chars — `openssl rand -base64 32`. **Encrypts OAuth tokens. Never change it after channels are connected** (existing tokens become undecryptable). |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `CRON_SECRET` | `openssl rand -hex 32` |
| `META_APP_ID`, `META_APP_SECRET` | From [Meta for Developers](https://developers.facebook.com). |
| `META_WEBHOOK_VERIFY_TOKEN` | Any random string you choose; you re-enter it in the Meta App Dashboard. |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | **Optional.** Only needed to connect an Instagram account via **Instagram Business Login** (DMs + comments + follow-gate + publishing on one account, no Facebook page, at Standard Access). These are the **Instagram** app's id/secret (Meta app → Instagram product → "API setup with Instagram login") — **distinct** from `META_APP_ID`/`META_APP_SECRET`. |
| `APP_URL` | The public HTTPS URL, e.g. `https://inbox.example.com`. Used for OAuth redirects + webhook URL display. |

**Recommended for production:** pin the image instead of tracking `latest`, so each release is an
intentional bump:

```bash
echo "IMAGE_TAG=v0.7.1" >> .env   # the version you intend to run (latest release)
```

> **Forks / private registry:** set `IMAGE_REPO` in `.env` to your own registry path.

### 1.3 Start the stack

```bash
docker compose -f docker-compose.prod.yml up -d
```

On the first start the `web` container runs database migrations in its entrypoint **before** it
serves (the compose healthcheck has a 60s `start_period` to cover this), then the `worker` starts
once `web` is healthy. First pull/cold-start takes a minute or two.

### 1.4 Verify it is healthy

```bash
docker compose -f docker-compose.prod.yml ps          # web + worker + postgres → "Up (healthy)"
curl -fsS http://localhost/api/health                 # → {"status":"ok"} (HTTP 200)
docker compose -f docker-compose.prod.yml logs web --tail 30
# expect: migrations applied / "database up to date" → server listening
```

### 1.5 Bootstrap the admin account

Registration is **closed by default** (`REGISTRATION_ENABLED` unset/`false`), but the **first**
account on an empty instance can always register, to create the owner.

1. Open `APP_URL/register` and create your account **immediately** after deploy (or keep the
   instance network-restricted until you have).
2. Leave `REGISTRATION_ENABLED` off so no further self-signups are possible.

### 1.6 Connect Meta + verify the webhook

1. In the Meta App Dashboard set the webhook callback URL to `APP_URL/api/webhooks/meta` and the
   verify token to your `META_WEBHOOK_VERIFY_TOKEN`. Confirm the handshake from the host:
   ```bash
   curl -s "http://localhost/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=$META_WEBHOOK_VERIFY_TOKEN&hub.challenge=ping123"
   # → must echo back: ping123
   ```
2. In the dashboard go to **Channels** and connect your first Facebook Page / Instagram account.
   PostStack auto-subscribes the page to the required webhook fields (see **Webhooks → Subscriptions**
   in the dashboard for active-vs-expected status).
3. **(Optional) Instagram Business Login.** To connect a single Instagram account directly — for
   DMs + comments + follow-gate + publishing, **without** a Facebook page — set `INSTAGRAM_APP_ID` /
   `INSTAGRAM_APP_SECRET` (§1.2) and register `APP_URL/api/oauth/instagram-login/callback` as a **Valid
   OAuth Redirect URI** under the Meta app's **Instagram product → "API setup with Instagram login"**.
   The IG-Login product webhook callback is the **same** `APP_URL/api/webhooks/meta`, subscribed to the
   `messages` + `comments` fields. Then use **"+ Instagram (messaging)"** on the Channels page.

> **Two paths for Instagram.** A **Facebook / System User** connection (see
> [META_SYSTEM_USER_SETUP.md](META_SYSTEM_USER_SETUP.md)) bulk-connects **all** linked Instagram
> accounts but only for **publishing and comments** — Instagram DMs are **not** delivered that way at
> Standard Access. **Instagram Business Login** connects one account at a time, including **DMs**. Both
> run at Meta **Standard Access** (no App Review for your own accounts).

---

## 2. Updating an existing instance

Migrations are **forward-only**. Within a release line the schema is backward-compatible, so the
running old container keeps working until the moment it is swapped.

### 2.1 Simple update (brief blip)

Bump the tag, pull, recreate:

```bash
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=v0.5.0/" .env   # or: echo "IMAGE_TAG=v0.5.0" >> .env
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

The new `web` container migrates on cold start before serving. There is a short downtime window
while `web` is being recreated (cold start + migration). Fine for most self-hosters.

### 2.2 Zero-blip update (recommended — mirrors CI)

Run migrations as a **separate one-shot** while the old `web` keeps serving, then recreate only
`web` + `worker` and let Compose wait for the healthcheck before returning:

```bash
docker compose -f docker-compose.prod.yml pull

# Migrate via a throwaway container. NOTE: the image entrypoint runs migrate AND then serves
# (never exits), so override it with `--entrypoint bun` to run only the migration and exit.
docker compose -f docker-compose.prod.yml run --rm --no-deps \
  --entrypoint bun web scripts/migrate.ts

docker compose -f docker-compose.prod.yml up -d --no-deps --wait --wait-timeout 180 web worker
docker image prune -f
```

Benefits: a bad migration aborts the deploy **before** it touches the live `web`; the new web's
boot-migrate becomes a fast no-op; `--wait` makes the command fail honestly if the new container
never becomes healthy. This is exactly what the CI `release.yml` does on every deploy.

### 2.3 Verify

```bash
docker compose -f docker-compose.prod.yml ps          # all "Up (healthy)"
curl -fsS http://localhost/api/health                 # 200
```

---

## 3. Rollback

A deploy that turns out bad is rolled back by pinning the previous good tag and bringing the stack
back up (the schema is compatible within a release line):

```bash
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=v0.4.17/" .env      # the last good tag
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d --no-deps --wait web worker
```

Pinning `IMAGE_TAG` to an explicit version (not `latest`) is what makes rollbacks predictable —
you always know which version is live and which to fall back to.

> A rollback **across** a release line that dropped/renamed columns is not safe (migrations are
> forward-only). Restore from a backup (§4) if you must go back that far.

---

## 4. Backups

```bash
# Logical dump (portable; restore with psql / pg_restore)
docker compose -f docker-compose.prod.yml exec postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > poststack-$(date +%F).sql.gz
```

Restore into a fresh stack:

```bash
gunzip -c poststack-2026-06-16.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB"
```

---

## 5. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `web` crash-loops with a migration error | The DB is not in a consistent state (e.g. tables exist without the drizzle journal). The entrypoint fails hard on migration errors by design — better than serving on a wrong schema. Restore from backup or start on a fresh `postgres_data` volume. |
| `web` won't start, exits immediately | Invalid/missing env var (zod validation). Check `docker compose logs web` — it names the failing variable. |
| Webhook handshake returns nothing / wrong value | `META_WEBHOOK_VERIFY_TOKEN` in `.env` doesn't match the token entered in the Meta dashboard. |
| `worker` never starts | It is gated on `web` being healthy (so the schema exists first). Fix `web` health and the worker follows. |
| Connections exhausted at scale | See [README → Database connection sizing](../README.md#database-connection-sizing). Raise Postgres `max_connections` or lower `DB_POOL_MAX` before adding replicas. |
