# Checkout Continuity — agent implementation package

A phased implementation contract for a fictional ticket marketplace built for the GameTime assessment. **All events, dates, listings, prices and purchases are simulated.**

## Start here

1. Read `AGENTS.md` (global guardrails, intentionally short).
2. Execute **only** the assigned `specs/NN-*.md` wave.
3. Read `handoffs/NN-previous.md` if one exists; do not ingest the full specs directory.
4. Run the specified checks, commit changes, and write `handoffs/NN-current.md` using `HANDOFF_TEMPLATE.md`.
5. Stop. Do not automatically begin the next wave.

Recommended order: 00 foundation → 01 catalog/inventory → 02 checkout lifecycle → 03 API/persistence → 04 UI → 05 developer controls → 06 tests/deployment. If interface dependencies require a small change to a previous wave, document it in the handoff.

## Non-negotiable product demonstration

Choose an event and a real-looking seat listing; reserve it; observe inventory disappear in another independent shopping session; open the same checkout URL on a second device; change price in either direction; synchronize the hold timer; simulate payment failure/retry; complete once even with competing devices; observe completion navigation; expire a live page (redirect to event); separately navigate to an already-expired link (attempt fresh reservation, otherwise event/root fallback).

## Delivery target

Public Vercel URL, GitHub repo, environment setup, demo walkthrough, and README explaining architecture, tradeoffs, tests and limitations. No actual ticket inventory, real payments, credentials or GameTime branding impersonation.

## Foundation setup (Wave 00)

Requires Node >=22.12 and npm. Validated on Node 24 / npm 11. From the repository:

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000. This wave renders a server-authored foundation page,
with a minimal client-side Query provider and a shadcn-compatible Radix Slot
button. The disabled browse button intentionally has no purchase behavior.
At Wave 00 there was no catalog or Redis adapter. Wave 01 adds those as internal
services. Wave 02 adds framework-independent checkout orchestration and a payment
simulator; production checkout persistence, routes and HTTP APIs remain unimplemented.
No Redis account or secret is required to run the scaffold page.

CI-friendly checks (noninteractive, fail on lint warnings):

```sh
npm run lint
npm run typecheck
npm test
npm run build
# All checks, including the Wave 01 Redis integration suite:
npm run check
# Wave 01: check also runs integration tests and requires local Redis (see below).
# Serve the production build:
npm start
```

`typecheck` generates Next route types before strict TypeScript validation, so it
also works on a fresh clone. Vitest tests environment validation, money/time/version
boundaries and discriminated contract types. Lifecycle tests remain subsequent-wave
work; Wave 01 adds separate real-Redis inventory concurrency tests. `package-lock.json` pins the installed dependency graph.

Architecture:

- `src/domain`: immutable entities, discriminated session states, branded values,
  typed business errors. No framework, persistence client, or side effects.
- `src/application`: repository, inventory, simulator payment, analytics and clock
  ports; checkout service signatures only. Atomic commands replace generic saves.
- `src/infrastructure`: immutable catalog and atomic Redis inventory adapters;
  no memory-backed fake.
- `src/app`, `src/components`: App Router HTML and small client islands. No global
  QueryClient singleton; automatic query/mutation retries are disabled so a later
  UI cannot accidentally retry payment outside service policy.
- `src/lib/env.ts`: pure Zod parsing; `server-env.ts` is the server-only environment
  entrypoint. Redis requires an HTTPS REST URL plus token together. Demo controls
  default off and require an explicit true plus a >=32-character secret. Later
  routes must enforce this configuration; no developer endpoints exist now.

See `docs/STATE_MODEL.md` for deadlines, expiry intent, quote acceptance,
processing protection, recovery, and completion capability rules. Structural types
are not runtime validation of untrusted input; future service/adapters must enforce
the recorded cross-field invariants atomically.

Dependency choices: required stack plus Radix Slot, class-variance-authority,
clsx and tailwind-merge for the local shadcn button pattern; server-only enforces
the environment entrypoint boundary. Wave 01 adds the Upstash client for its Redis
reservation adapter. Playwright remains deferred until its E2E wave. No external
fonts or runtime network calls are needed
for the initial build. Deployment, GitHub publication and E2E delivery remain
later-wave work; nothing has been deployed.

