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
services; checkout routes, HTTP APIs and payment integration remain unimplemented.
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
is server-owned (five minutes by default). No seeding HTTP endpoint, reset command,
or dependency on live credentials is introduced here.

Security audit follow-up: the previously discussed `braces` advisory propagates
through the Next ESLint development dependencies. Do not force-downgrade the Next
lint configuration. Track the upstream fix; `npm audit --omit=dev` distinguishes
the production dependency audit, and does not mean dev dependencies are fixed.
