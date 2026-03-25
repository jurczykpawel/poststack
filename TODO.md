# TODO

## Testy

Obecne pokrycie: 23 testy (crypto, auth, rule matcher). Brakuje:

- [ ] **Rule executor** (`src/lib/rules/executor.ts`) - mock Prisma + Redis (cooldown SETNX)
- [ ] **Workers** - incoming-message, incoming-comment, outgoing-message, sequence-step, token-refresh
- [ ] **API routes** - channels, conversations, contacts, rules, sequences, tags, api-keys (integration testy z test DB)
- [ ] **Rate limiter** (`src/lib/api/rate-limit.ts`) - mock Redis
- [ ] **Body limit parser** (`src/lib/api/body-limit.ts`) - unit testy z roznymi payload sizes
- [ ] **JWT invalidation** (`invalidateSession` w auth/index.ts) - mock Redis
- [ ] **OAuth state** (`src/lib/oauth/state.ts`) - mock next/headers cookies
- [ ] **Channel upsert** (`src/lib/channels/upsert.ts`) - mock Prisma
