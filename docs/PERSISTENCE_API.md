# Wave 03 persistence and HTTP integration

## Implemented boundary

`RedisCheckoutStore` implements `CheckoutRepository`, `OrderRepository` and the
inventory read contract. It persists sessions, inventory/reservations, attempt
fences, orders, checkout-order uniqueness, capability digests and request replay
records. Final operation replay and order confirmation outlive the checkout
metadata read/recovery horizon. `composeCheckout` is shared by production and integration tests; Vercel
invocations construct fresh instances. No process-local stock/session cache or
lock is used. Existing test-only in-memory reference adapters remain available.

`checkoutRuntime` constructs the Upstash SDK only at runtime and seeds missing
records without overwriting existing data. Static builds require no credentials.
Public JSON handlers delegate to `CheckoutHttpApi`, which validates and transports
requests to framework-independent application/domain services. The SSR checkout
page invokes services directly. Its minimal server HTML is only a Wave 04 seam;
responsive checkout interactions and event/confirmation pages are still pending.

## Key layout and optimistic transaction proof

All keys use the same namespace Redis hash tag, and all accessed keys are explicit
Lua KEYS:

| Key | Contents |
| --- | --- |
| `checkout:{namespace}:inventory:eventId` | Existing Wave 01 schema v1: definitions, exact/GA reservations, inventory revision, sold stock |
| `checkout:{namespace}:checkouts:v1` | Schema v1 index: sessions, orders, unique order-by-session map, attempts/fences, replay ledger, capability digests |

Session/order timestamps use epoch milliseconds internally; APIs hydrate canonical
UTC ISO strings. The index deliberately groups related metadata into one key so
sessions, orders, replay grants and fences share the same commit. Existing event
inventory keys retain their schema. No automatic destructive migration or reset
is exposed; unknown/corrupt schemas fail closed.

The implementation is an optimistic transaction, not an unguarded read/update:

1. `SNAPSHOT_LUA` reads the full checkout index and every catalog event inventory
   document together with Redis TIME. Even pure reads use EVAL, not EVAL_RO.
2. TypeScript applies the existing domain functions to a private candidate, checking
   current quotes, session CAS, reservation membership/ownership, availability,
   attempts, order uniqueness and caller/key replay identity. It jointly reconciles
   due processing sessions and stock before selecting available seats.
3. `COMMIT_LUA` compares the exact bytes of EVERY read key with that snapshot and
   checks that Redis TIME has not crossed the earliest relevant business,
   processing or metadata-retention boundary (or moved backwards). Any mismatch
   retries the entire decision from a fresh snapshot, up to 64 attempts.
4. New reservation/protection timestamps are started from commit-time Redis TIME,
   not application planning time. All values and the response are serialized
   before the only write: one MSET atomically publishes index plus inventories.
   Failed validation performs no partial write. Expiry/quote reconciliation may
   commit even when a later business guard returns a structured rejection.

This gives a serializable conditional publish over this read set, including
reservation, claim/protection, completion/order/sale/digest/ledger, and one linked
recovery successor. It reuses the tested TypeScript rules rather than maintaining
a second checkout state machine in Lua. New holds start at successful commit;
ordinary reads/replays never extend them. Different idempotency keys cannot
produce different orders for one checkout. A lost settlement response can be
retried by the same caller/key and rederive the original confirmation capability.
A process crash or lost claim response before payment starts may leave PROCESSING
until its deadline; the attempt then fails safely. There is no background payment
job or real-gateway reconciliation in this prototype.

Redis key expiry/notifications are not business authority. Sessions become
logically unavailable at recoveryRetainUntil; holds become logically free at their
business deadline unless processing protection applies. Processing timeout fences
the attempt and releases its hold in the same publish; late settlement cannot
sell reacquired stock. Orders/sold units remain durable. No TTL or pruning is
currently applied to these aggregate keys: old metadata/fences remain physically
retained, while API access observes the configured retention boundary. This favors
correct replay fencing in a small prototype; growing history, whole-document
transfers, namespace-wide contention and bounded retries limit scale.

Production composition uses the joint store for inventory reads. The legacy
standalone inventory adapter/factory remains for compatibility/tests; do not use
its sale primitive as checkout completion. Any future writer must participate in
this consistency boundary, including developer price/deadline/reset operations.

Upstash documents primary routing for ordinary EVAL (distinct from EVAL_RO); this
is why authoritative snapshots are scripts rather than replica GETs. Provider
failover/disk durability and hosted limits have not been exercised locally.
References: https://redis.io/docs/latest/develop/programmability/eval-intro/ and
https://upstash.com/blog/replicated-cache-backed-by-redis (primary reads section).

## Pricing and read semantics

`GET /api/checkouts/:id` never writes Redis, recovers or extends a deadline. It
projects effective expiry and current persisted quote in memory. A projected
quote may advance the visible session version; the next mutation repeats that
projection before CAS validation. Direct `refreshQuote` remains available for
explicit internal synchronization. Claim checks the current full total and exact
accepted version. A lower pending increase that still exceeds acceptedTotal
remains blocked. PROCESSING uses the locked claim quote, not later price changes.

## HTTP contract

All JSON responses use `Cache-Control: private, no-store, max-age=0`, Vary Cookie /
Authorization and nosniff. Success envelope: `{ok:true,data:...}`. Failure:
`{ok:false,error:{code,message},data?:...}`. Zod rejects unknown properties and
invalid IDs/versions. JSON mutations require application/json, reject cross-origin
browser requests and enforce a 16 KiB body limit.

