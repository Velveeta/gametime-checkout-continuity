# Wave 02 design record: domain rules and atomic persistence

Wave 03 implements these boundaries through validated optimistic Redis commits;
see `PERSISTENCE_API.md` for current behavior and verified tests. The requirements
below describe the design stage and remain useful integration constraints.

## What runs now

`src/domain/checkout.ts` implements immutable transition decisions. Each decision
contains a session, inventory effects, events and optionally an order. It neither
writes state nor calls a framework, database or payment API. Default policy is a
10-minute hold, metadata retention **30 minutes after expiration**, and 60-second
processing protection. Retention must cover the maximum processing window.

`CheckoutApplication` injects repositories, read-only inventory, catalog, payment,
clock, analytics, identifiers and completion authority. It uses atomic repository
commands exclusively for state-changing operations. Its injected application clock
only adds telemetry observation timestamps; repository `serverNow` determines
all deadlines. An inventory preflight cannot authorize a checkout: only facts
read and validated inside the atomic repository command may do so. The existing
catalog service remains the entrypoint for independent inventory reads.

No production checkout repository, HTTP route, checkout UI or developer control
is wired. The standalone Wave 01 inventory default is aligned to 10 minutes; no
checkout Lua adapter was added or composed into it. The application cannot be
used for persisted checkout until Wave 03 supplies the atomic implementations.

## Pricing and reads

`acceptedTotal` is the current authorized ceiling, initially the quote selected
at reservation; claim also requires its exact quote version. Quote totals include
fees. An increase invalidates acceptance and moves to PRICE_REVIEW. Lower totals
apply automatically and emit `price_decreased`; if a pending increase drops but
still exceeds acceptedTotal, the lower quote remains blocked for acknowledgement.
This preserves the stronger rule that payment never exceeds authorized total.
Equal-total changes advance quote/CAS versions; an unaccepted increase remains
blocked. Accepting requires the exact session **and live persisted quote** version.
Retries and price changes never reset attempts or extend reservation deadlines.

`getSession`/`read` only read and project effective expiry; they never persist,
refresh quotes, reserve or recover. `refreshQuote` is an explicit atomic operation
using live repository pricing; fixtures are seed values. `reconcile` explicitly
persists due expiry/timeout and inventory effects without creating a session.
A read projection can show a newer effective version than storage; the executor
must perform the same reconciliation before checking the next command's CAS.
Only the future authenticated CHANGE_DEADLINE command may explicitly alter the
business deadline/retention. Pure authorization guards and a branded command
contract exist, but no developer-control implementation is exposed.

## Payment, protection and idempotency

The claim must atomically validate live hold ownership, business deadline, CAS,
current quote acceptance, retry count, unique order and request ledger. Only a
new CLAIMED result may invoke payment. It increments the attempt ordinal once and
protects inventory to an independent deadline. All payment outcomes are for that
locked quote and attempt. Definite decline fails terminally; confirmed transient
non-capture permits another attempt only before business expiry and before three
total attempts. A retry requires a fresh idempotency key. Same-key replay returns
the stable operation result, not a new payment; callers may read current state
separately. Unknown outcomes/transport exceptions stay PROCESSING without retry.

`SimulatedPayment` is stateless, with deterministic ordinal-based success,
transient-then-success, persistent transient, decline and unknown scenarios. Its
bounded delay is cosmetic. A success is a **proposal**, not an external capture.
Only guarded atomic settlement commits simulated capture/order/inventory sale.
At processing timeout, atomically fence the attempt and then release inventory;
late results must be rejected even if the same seats were reacquired. This
assumption is sufficient for this simulator, not for a real payment gateway.
Real gateway cancellation/reconciliation would be required before releasing a
possibly captured hold. Business countdown expiry alone never releases a live
protected processing attempt.

The ledger is keyed by session + idempotency key and binds trusted caller ID and
request fingerprint (expected session/quote versions). Changed fingerprints or
caller bindings conflict. Persist ledger + claim/effects together. Competing keys
return in-progress without payment; terminal checkout never reopens. Final
settlement atomically writes one order, inventory sale, terminal session, capability
digest and stable ledger result. Check unique indexes across all keys, not only
one event/listing. Duplicate/late settlement cannot create another order.

`HmacCompletionAuthority` derives an opaque bearer from a stable server secret,
session, caller and request key. Store only its digest against the order. The same
successful initiating caller/key can rederive a lost-response capability after
an authorized replay grant; other devices/keys receive none. Confirmation reads
require order + capability and are refreshable. Never include the bearer in shared
snapshots, analytics or checkout URLs. Wave 03 must provide authenticated caller
binding (e.g. server-established secure cookie), timing-safe digest checks and
secure capability transport. A request body `callerId` is not authentication.
Provision a separate persistent random completion secret; rotating it invalidates
rederived capabilities. Do not wire a default secret or reuse public session IDs.

Analytics delivery is best-effort, nonblocking and contains no capability. Replays
return no new analytics events. Durable exactly-once telemetry is not promised.

## Recovery

Only fresh-navigation intent invokes `recoverExpiredSession`. An already-mounted
page seeing expiry returns its event, or root if the event no longer exists.
Fresh recovery requires retained expired metadata and current inventory/price.
Atomically reserve new inventory, create a new checkout/hold, and link exactly one
successor to the original, regardless of competing request keys/devices. Every
successor starts at zero attempts and the current quote version; no stale
acknowledgements or processing state are copied. Original IDs remain expired.
Unavailable inventory/selection falls back to event; missing metadata to root.
Completed/terminal failed checkout navigations return root. The successful
initiating completion response alone carries confirmation credentials.

## What is tested versus deferred

- Domain tests exercise guarded transitions, exact deadline boundaries, totals,
  acknowledgement versions, timeout fencing and clean state projections.
- Application tests use `tests/support/checkout-model.ts`, a **test-only, synchronous
  in-memory atomic-port reference**, to exercise orchestration, idempotency,
  competing calls/recoveries, and conservation. It is not exported/wired by the
  app and proves neither Redis isolation nor crash/durability behavior.
- Existing real-Redis Wave 01 tests continue to verify standalone inventory
  exclusivity/expiry/sales. They do **not** test checkout claim/settlement/recovery.
- Wave 03 must implement and test every atomic boundary above using real Redis:
  compose inventory helpers with session/order/ledger operations; reconcile
  processing owners jointly before releasing stock; sample Redis TIME inside the
  transaction; preserve replay fences and recovery metadata beyond hold expiry;
  enforce authorization for deadline edits and confirmation reads. Do not call
  reserve/sale followed by separate session/order saves, and do not expose the
  standalone sale primitive as completion. Validate and migrate the new required
  acceptedTotal field for any persisted checkout records before use.
