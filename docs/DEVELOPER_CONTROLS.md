# Wave 05 developer controls

The checkout has a desktop Radix Popover and mobile right-side Radix Dialog/Sheet,
sharing one controls component. Mutations receive a sticky, aria-live status toast
inside the active menu. The menu is rendered only when `DEMO_MODE=true`.
Radix provides keyboard dismissal, focus management, and modal focus trapping on
mobile. No developer action runs during navigation, rendering, or initialization.

## Enable and unlock

Use an isolated synthetic-data namespace. Set server-only `DEMO_MODE=true` and a
random `DEMO_SECRET` of at least 32 characters (`openssl rand -hex 32`). Existing
Redis/caller/completion environment variables are still required. Never set a
`NEXT_PUBLIC_` secret. Keep demo mode disabled on unrestricted production.

Open a checkout, open Developer menu, and enter the secret. It is sent over the
same-origin JSON authorization endpoint and immediately cleared from input state
on success. It is never bundled, placed in URLs, or stored in browser storage.
The response sets a one-hour HttpOnly, SameSite=Strict cookie (Secure in production),
HMAC-bound to the exact session, active data generation, and server-enforced expiry.
Each device/session must unlock separately. Rotating DEMO_SECRET revokes grants.
Knowing or sharing a checkout URL alone grants no developer access.

Disabled endpoints return 404 before opening Redis; enabled but unauthenticated
requests return 403. Every mutation uses the ordinary transport's same-origin,
JSON-size, and strict Zod validation. Responses are private/no-store. A version
conflict returns 409; refresh shared state before making another intentional change.
These tools are for trusted assessors/operators, not a multi-user admin system.
Anyone entrusted with DEMO_SECRET can authorize a checkout and deliberately reset
the configured demo namespace; do not share that secret with untrusted shoppers.

## JSON endpoints

All paths start `/api/demo/checkouts/[id]`.

| Method/path       | Body                                                                                                  | Result                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| POST `/authorize` | `{secret}`                                                                                            | Scoped authorization cookie                |
| GET `/`           | None                                                                                                  | `{checkout, configuration}`; read-only     |
| POST `/`          | `{expectedVersion, action:"PRICE", direction:"INCREASE"\|"DECREASE"}`                                 | Checkout snapshot                          |
| POST `/`          | `{expectedVersion, action:"DEADLINE", minutes:1..30}`                                                 | Checkout snapshot                          |
| POST `/`          | `{expectedVersion, action:"EXPIRE"}`                                                                  | Expired snapshot; hold released atomically |
| POST `/`          | `{expectedVersion, action:"PAYMENT", scenario:"SUCCESS"\|"TRANSIENT_FAILURE"\|"DECLINED"\|"DEFAULT"}` | Checkout snapshot                          |
| POST `/reset`     | `{confirmation:"RESET DEMO DATA"}`                                                                    | `{reset:true}`                             |

Versioned operations are rejected while processing or terminal; they cannot revive
expired stock. Price controls change only this checkout's per-ticket override by
10%, at least $1, floored at $0. Fees are recalculated through the existing domain
quote function and stay included. Catalog/listing prices and unrelated carts do
not change. Increases require exact acknowledgement; decreases auto-apply.

Duration edits preserve the session, reservation, acknowledgement, and attempt
history. Lua anchors both session and inventory deadlines to Redis commit time,
not an application clock or stale client timestamp. Ordinary activity still never
extends a hold. Expire-now uses the domain transition and atomic inventory release.

Payment overrides are one-shot. The atomic payment claim copies the configured
outcome to its attempt record and consumes it back to DEFAULT in the same commit.
The application passes this frozen value to the payment simulator; replay cannot
consume it twice. DEFAULT means the configured PAYMENT_SCENARIO (normally SUCCESS).
A transient timeout conclusively simulates noncapture, permitting an explicit retry.
Clearing a scenario does not clear attempts or loosen the three-attempt limit.

## Reset and persistence

Reset warns about all checkouts and confirmations and requires typing the exact
confirmation phrase. It resets only the configured namespace, not the Redis database.
Catalog events remain immutable fixtures; fresh listing/inventory documents restore
prices, quantities, and seating without active holds, sales, or completion receipts.

`checkout:{namespace}:generation:v1` routes to the active data generation. Absent
means the original v2 prefix; after reset, keys use
`checkout:{namespace}:generation:<uuid>:<kind>:v2:<id>`. All keys retain one hash tag.
Normal purchases only read/compare the fence; they never write it or contend on
unrelated session history. Optional `demo` metadata lives with the existing bounded
session document; the frozen `simulation` lives on an attempt. No schema migration
or new credentials are needed for existing local v2 data.

Reset atomically publishes fresh inventory and switches the generation fence.
Every composed instance checks it in snapshot, commit, and seed scripts. An old
request therefore cannot settle payment, restore a reservation, seed old inventory,
or sell into the new generation. Concurrent resets have one CAS winner. Retired
keys are reclaimed with SCAN/UNLINK in bounded batches after the fence; no FLUSHDB,
background worker, process lock, or TTL authorizes this operation. If reclamation
is interrupted, retired keys remain inaccessible; reclaim only the retired prefix
before considering physical cleanup complete. Checkout and event polling discover
the new authoritative state; old checkout URLs return home after reset.

## Verification and next wave

`npm run check` includes Redis-backed domain/API regressions and desktop/mobile
browser scenarios. Tests own disposable Redis processes and never reset configured
hosted data. The local TLS bridge exercises the production SDK against real Redis.
No hosted Upstash credentials are available, so hosted Lua/SCAN/UNLINK behavior
remains unverified. To complete that check, export UPSTASH_REDIS_REST_URL and
UPSTASH_REDIS_REST_TOKEN, then run `npm run test:upstash`: two tests use a generated
`live-test-<uuid>` namespace, including demo persistence, deadlines, one-shot payment,
reset fencing, and cleanup. They delete only their recorded isolated test keys.

Wave 06 should verify hosted operation and deployment environment isolation. Keep
scenario overrides off real payment providers, retain version checks, and preserve
the separation between fresh-navigation recovery and mounted expiration.
