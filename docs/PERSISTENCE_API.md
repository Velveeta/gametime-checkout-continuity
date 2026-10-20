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

## Key layout and scoped optimistic transactions

All keys use the namespace Redis hash tag and are explicit Lua KEYS. Sharing a
hash slot permits atomic multi-key publication; it does **not** make unrelated
keys part of a transaction's conflict checks.

| Key | Contents and retention |
| --- | --- |
| `checkout:{namespace}:inventory:v2:listingId` | One listing, live holds, inventory revision, bounded sold-seat/count summary; durable |
| `checkout:{namespace}:session:v2:sessionId` | One checkout, at most three payment attempts and three replay entries; absolute metadata TTL |
| `checkout:{namespace}:completed:v2:sessionId` | One permanent order-uniqueness fence plus the original caller/key-bound completion receipt |
| `checkout:{namespace}:order:v2:orderId` | One durable order and capability digest |

There is no namespace-wide checkout index or growing per-event reservation history.
Confirmation reads fetch only their order. Historical orders/receipts are separate
records and are never scanned by new purchases. Catalog seeding performs bounded
fixture work, preserves existing v2 data and has no checkout-wide CAS dependency.
Session/order timestamps are epoch milliseconds internally and UTC ISO externally.

The transaction protocol remains optimistic, with authoritative TypeScript rules:

1. Discover the target checkout's listing/recovery successor, then use
   `SNAPSHOT_LUA` to reread the complete relevant key set plus Redis TIME atomically.
   Ordinary EVAL routes these reads to the primary. Missing keys are dependencies
   too. Expired hold owners join the set so fencing and release commit together;
   unrelated live checkouts and other listings do not join it.
2. Apply pure domain decisions to a private working set: current price and
   acknowledgement, session version, ownership, fixed deadlines, attempt limits,
   one order per session and caller/key binding. Reconcile due holds first.
3. `COMMIT_LUA` compares every read key's original bytes and validates that Redis
   TIME has not crossed a relevant deadline or moved backwards. A conflict retries
   the whole decision, up to 64 times. No separate unguarded writes or local locks.
4. Start newly authorized holds/processing windows from commit-time Redis TIME.
   Validate/serialize all changed values and the response before MSET; publish
   only changed records together. Assign temporary records their absolute
   PEXPIREAT metadata deadline in the same script. Guard rejections can still
   persist due expiration/quote reconciliation.

Transactions sharing a listing deliberately coordinate over that listing's stock;
transactions on different listings, including the same event, do not invalidate
one another. Recovery atomically reads/writes original and successor session keys;
settlement publishes sale, order, permanent completion fence and replay together.
Permanent fences reject new completion keys and internal session-ID reuse even
after temporary records are gone. The original caller/key can recover its stable
successful response/capability without recreating a checkout or selling twice.

### Retention and inventory lifecycle

Business reservation deadlines and processing deadlines remain authoritative.
Inventory never has a TTL. Before another shopper reserves, due processing
attempts are fenced and holds released atomically, even if no worker ran and all
metadata keys still exist. Late settlement cannot sell a newly acquired hold.
Sold holds are immediately folded into a quantity/seat occupancy summary; released
and expired holds are removed. Inventory size depends on listing capacity/current
holds, not the number of past visitors or purchases.

Read/recovery access ends at `recoveryRetainUntil` (normally 30 minutes after the
original 10-minute hold). Temporary session/attempt/replay records are physically
collected at `max(recoveryRetainUntil, processingDeadlineAt) + 24 hours`. Neither
polling, acknowledgements nor replay extends this absolute deadline. The extra
window supports unsuccessful-operation retries; after collection those retries
return NOT_FOUND and can never initiate payment. A successful purchase instead
keeps one permanent completion receipt and order, so its authorized replay and
confirmation remain durable. These small per-purchase records grow with sales,
but do not increase the work of unrelated transactions. Real financial/legal
retention or archival is outside this simulated prototype.

If a process crashes after claiming payment, protection lasts until the processing
deadline and then fails safely. There is no background payment job or real gateway
reconciliation worker. Redis transport retries may replay a committed operation;
its caller/key and permanent receipt preserve idempotency.

### Storage upgrade and remaining limits

V2 is a storage-format change; HTTP and repository signatures are preserved.
Initialization **refuses any legacy v1 index/event inventory** in the namespace,
before writing anything. This prevents reseeding already-held or sold inventory.
For an existing v1 demonstration, keep its namespace/data intact and choose a new
isolated CHECKOUT_NAMESPACE for v2. No destructive reset or automatic migration is
included. A real deployed database would require a reviewed offline migration;
no hosted database was configured during this assessment.

This is bounded prototype hardening, not an unlimited-throughput claim. One very
popular listing can still contend, commits retry only 64 times, inventory summaries
scale with seat capacity, and the namespace uses one Redis cluster slot. Cluster
sharding, production load/failover testing and provider limits remain future work.

Production uses the joint store. The Wave 01 standalone adapter retains its v1
format for tests/compatibility; **do not mix it with v2 in one namespace** or use
its sale primitive for checkout. Future price/deadline/reset writers must modify
the relevant v2 records through the same consistency protocol.

Upstash documents primary routing for ordinary EVAL (distinct from EVAL_RO).
Provider failover/disk durability and hosted limits have not been exercised locally.
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
  read/write token that supports EVAL, MSET and PEXPIREAT. Do not use read-only credentials.
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
successful-settlement responses. Hardening tests deliberately interleave unrelated
same-event listings, force a conflicting price publish, expire actual metadata
TTLs, and verify durable replay/sold stock afterward. Disk-loss/failover and
production throughput are not simulated.

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
confirmation, then deletes only the exact keys touched in that generated namespace. It ignores your regular
CHECKOUT_NAMESPACE and never scans or flushes a database. A failed live suite must
be investigated before claiming hosted compatibility. Run `npm run build` before
`npm run test:http` when invoking the built-HTTP suite separately.
