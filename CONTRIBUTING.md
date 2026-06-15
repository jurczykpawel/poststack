# Contributing to ReplyStack

## Development Setup

```bash
git clone https://github.com/jurczykpawel/poststack.git
cd replystack
cp .env.example .env
# Fill in your values in .env

docker compose up postgres
npm install
npm run db:migrate
npm run dev           # web (terminal 1)
npm run worker        # worker (terminal 2)
```

Open http://localhost:3000

## Project Structure

```
src/
├── server/           # Hono app: app.ts, routes/, handlers/ (framework-neutral), ui/, middleware/
├── lib/
│   ├── platforms/    # Social provider implementations
│   ├── rules/        # Auto-reply matching and execution
│   ├── workers/      # graphile-worker job processors
│   ├── queue/        # graphile-worker client (addJob + task list)
│   ├── crypto.ts     # Token encryption
│   └── db.ts         # Drizzle client
worker/
└── inbox-worker.ts   # Worker entrypoint
src/db/
├── schema.ts         # Database schema + enums
└── relations.ts      # Drizzle relations
```

## Adding a New Platform

1. Create `src/lib/platforms/{platform}.ts` extending `SocialProvider`
2. Implement: `generateAuthUrl()`, `authenticate()`, `refreshToken()`, `sendMessage()`, `sendComment()`
3. Register in `src/lib/platforms/registry.ts`
4. Add OAuth callback: `src/server/handlers/oauth/{platform}/route.ts`
5. Add to the `platform` enum in `src/db/schema.ts`, then run `npm run db:generate`

See `src/lib/platforms/base.ts` for the full interface and JSDoc.

## Code Style

- TypeScript strict mode
- No `any` types
- Every DB query must include `workspace_id` filter
- OAuth tokens must always be encrypted before DB write (`encryptTokens()`)
- No secrets in code or commit messages (AGPL = public history)
- Read `src/lib/platforms/base.ts` before implementing a provider

## Running Tests

```bash
npm test          # run once
npm run test:watch  # watch mode
```

## Database Changes

```bash
# After editing src/db/schema.ts:
npm run db:generate  # generates a new SQL migration from the schema diff
npm run db:migrate   # applies pending migrations
```

## Pull Requests

- One feature/fix per PR
- Include tests for new functionality
- Run `npm run lint && npm run typecheck && npm test` before submitting
- CI must pass

## License

By contributing, you agree your contributions are licensed under AGPL-3.0.
