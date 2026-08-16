# Prediction Market — Backend

Production NestJS backend for the private prediction marketplace (Monad + Unlink).
A **modular monolith**: cleanly separated feature modules (each could be split into a
microservice later) deployed as one fast, horizontally-scalable service.

## Stack

| Concern | Choice |
|---|---|
| Framework | NestJS 11 (modular monolith) |
| DB | PostgreSQL + **TimescaleDB** (price time-series hypertable) |
| ORM | Prisma 6 |
| Cache / pub-sub | Redis (ioredis) |
| Realtime | Socket.IO gateway, fanned out over Redis pub/sub |
| Chain | viem (Monad RPC), reorg-safe event indexer |
| Auth | Wallet-only (SIWE / EIP-4361) + JWT session |
| Logging | pino (structured) |
| Infra | Docker Compose |

## Privacy model (important)

The whole system hides **who** places each bet while keeping **market data and prices public**.
The backend is built to preserve that:

- `User` = the off-chain login identity (real wallet, used only to sign in).
- `Trade` / `Position` are keyed by the on-chain **execution account** — the unlinkable,
  ephemeral account Unlink routes each bet through.
- **There is no column anywhere linking a `User` to an execution account.** That mapping lives
  only in the user's client (the Unlink SDK holds the spending key). A portfolio is assembled
  **client-side** by asking `POST /positions/query` about the accounts the client knows are its
  own — the server aggregates public data and never records the association.

## Quick start (Docker — full stack)

```bash
cp .env.example .env          # edit secrets for anything real
docker compose up -d --build  # timescaledb + redis + backend (runs migrations on boot)
open http://localhost:3000/api/docs   # Swagger (non-prod)
```

## Quick start (local dev)

```bash
cp .env.example .env
docker compose up -d timescaledb redis   # just the infra
npm install
npm run prisma:generate
npm run prisma:migrate                    # apply migrations
npm run db:seed                           # categories + a demo market (optional)
npm run start:dev
```

## Auth — wallet only

Exchange-grade "sign once, then just connect":

1. `POST /api/auth/nonce { address }` → returns a single-use, address-bound nonce and a ready-to-sign
   SIWE message (nonce stored in Redis with a TTL).
2. Wallet signs the message. `POST /api/auth/verify { message, signature }` → verifies the signature
   + nonce, **creates the user on first sign-in (signup)**, returns an access + refresh token pair.
3. `POST /api/auth/refresh { refreshToken }` → returning users get a fresh pair **with no new
   signature**. Refresh tokens rotate on every use (reuse is detected and revokes the session).

Only when the refresh session expires or is revoked must the user sign again. Access tokens are
short-lived Bearer JWTs; send `Authorization: Bearer <accessToken>` on protected routes.

> Why not "connect wallet with no signature ever"? A wallet address is public — without a signature
> the server can't prove the caller controls it, so that would let anyone impersonate anyone. The
> session approach gives the same zero-friction feel securely.

## HTTP API (prefix `/api`)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/nonce` | public | Request nonce + SIWE message |
| POST | `/auth/verify` | public | Verify signature, signup/login, get tokens |
| POST | `/auth/refresh` | public | Rotate refresh → new token pair |
| POST | `/auth/logout` | public | Revoke a refresh session |
| GET | `/users/me` | bearer | Authenticated profile |
| PATCH | `/users/me` | bearer | Update profile |
| GET | `/users/:address` | public | Public profile |
| GET | `/markets` | public | List/filter/sort/paginate markets |
| GET | `/markets/:id` | public | Market detail + outcomes + live prices |
| GET | `/categories` | public | Category catalog |
| GET | `/markets/:id/trades` | public | Trade tape for a market |
| GET | `/trades?account=` | public | Global tape or per-execution-account trades |
| POST | `/positions/query` | public | Portfolio for a set of execution accounts |
| GET | `/markets/:id/positions?account=` | public | Positions of an account in a market |
| GET | `/markets/:id/prices/candles` | public | OHLC candles (TimescaleDB `time_bucket`) |
| GET | `/markets/:id/prices/latest` | public | Latest price per outcome |
| GET | `/health`, `/health/ready` | public | Liveness / readiness (DB + Redis) |
| GET | `/admin/me` | role | On-chain roles held by the caller |
| POST | `/admin/markets/drafts` | role | Draft market copy → returns `metadataHash` |
| GET | `/admin/markets/drafts` | role | Recent drafts + adoption status |
| PATCH | `/admin/markets/:id/metadata` | role | Edit title/description/image/outcome labels |
| POST/GET | `/admin/categories` | role | Manage the category catalog |
| GET | `/admin/operations` | role | Ops queue: unresolved, finalizable, disputed |
| GET | `/admin/treasury` | role | Accrued fees per engine (live from chain) |

