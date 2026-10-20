# Wave 04 UI and synchronization

## Routes and rendering

- `/`: illustrated event discovery, category filters, venue dates and all-in
  starting prices. Seed catalog discovery remains available without Redis
  configuration; this fallback never invents reservable stock or a successful
  payment.
- `/events/[id]`: server-rendered event details, live listing inventory, domain-
  validated seat/quantity options and reservation creation. Prices include fees.
- `/checkout/[id]`: the existing fresh-navigation server policy runs before
  rendering. `TicketSummary` is a Server Component passed through the checkout
  client island. Event, selection, total and reservation context are visible in
  HTML with JavaScript disabled. Client actions hydrate in place. There is no
  page-wide streaming skeleton that obscures this first meaningful content.
- `/orders/[id]/confirmation`: dynamic, refreshable Server Component. The existing
  order-specific HttpOnly confirmation cookie authorizes access. Missing or
  invalid capabilities redirect home. No capability is put in a URL, JSON payload,
  shared checkout, QR code or browser storage. Existing cookie lifetime is seven
  days; order/receipt persistence remains durable.

One responsive checkout route uses a two-column desktop layout and a stacked
mobile layout with summary before payment. Local atmospheric photographs are
illustrative, not views from actual venue seats. All events/bookings remain
fictional and payment is explicitly simulated; no card details are collected.

## Live state

`useCheckout` handles transport/retry identity; the checkout view, countdown and
sharing components have separate responsibilities. TanStack Query reads the
existing checkout endpoint immediately after hydration (also establishing the
signed device cookie), polls approximately every two seconds, and revalidates on
visibility/focus and reconnection. Event listings poll on the same interval.
Mutations cancel in-flight reads before writing their returned snapshots to the
cache, then revalidate. Terminal states stop periodic checkout polling.

Countdown anchors use serverNow plus half the read round-trip time and elapsed
`performance.now()`, never the device's wall clock. A local one-second timer
updates the display; it does not issue one-second network requests. Zero confirms
status through the read-only API. An open checkout observing EXPIRED navigates to
its event, whose authoritative inventory read jointly fences/releases due holds.
No polling request recovers a checkout or extends a hold. A fresh document
navigation alone may invoke the existing SSR recovery policy. Checkout links are
created through explicit reservation navigation, copying or QR; there are no
speculatively prefetched checkout Links.

Price increases require the exact current server quote acknowledgement. Decreases
are applied by the domain and receive a savings notice. A device completing an
acknowledgement synchronizes to other contexts through normal reads. PROCESSING
uses the separate server processing deadline; its tickets remain protected when
the business hold deadline passes.

## Payment and confirmation

There is no client-side payment success shortcut. The existing complete endpoint
owns claim, attempts, settlement and confirmation access. A synchronous submission
guard prevents duplicate UI submissions. A generated request key and its exact
version body are retained in tab-scoped sessionStorage for uncertain transport
retries; no credentials/capabilities are stored there. Confirmed transient
noncapture clears that binding before an explicit new attempt. Definitive decline,
exhaustion and processing timeout show terminal feedback and an event action.
Requests have a 15-second transport timeout; a timeout never means noncapture.

If polling sees COMPLETED while this tab has an uncertain request, it replays that
same key/body once to resolve its authorized receipt. A competing device's key is
rejected; a passive observer goes home. Only a confirmed completing response sets
the protected cookie and navigates to the UI confirmation route. A lost successful
response is covered by browser tests. A new navigation to an already completed
checkout still redirects home under the existing contract.

Cross-device handoff supports a copyable URL, local QR encoding and native Share
where supported. These open the exact session and deadline without a second hold.
For a real phone, the application URL must be reachable from that phone; a
loopback-only local test URL is not a public sharing link.

## Transport correction

Next may reconstruct `request.url` with its internal listening hostname. Same-
origin mutation validation therefore uses the actual Host header and request URL
protocol, falling back to URL origin when Host is absent. It does not trust
arbitrary X-Forwarded-Host or accept the internal origin as an alternative.
Sec-Fetch-Site cross-site requests remain rejected. A real-browser regression and
an API test cover this correction. Persistence and domain interfaces are unchanged.

## Formatting and validation

The requested Prettier settings live in `.prettierrc.json`. `npm run format` writes
formatting; `npm run format:check` verifies it. `npm run check` requires formatting,
lint, strict types, unit tests, real Redis/API tests, production build, built HTTP
integration and Playwright. Existing source was formatted as requested; prior
specifications/handoffs received formatting only. Generated artifacts, dependencies,
lockfile, reports, coverage, minified JS and build output are ignored appropriately.

Browser setup:

```sh
npm ci
npx playwright install --with-deps chromium
npm run check
```

Redis server/CLI >=6.2 and openssl must also be available. Tests start disposable
local Redis processes and built Next servers; no hosted credentials or public
simulation-control routes are needed. Browser scenarios select existing simulator
configuration only on test-owned server processes. Their fixture-only Redis edits
are never exposed over HTTP. Tests delete data only inside their own isolated
Redis process, not a configured or hosted database.

The standard Chromium download was unavailable in this execution environment.
Tests were exercised with Chromium 153 via the optional
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` binary override. The alternate binary is an
external test tool, not a dependency or artifact of the project. No Firefox,
WebKit, physical phone, hosted Upstash, remote CI or deployment verification is
claimed. The production Upstash adapter is exercised through the real SDK and a
local TLS protocol bridge backed by Redis, preserving the Wave 03 boundary.

## Wave 05 integration

Connect authorized demo-only mutation controls to the existing domain/persistence
protocol. Invalidate relevant query keys after a local control operation, while
other devices continue to discover changes through polling. Never mutate React
state as the source of pricing/deadline truth. Keep processing windows, one-order
receipts, fixed business deadlines and fresh-navigation recovery semantics intact.
Do not add any public unguarded scenario or destructive reset endpoint.