Toolchain note: ESLint 9 is retained to satisfy the Next configuration's React,
import and accessibility plugin peer ranges. npm reports its deprecation; revisit
the coordinated lint stack upgrade when those plugins support ESLint 10.

## Wave 01 — catalog and exclusive inventory

Four explicitly fictional 2027 events and 16 immutable listings live in
`src/infrastructure/catalog/fixtures.ts`. Dates never roll forward automatically.
Assigned seats, GA pools, split constraints, USD unit prices and synthetic
per-ticket fees are explicit. No assets or external images are fetched.

`CatalogService` provides catalog/listing reads, availability, and internal
reservation requests. `RedisInventory` uses server-time Lua for atomic exact-seat
or quantity claims, idempotency, deadline fencing, and inventory sale primitives.
Availability includes contiguous remaining seat runs or remaining GA capacity,
separate owner holds, counts, inventory revision, and `serverNow`. No HTTP/UI or
checkout/payment orchestration was added. See `docs/INVENTORY.md` for consistency
boundaries, schema and integration traps.

Local integration tests require **Redis server and CLI >=6.2**, e.g. on macOS:

```sh
brew install redis
npm ci
npm run test:integration
npm run check
```

You do not need to start a Redis service: the harness launches its own temporary
loopback-only Redis process with persistence disabled, tests isolated namespaces,
and shuts it down. It never touches an existing Redis database or hosted account.
If binaries are not on PATH, set `REDIS_SERVER` and `REDIS_CLI` to their absolute
paths. Missing Redis fails the integration suite rather than silently skipping it.
`npm test` remains the fast unit/contract suite. CI installs Redis explicitly.

For future server composition, `createDemoInventory(namespace)` validates the
existing Upstash REST environment configuration and returns an adapter without
connecting or initializing on import. Explicit `initialize()` seeds missing event
aggregates; it never overwrites existing holds, sold units or orders. Hold policy
is server-owned (aligned to ten minutes in Wave 02). No seeding HTTP endpoint, reset command,
or dependency on live credentials is introduced here.

Security audit follow-up: the previously discussed `braces` advisory propagates
through the Next ESLint development dependencies. Do not force-downgrade the Next
lint configuration. Track the upstream fix; `npm audit --omit=dev` distinguishes
the production dependency audit, and does not mean dev dependencies are fixed.

## Wave 02 — checkout domain and application services

`src/domain/checkout.ts` implements fixed-deadline state transitions, complete-total
price review, retry limits, independent processing protection, expiry and recovery.
`src/application/checkout.ts` orchestrates injected atomic repository operations and
a deterministic payment simulator. `getSession` is read-only; fresh navigation is
the only automatic recovery entrypoint. `reconcile` is the explicit expiry/timeout
mutation. Defaults: hold 10 minutes, processing 60 seconds, metadata retention
30 minutes after hold expiration. Snapshot times come from the repository server.

`acceptedTotal` prevents a reduced pending increase from charging more than was
accepted. Completion now requires an idempotency key and trusted caller binding;
only the original binding gets a stable capability on successful replay. A
server-secret HMAC authority is implemented; no secret is embedded or configured
by default. Confirmation reads require a capability and can be refreshed.

**At the Wave 02 milestone, no production checkout Redis adapter was wired.** Application tests
use a clearly separated test-only transaction model. The existing real-Redis
inventory tests remain separate. Passing model contention tests does not establish
production checkout concurrency safety or durability. See
`docs/CHECKOUT_ATOMICITY.md` for the required Wave 03 transactions, authentication,
secret setup and processing-timeout assumptions. No HTTP/UI or developer control
was added. The app still renders its foundation page.

Run `npm test` for unit/domain/application/model tests, `npm run test:integration`
for standalone real-Redis inventory tests, or `npm run check` for both plus lint,
strict types and production build. Local Redis binary prerequisites are unchanged.

## Wave 03 — persisted checkout and HTTP API

`RedisCheckoutStore` now implements checkout, reservation/processing protection,
attempt/replay and order persistence using a Redis snapshot + conditional Lua
commit. The commit validates every read key and deadline boundary, starts fresh
deadlines from Redis commit time, and publishes all affected records with one
MSET. The hardened v2 layout uses individual checkout/order/receipt records and
listing-level stock, so unrelated listings do not conflict or read historical
purchases. Temporary coordination records have a fixed TTL; successful orders and
completion fences remain durable. Released holds are pruned and sold occupancy is
compacted. See `docs/PERSISTENCE_API.md` for the proof, retention and remaining limits.
V1 namespaces fail closed: use a new isolated namespace for this storage upgrade;
no automatic migration or destructive reset is included.