## Admin authorization — on-chain roles

Admin routes require a normal JWT **plus** an on-chain AccessControl role, checked live against the
contracts (`hasRole`), cached in Redis for 30s. There is deliberately **no role table in the
database**: granting or revoking a role on-chain takes effect here immediately, with no sync step
and no possibility of drift. Roles mirror `contracts/src/access/Roles.sol` and are computed as
`keccak256("ROLE_NAME")` at runtime so they can't diverge.

The backend **never holds operator keys**. Every state-changing chain action (createMarket, resolve,
withdrawFees, pause) is signed client-side — ideally by a multisig. Admin endpoints only manage
off-chain copy and surface what needs attention.

`ADMIN_DEV_ADDRESSES` is a local-dev fallback used **only** when no RPC is configured; the app
refuses to boot if it is non-empty in production.

### Market metadata: hash-committed copy

On-chain markets carry a `metadataHash` (bytes32). The operator drafts the copy first
(`POST /admin/markets/drafts`), gets back `keccak256(canonical JSON)`, and passes that exact hash to
`createMarket(...)`. When the indexer sees `MarketCreated` with a matching hash it adopts the draft —
so the title, description, and outcome labels the API serves are **provably** the ones committed
on-chain, and anyone can verify by re-hashing. Encoding is order-independent and deterministic
(`src/admin/metadata-hash.ts`).

## Realtime (Socket.IO)

Connect to the same origin (WebSocket transport). Client → server messages:

- `subscribe { marketRef }` — join a market room
- `unsubscribe { marketRef }` — leave
- `subscribeGlobal` — new-market feed
- `ping` — heartbeat → `{ event: 'pong' }`

Server → client events (payloads are `{ event, marketRef, data, ts }`): `trade`, `price`,
`market_status`, `resolution` (per market room) and `market_created` (global room).

Fan-out: the indexer PUBLISHes to Redis; each backend instance PSUBSCRIBEs and emits only to its
locally-connected room members — so it scales horizontally with no message duplication.

## Chain indexer

Set the deployed engine/resolver addresses and an RPC in `.env`, then `INDEXER_ENABLED=true`. The
indexer:

- processes only up to `head - INDEXER_CONFIRMATIONS` (never the unstable tip — reorg-safe),
- backfills in `INDEXER_BATCH_BLOCKS` pages from a persisted cursor (`indexer_cursors`),
- is idempotent (trades upsert on `txHash+logIndex`), so re-scans never duplicate,
- mirrors markets/outcomes/trades/positions into Postgres, records price points into TimescaleDB,
  and publishes realtime updates.

## Testing

```bash
npm test        # unit tests (mocked Prisma/Redis — no infra needed)
npm run test:e2e   # e2e (needs timescaledb + redis up + migrations applied)
```

Positive and negative cases are covered per module (auth signature/nonce/session, market
serialization/caching, indexer accounting deltas, price math, admin role reads, config validation).

## Layout

```
src/
  config/        env validation (zod) + typed config service
  prisma/        PrismaService + module
  redis/         cache + pub/sub (3 dedicated connections)
  common/        filters, decorators, dtos, realtime channel registry, utils
  auth/          SIWE verify, nonce, JWT access/refresh, guards
  users/         profile
  markets/       list/detail/categories + serializer + Redis cache
  trades/        trade tape
  positions/     portfolio (client-supplied execution accounts)
  prices/        TimescaleDB candles + latest
  chain/         viem client, ABIs, event processor, reorg-safe indexer
  realtime/      Socket.IO gateway (Redis-bridged)
  health/        liveness/readiness
prisma/          schema + migrations (incl. hypertable) + seed
test/            e2e specs
```
