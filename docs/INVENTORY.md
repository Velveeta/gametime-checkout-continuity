# Wave 01 inventory contracts

## Data and selection

`FixtureCatalog` implements catalog reads with four clearly simulated 2027 events
and 16 listings, runtime-frozen down to allocations/quantity rules. Seed validation
rejects duplicate identities, unknown event references, overlapping physical seat
identities, duplicate GA section pools, malformed seats and invalid quantity rules.
Prices are per ticket, with explicit synthetic per-ticket fees in integer cents;
`quoteSelection` computes a selection total without unsafe integer arithmetic.
All fixtures are synthetic, including seat numbers and floor block descriptions.
Red Rocks reserved rows 5–45 / GA rows 46–69 are this fictional show's configuration.

`Listing` adds `feePerTicket` and `quantityRules: {min,max,increment}`. Valid counts
are min + n × increment, up to max. Allocation quantities describe original pool
capacity, never live availability. `InventorySelection` accepts exact membership
or a quantity request. Quantity selection chooses the first sufficient contiguous
assigned run, or GA units. There is no automatic partial fulfillment or stitching
of separated seats; callers may request a smaller permitted quantity explicitly.
Available runs can be smaller than a listing's minimum split size; they describe
raw availability, while reservation validation still enforces purchase rules.

`CatalogService.availability` returns counts, contiguous available runs, server
UTC time and inventory revision. Own live holds are a separate field, never added
to purchasable availability. Its owner argument is for trusted server callers;
future HTTP routes must establish ownership and avoid exposing reservation/session
IDs for other shoppers. No HTTP API or authentication is implemented in this wave.

## Persistence and atomicity

`RedisInventory` consumes a small EVAL executor interface; the production factory
uses `@upstash/redis`. Each event lives in one JSON document at
`checkout:{namespace}:inventory:eventId` (schemaVersion 1). Namespace validation
prevents key/tag injection. All checkout keys in a namespace can share its Redis
hash tag in later waves. Initialization validates seeds before writing and sets
only absent documents. Existing supported documents are preserved unchanged;
unsupported schemas fail without overwrite. It never scans, deletes or rewrites
order keys. New seed migrations/reset require explicit later implementation.

One Lua execution loads an event, gets Redis TIME, reconciles expired holds,
validates current listing/version/ownership/selection/capacity and writes the
result once. No inventory state is held in process memory. No TTL, notification,
worker, or caller clock authorizes availability. Deadline equality expires a hold;
reads reconcile logically expired reservations without extending deadlines.
Inventory revision is event-scoped and distinct from listing/quote version.

A repeated reservation ID succeeds only for the same owner, listing, selection
and listing version while live. It never extends the deadline or bumps revision.
Expired IDs are fenced permanently; a fresh atomic claim needs a new reservation
ID. Another live reservation for that checkout owner conflicts. Sold records stay
sold; matching sale/order replay is idempotent, different orders/owners conflict.
Conservation is original capacity = available + held + sold.

The event aggregate deliberately trades scale for inspectable atomic correctness
in a small demo. Reads and mutations scan its reservation history. Expired records
are retained as replay fences, and sold records remain durable; there is no pruning
or TTL in this wave. This is not an unbounded marketplace inventory design.

## Later-wave integration requirements

`ReservationRepository` methods are internal inventory primitives. `reserve` does
not create a checkout session; `commitSale` marks inventory sold but creates no
order. Do NOT expose either as a production checkout API or compose them with
session/order writes using sequential calls. The exported `INVENTORY_LUA_CORE`
contains write-free helpers for the future checkout repository to compose
reservation + session creation and sale + order creation in single Lua executions.
Validate all conditions before writes: Redis scripts isolate execution but do not
roll back earlier writes after an error.

Wave 02 must add the atomic completion claim and separate processing deadline,
then lock the claimed quote/attempt. The core recognizes a future
`processingDeadlineMs` on a HELD record but provides no method to set it yet.
Only that claim may establish payment protection; regular reads/replays must not.
Current sale primitives only require a live owned hold, so the future composition
must additionally enforce PROCESSING/attempt/quote/order/capability invariants.
Use persisted current quote data for repricing; fixture prices are seed values,
not a mutable price authority. Checkout recovery must choose a new session/claim,
while preserving existing session terminal semantics.

`DemoInventoryReset` is a contract only. Wave 05 must enforce explicit DEMO_MODE,
authenticate the secret and require destructive confirmation before implementing
an atomic reset restricted to the configured namespace. No reset implementation
or route exists now.

## Source notes (configuration context, not real offers)

Venue references checked 2026-10-19; specific dates/seats/prices are fictional:

- AT&T Stadium guest seating map: https://attstadium.com/wp-content/uploads/2020/09/20GuestGuide_Final-2.pdf
- MSG Knicks seat map: https://msg.com/madison-square-garden/seating/msg-knicks
- Red Rocks FAQ (configuration varies per event): https://www.redrocksonline.com/plan-your-visit/faq/
- Wrigley general-admission bleachers: https://www.mlb.com/cubs/ballpark/information/guide
- Redis Lua atomic execution: https://redis.io/docs/latest/develop/programmability/eval-intro/
- Upstash EVAL SDK: https://upstash.com/docs/redis/sdks/ts/commands/scripts/eval
