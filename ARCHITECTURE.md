# Architecture and consistency boundaries

## Ownership

- `src/domain`: pure checkout transitions, selection rules, integer-cent pricing,
  branded time/version values, typed errors. No React/Next/Redis imports.
- `src/application`: checkout orchestration and atomic repository/payment/analytics
  ports; guarded demo service. Dependency injection keeps the rules testable.
- `src/infrastructure/redis/checkout-store.ts`: production v2 checkout/inventory,
  attempt, receipt, order and reset persistence. `transactions.ts` fences and
  publishes proposals through Lua. `compose.ts` creates fresh services per request.
- `src/app`: dynamic server-rendered routes and validated HTTP adapters.
  `src/components/checkout`: focused countdown, payment, sharing, and developer
  controls; React never owns reservation or financial truth.
- `tests/support/checkout-model.ts`: test-only in-memory transactional model.
  `RedisInventory` is the earlier standalone reservation adapter; the running app
  uses the integrated RedisCheckoutStore, not two independent stock ledgers.

## SSR and synchronization

The canonical route is `/checkout/[id]`; mobile and desktop use the same session.
Server navigation invokes the explicit fresh-navigation policy before rendering
TicketSummary, pricing, status and expiration context. A Server Component summary
is passed through the Client Component shell. No page-wide streaming skeleton
obscures the initial summary. A JavaScript-disabled browser test verifies actual
visible event/listing and checkout content; JSX alone is not the evidence.

Initial data hydrates into TanStack Query. Reads establish the signed device cookie,
poll roughly every two seconds, and refetch on focus/reconnection. Periodic polling
stops at terminal checkout states. Mutations cancel competing reads, update the
cache from returned snapshots, then invalidate. Countdown uses serverNow, a read
round-trip estimate, and `performance.now()`; local wall-clock changes do not
extend it. The one-second timer changes only presentation.

Only a fresh document navigation may recover expired intent. Ordinary reads
project expiry without creating sessions or changing a deadline. The mounted
page returns to the event; its inventory read jointly reconciles/fences due holds.
Recovery selects one successor across competing requests, with fresh pricing,
acknowledgements and attempt history. Missing intent or completed checkout goes home.

## Atomic persistence

The adapter discovers a small routing set, rereads it atomically with Redis TIME,
and computes a proposal using the existing pure domain functions. Commit Lua:

1. Validates every observed value, absent key, and active reset generation.
2. Rejects proposals crossing the next reservation/processing/recovery boundary.
3. Anchors new/explicitly changed hold deadlines and processing protection to commit
   time; normal activity preserves existing business deadlines.
4. Encodes all outputs before one MSET, including inventory changes, session,
   bounded attempts/replay records, and any order/permanent completion receipt.
5. Applies absolute TTLs only to temporary coordination metadata.

CAS conflicts retry from a new authoritative snapshot. No process-local mutex,
client timestamp, background timer, Redis key TTL, or eventual replica authorizes
stock ownership. EVAL reads use the primary. All explicit keys share `{namespace}`.

Per-listing inventory documents contain active reservations and compact sold seat/
quantity occupancy. Per-session documents hold at most three payment attempts and
replay entries. Orders and completed-session receipts are separate durable keys.
Unrelated listings do not compare one growing namespace aggregate. Cost still
scales with a listing's stock/live holds; it is a scoped prototype, not unlimited
throughput. Do not enable eviction or manually delete durable records.

## Payment and capabilities

Claim checks the current total including fees, exact acknowledgement, session
version, hold ownership, original deadline, and permanent order fence. A successful
claim starts a separate processing window before calling the simulator. One-shot
demo outcomes are frozen on that attempt. Only confirmed transient noncapture
permits a new key; definitive declines and unknown outcomes do not. Maximum:
three total claims, not three retries.

Settlement must match the claimed attempt, caller/key, and processing fence. One
order per session holds even across different keys. A lost successful response
replays the exact original key/body; different callers/keys receive no confirmation
capability. The browser stores only its tab-scoped request binding, not credentials.
An HttpOnly cookie grants refreshable access to `/orders/[id]/confirmation`.
Passive observers and losing contenders go home. Order IDs alone grant no access.

The simulated payment's success is a proposal; only atomic settlement creates a
simulated sale. A real provider needs its own idempotency/capture reconciliation,
webhooks, and durable work scheduling. Fencing this Redis adapter alone cannot undo
an external capture. Demo reset must never be enabled for a real payment integration.

## HTTP surface

| Route                                                  | Purpose                                                |
| ------------------------------------------------------ | ------------------------------------------------------ |
| GET `/api/events` / `/api/events/[id]`                 | Synthetic catalog                                      |
| GET `/api/events/[id]/listings`                        | Current listing prices and availability                |
| POST `/api/checkouts`                                  | Validate event/selection/version; atomically reserve   |
| GET `/api/checkouts/[id]`                              | Read-only snapshot/server time; expired data uses 410  |
| POST `/api/checkouts/[id]/acknowledge-price`           | Accept exact current quote                             |
| POST `/api/checkouts/[id]/complete`                    | Versioned claim/settlement/replay with Idempotency-Key |
| POST `/api/checkouts/[id]/recover`                     | Explicit FRESH_NAVIGATION recovery                     |
| GET `/api/orders/[id]/confirmation`                    | Capability-protected order                             |
| `/api/demo/checkouts/[id]` plus `/authorize`, `/reset` | Guarded scenario controls                              |

Zod validates bounded JSON; same-origin checks use public Host rather than Next's
internal listening hostname. Cross-site writes are rejected. Responses are private/
no-store. Typed errors distinguish invalid input, unauthorized capability, conflicts,
expiration and service failure. Caller binding is signed server-side and cannot be
supplied as an arbitrary completion body field. These cookies are demo identity,
not real buyer authentication.

## Reset, telemetry, and deployment

Reset is explicit and namespace-wide. It atomically switches a generation fence
and seeds new fixture inventory, then reclaims the retired generation in batches.
Old instances cannot write or settle into the new inventory. Interrupted cleanup
leaves inaccessible keys; consistency does not depend on completing reclamation.
See [developer contracts](docs/DEVELOPER_CONTROLS.md) for exact key conventions.

ConsoleAnalytics maps typed transition events to the reviewer-facing funnel names
without renaming domain contracts. Navigation and demo mutations add observations;
source surfaces are server-established. The allowlisted log payload excludes
credentials. Delivery remains best effort: no durable outbox or exact funnel count
is claimed. Inventory-only lazy expiry cleanup may not emit an analytics event.

Vercel runs Node Route Handlers/Server Components; Upstash's HTTPS client needs no
persistent TCP connection. Runtime compositions share Redis, not local memory.
Fixtures seed missing initial data idempotently and do not overwrite active holds
or sales. See [deployment instructions](docs/DEPLOYMENT.md) and
[acceptance matrix](docs/ACCEPTANCE_MATRIX.md) for verified scope and external gates.