| Route | Contract |
| --- | --- |
| GET `/api/events` | Events and explicit simulation notice |
| GET `/api/events/:id` | One event, or 404 |
| GET `/api/events/:id/listings` | Stable fixture ordering; current listing prices and live availability/counts/server time |
| POST `/api/checkouts` | `{eventId,listingId,allocation,expectedListingVersion}`; allocation is assigned section/row/seats or GA section/quantity; 201 on reservation |
| GET `/api/checkouts/:id` | Read-only snapshot and serverNow; retained EXPIRED state returns 410 with snapshot in data; missing metadata 404; never recovers |
| POST `/api/checkouts/:id/acknowledge-price` | `{expectedVersion,quoteVersion}`; exact live quote and CAS required |
| POST `/api/checkouts/:id/complete` | Same version body plus Idempotency-Key header and signed caller cookie; 202 in progress, 200 operation result |
| POST `/api/checkouts/:id/recover` | `{intent:"FRESH_NAVIGATION"}` plus Idempotency-Key; one successor or event/root navigation instruction |
| GET `/api/orders/:id/confirmation` | Per-order confirmation cookie or Authorization: Bearer capability; no token in URL |

Assigned allocation example:

```json
{"kind":"ASSIGNED","section":"443 · Upper Reserved","row":"18","seats":[9,10]}
```

Conflict/price/CAS/idempotency/terminal mutations return 409; expired holds return
410; invalid JSON/input/selection returns 400, wrong media type 415, missing caller
cookie 401, invalid capability/cross-origin mutation 403, missing resource 404.
Unavailable configuration/transport returns sanitized 503, never credentials.
A resolved simulated decline is a successful operation response containing terminal
PAYMENT_FAILED state; it is not a retryable HTTP transport failure.

## Device binding and confirmation

POST creation and GET checkout establish a signed `cc_caller` cookie (HttpOnly,
SameSite=Lax, Secure in production, Path=/, seven days). Completion requires that
existing valid cookie: it does not mint a new identity during a purchase/retry.
This avoids losing the initiating binding if two cookie-less requests compete.
A client on a second device must first GET the shared checkout. Ignore/reject
body-supplied caller IDs; no user authentication is claimed by this demo binding.

Successful completion JSON returns `{kind:"COMPLETED",orderId,confirmationUrl}`;
the URL currently targets the implemented JSON confirmation endpoint. The bearer
is sent only via `cc_confirmation_orderId` HttpOnly cookie. Ordinary snapshots and
logs never include it. Nonbrowser clients may forward that cookie or use its value
as a Bearer header for confirmation. Keep the same device cookie, idempotency key
AND original version body for a lost-response replay. A confirmed transient retry
needs a NEW key and a fresh checkout snapshot. Other bindings/keys receive no
completed-order grant. Do not expose tokens in query strings or client storage.

SSR `/checkout/:id` invokes fresh-navigation policy directly: active/processing
state renders initial HTML; completed/terminal failed/missing state redirects
home; expired retained metadata attempts one successor, otherwise event/root.
The event and responsive confirmation pages are Wave 04 work. JSON polling must
handle 410 by event navigation; it must not call recover. Disable checkout-link
prefetching in Wave 04 so speculative rendering cannot request fresh recovery.

## Runtime environment and local setup

Copy `.env.example` to `.env.local` and supply:

- UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN: HTTPS REST endpoint and a
  read/write token that supports EVAL and MSET. Do not use read-only credentials.
- CHECKOUT_NAMESPACE: stable across instances of one environment; isolate local,
  preview and production environments with different namespaces.
- CHECKOUT_CALLER_SECRET and CHECKOUT_COMPLETION_SECRET: distinct, persistent,
  random values of at least 32 characters. Generate twice with `openssl rand -hex 32`.
  Rotation invalidates device/replay bindings; no default secret is provided.
- PAYMENT_SCENARIO defaults to SUCCESS, always simulated. Non-default scenarios
  require DEMO_MODE=true and DEMO_SECRET (>=32 chars). No public scenario-edit or
  developer endpoints exist yet. No real gateway/authentication is integrated.

Use `npm ci`, then `npm run dev`. Set these same variables server-side in Vercel
when deployment is authorized later; none uses a NEXT_PUBLIC prefix. An unconfigured
API returns 503; static homepage/build remains usable without live credentials.

## Verified tests and hosted validation

`npm run check` runs lint, types, unit tests, real local Redis integration tests,
production build, then a built-HTTP test. Local tests require redis-server/redis-cli
>=6.2 plus openssl on PATH (or REDIS_SERVER/REDIS_CLI absolute binary paths).
On macOS: `brew install redis openssl`. No local service needs to be started.
The harness starts temporary loopback Redis with persistence disabled and stops it.

The built-HTTP test starts two Next instances and uses the actual Upstash SDK over
TLS through a **test-only REST protocol bridge backed by real Redis**. It verifies
Route Handler wiring, secure cookies, cross-instance completion/replay,
confirmation, expired JSON and SSR redirects. This is not a hosted provider test.
Real-Redis integration additionally exercises contention, expiry, recovery,
repricing races, processing fences, a deliberately delayed commit, and lost
successful-settlement responses. Disk-loss/failover is not simulated.

No live Upstash credentials were available in this run. To complete hosted SDK /
EVAL validation, export the credentials (without printing them), then run:

```sh
set -a
source .env.local
set +a
npm run test:upstash
```

This opt-in suite fails when credentials are missing; it is excluded from default
checks. It always generates its own `live-test-UUID` namespace, verifies SDK script
transport, simultaneous reservations/completions, cross-instance replay and
confirmation, then deletes only its five exact test keys. It ignores your regular
CHECKOUT_NAMESPACE and never scans or flushes a database. A failed live suite must
be investigated before claiming hosted compatibility. Run `npm run build` before
`npm run test:http` when invoking the built-HTTP suite separately.
