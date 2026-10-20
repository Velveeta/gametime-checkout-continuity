# Checkout state model — Wave 02 domain rules

The lifecycle domain and application service now exist. Production checkout
persistence remains deferred to Wave 03; see `docs/CHECKOUT_ATOMICITY.md`. `src/domain/models.ts` is the canonical shape;
`src/application/ports.ts` defines atomic boundaries and
`src/application/checkout-service.ts` defines caller-facing service contracts.

## Authority and value rules

Redis owns sessions, reservations, inventory, and orders. The repository evaluates
server time atomically with mutations. `Clock` supports server-side presentation
and deterministic tests; caller time never authorizes inventory/payment changes.
Every snapshot includes `serverNow`. Client countdowns display an estimate and
reconcile with the server; neither clocks nor expiry notifications prove expiry.

Money uses non-negative safe integer cents (USD in this prototype). A quote's
subtotal plus fees must equal its total without overflow. Versions are positive,
monotonic integers; session CAS versions and quote versions are distinct.
Times use canonical UTC ISO strings; events retain an IANA display zone.
Assigned selections are nonempty, unique, ascending contiguous seats in one row;
GA quantities are positive integers. Service validation must check selection
membership, listing/event consistency, totals and deadline ordering at ingress.
Type assertions or persisted JSON cannot replace that validation.

## Transitions

| From                                    | Trigger and atomic preconditions                                                                      | To / inventory effect                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| No session                              | Current listing/version, valid selection, availability                                                | ACTIVE; reserve selected inventory and create session together                                                                         |
| ACTIVE, PAYMENT_RETRYABLE, PRICE_REVIEW | Higher current quote while live                                                                       | PRICE_REVIEW; invalidate previous acceptance                                                                                           |
| ACTIVE, PAYMENT_RETRYABLE, PRICE_REVIEW | Lower current quote while live                                                                        | Auto-apply lower quote and show positive message; remain PRICE_REVIEW if still above acceptedTotal, otherwise ACTIVE/PAYMENT_RETRYABLE |
| PRICE_REVIEW                            | Accept exact current quote version and session CAS while live                                         | ACTIVE or PAYMENT_RETRYABLE according to prior attempts; acknowledge exact version                                                     |
| ACTIVE, PAYMENT_RETRYABLE               | Current owned reservation, now < business deadline, current quote accepted if increased, attempts < 3 | PROCESSING; increment attempt once, create attempt ID and separate processing deadline                                                 |
| PROCESSING                              | Successful result for matching claimed attempt before processing deadline                             | COMPLETED; create one order and sell inventory atomically                                                                              |
| PROCESSING                              | Confirmed transient failure, attempts < 3, business reservation still live                            | PAYMENT_RETRYABLE; remove processing protection, retain original reservation deadline                                                  |
| PROCESSING                              | Confirmed transient failure after business deadline, attempts < 3                                     | EXPIRED; release inventory                                                                                                             |
| PROCESSING                              | Decline, third transient failure, or processing timeout                                               | PAYMENT_FAILED; release inventory                                                                                                      |
| ACTIVE, PRICE_REVIEW, PAYMENT_RETRYABLE | now >= reservationExpiresAt                                                                           | EXPIRED; release inventory                                                                                                             |
| EXPIRED                                 | Fresh-navigation recovery with retained metadata and current availability                             | Create ONE new ACTIVE session/reservation and link recovery atomically; original remains EXPIRED                                       |

Equal quote totals with a changed version also invalidate stale completion CAS;
if the session still has an unaccepted increase, it stays PRICE_REVIEW. Price
refresh/acceptance never resets paymentAttemptCount. A new increase always
requires exact-version acceptance. If accepting a price after a transient failure,
restore PAYMENT_RETRYABLE, preserving the attempt count. Version changes during
PROCESSING cannot rewrite that attempt's locked quote.

Deadline equality means expired. `reservationExpiresAt` is fixed at creation;
reads, polls, quote changes, acceptance, retry, analytics and navigation never
extend it. Only an explicit future guarded developer action may change it.
`recoveryRetainUntil` outlives the reservation, including processing protection;
its duration and all other durations are server-owned configuration.

## Processing protection and competing callers

The claim checks reservation ownership, live deadline, current quote and CAS in
one atomic operation. Only one device can claim an attempt. Processing protection
is a separate inventory exclusion through `processingDeadlineAt`, even if the
business hold expires meanwhile. Duplicate claims return in-progress/conflict;
they never initiate another payment or extend either deadline. Settlement checks
the matching attempt ID, PROCESSING status and processing deadline atomically.
Late, duplicate and stale settlements cannot sell seats or create another order.
Availability queries must honor live processing protection and ignore expired
holds even when Redis keys remain.

Only confirmed transient failures permit another attempt, with three total
attempts maximum. UNKNOWN outcomes stay PROCESSING without automatic retry until
resolved or the processing deadline fails the session. Payment idempotency uses
the stable attempt ID. Domain completion and inventory sale are atomic together;
real payment gateway reconciliation is explicitly out of scope.

## Navigation, recovery and order access

`enter` receives explicit FRESH_NAVIGATION or MOUNTED_REFRESH intent:

- A mounted page crossing its business deadline redirects to the associated
  event, or home if the event no longer exists. It never silently recovers.
  A PROCESSING page remains protected until settlement/processing timeout.
- A fresh navigation to an EXPIRED session attempts reservation at current price
  and availability while recovery metadata remains. Recovery is idempotent across
  devices: the original expired session links to one replacement; request keys
  alone must not allow multiple replacements. Redirect to that new checkout.
  If unavailable or metadata is gone, redirect to the event, then home if unknown.
- COMPLETED and PAYMENT_FAILED sessions redirect home; never reopen checkout.
  Successful initiating completion instead navigates to capability-protected
  confirmation. EXPIRED is terminal for its original reservation; it has only the
  explicit recovery exception above.

Completion capabilities are unguessable and scoped to one order; only their digests
are persisted. Initial settlement or an authorized replay grant to the same
initiating caller/idempotency key permits the application to derive the bearer.
Other caller bindings/keys cannot recover it. Tokens are absent from shared
snapshots, analytics and public checkout URLs; session-ID knowledge does not
permit confirmation. Use secure caller-bound HTTP transport in Wave 03, never a
capability in a URL. Confirmation is refreshable with the capability. Production
caller authentication and Redis ledger/digest persistence are not implemented yet.

`getSession`/`read` project expiry without mutations or recovery. Explicit
`reconcile` commits due fencing/release via the atomic repository contract.
Default hold is 10 minutes; recovery metadata lasts 30 minutes after expiration;
processing protection defaults to 60 seconds. The application clock is telemetry
only, while each repository operation must obtain authoritative server time.