Nine JSON Route Handlers validate inputs with Zod and call the application
services. `/checkout/[id]` is a dynamic SSR routing boundary with minimal initial
HTML. Responsive checkout/event/confirmation UI and developer controls remain
later-wave work. The homepage is still the foundation page.

Runtime now requires Upstash HTTPS REST credentials plus CHECKOUT_NAMESPACE and
two distinct persistent secrets: CHECKOUT_CALLER_SECRET and
CHECKOUT_COMPLETION_SECRET. Generate each with `openssl rand -hex 32`, put them in
`.env.local`, and run `npm run dev`. Never expose them via NEXT_PUBLIC variables.
Builds do not require credentials. See `.env.example` and
`docs/PERSISTENCE_API.md` for complete setup, request shapes and status codes.

Creation/checkout reads establish a signed HttpOnly caller cookie; complete
requires that cookie and Idempotency-Key. Confirmation credentials travel in a
separate HttpOnly cookie, never ordinary JSON or URLs. Keep the original request
body, cookie and key for a lost-response replay. Polling GET is read-only and
nonrecovering; 410 includes expired snapshot data. Explicit recovery is fresh-only.

`npm run check` now also runs a built Next HTTP/SSR test after the production
build. It requires openssl in addition to local Redis binaries. The actual SDK
uses a test-only TLS REST bridge backed by real Redis. Hosted verification is
separate and was not run without credentials: export `.env.local` and run
`npm run test:upstash`. Its generated test namespace is isolated and cleaned up.
No website has been deployed or pushed to GitHub.

## Wave 04 — shopping and responsive checkout

Event discovery, event listings, checkout and protected booking confirmation now
have a complete responsive interface with locally bundled event imagery. Checkout
summary content is rendered on the server before hydration. TanStack Query polls
live checkout/inventory state approximately every two seconds; a local countdown
uses authoritative server timestamps and monotonic elapsed time. QR/copy/native
sharing opens the same hold on another device.

Price review, savings, processing protection, retryable/nonretryable outcomes and
device-specific completion navigation use the existing APIs. No developer menu or
scenario-mutation endpoint was added. See `docs/UI_INTEGRATION.md` for the UI
contracts, transport correction, local validation and Wave 05 considerations.

Install browser binaries with `npx playwright install --with-deps chromium`, then
run `npm run check` (Redis and openssl prerequisites still apply). Browser tests
use isolated real Redis plus built Next servers and require no hosted credentials.
`npm run test:browser` requires a production build first. Homepage discovery works
without configuration; reserving tickets requires the documented Redis runtime.

Prettier uses the supplied 80-column, two-space, single-quote configuration.
`npm run format` runs ESLint autofixes, then Prettier. ESLint requires braces on
every control-flow body and enforces 1TBS placement, including `} else {`.
Blank lines separate imports from code, declaration groups from work, control-flow
blocks, and returns/throws. Consecutive imports and declarations stay grouped;
additional meaningful blank lines are preserved. Prettier has no settings for
mandatory braces or semantic section spacing, so these rules live in
`eslint.config.mjs` using `@stylistic/eslint-plugin` rather than unsupported
Prettier options. Both `format:check` and `lint` are required by `check`/CI.
The existing source was reformatted for human review. No business-domain or
persistence behavior was refactored as part of formatting.

### Wave 05 developer scenarios

Set server-only `DEMO_MODE=true` and a strong `DEMO_SECRET` in an isolated demo
namespace to enable Developer menu. Unlock each checkout/device with that secret.
The desktop Popover and mobile Sheet control persisted session pricing, 1–30 minute
hold duration, immediate expiration, and a one-shot next-payment outcome. Reset is
namespace-wide, requires typed confirmation, and fences old in-flight requests.
Keep demo mode disabled on unrestricted production; hiding the menu is not its
security boundary. See [developer control contracts](docs/DEVELOPER_CONTROLS.md)
for endpoints, authorization, reset behavior, and hosted validation instructions.
