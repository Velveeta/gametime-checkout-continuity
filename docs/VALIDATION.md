# Wave 06 validation and readiness

Updated: 2026-10-21.

The application is deployed to Vercel and has been manually exercised. Both
hosted Upstash tests and all 27 local Playwright tests have passed. Local
automated validation, hosted Redis validation, and manual deployment checks
are distinguished below.

## Commands and results

| Command                       | Result                                                     | Scope                                                                               |
| ----------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `npm ci`                      | Passed, 461 packages installed                             | Clean lockfile installation                                                         |
| `npm run format`              | Passed                                                     | ESLint brace/spacing fixes followed by Prettier                                     |
| `npm run format:check`        | Passed                                                     | Supplied 80-column formatting configuration                                         |
| `npm run lint`                | Passed, zero warnings                                      | Includes required braces/1TBS and section spacing                                   |
| `npm run typecheck`           | Passed                                                     | Next route types and strict TypeScript                                              |
| `npm test`                    | 123 passed across 12 files                                 | Pure domain, deterministic application models and adapter/helper contracts          |
| `npm run test:integration`    | 70 passed                                                  | Actual disposable Redis, production Lua/SDK adapters and HTTP application adapters  |
| `npm run build`               | Passed                                                     | Production Next.js build; dynamic checkout/event routes                             |
| `npm run test:http`           | One passed                                                 | Built server routes over HTTP with real Redis behind the REST bridge                |
| `npm run test:browser`        | 27 passed                                                  | 22 checkout and five developer-menu journeys in Chromium                            |
| `npm run check`               | Passed during original Wave 06 validation                  | Complete local gate; subsequent fixes validated separately                          |
| `npm audit --omit=dev --json` | Zero production vulnerabilities                            | Audit at validation time                                                            |
| `npm audit --json`            | Five high advisories, development dependencies             | Existing `braces` → lint-toolchain dependency chain; see below                      |
| Hosted Upstash tests          | Two passed, confirmed by the project owner                 | Hosted SDK/EVAL transport, competing claims, completion/replay, deadlines and reset |
| GitHub Actions                | Remote result not recorded here                            | Workflow configured; inspect the repository Actions tab for current status          |
| Deployed smoke tests          | Manual deployed-app testing confirmed by the project owner | Vercel application exercised; no automated deployed-site E2E run claimed            |

The latest recorded passing local suite counts total **221 tests**:
123 unit, 70 integration, one built HTTP, and 27 browser tests. These results
were established across successive validation runs, not a claimed single final
invocation of `npm run check`. The two hosted Upstash tests are additional and
are not included in that local total. The final 27-test browser run and hosted
results were confirmed by the project owner.

Browser emulation is not a physical-device test. The
[acceptance matrix](ACCEPTANCE_MATRIX.md) supplies requirement-level evidence;
the [deployment guide](DEPLOYMENT.md) documents account/configuration and smoke
procedures. Keep those documents consistent with this updated record.

Desktop discovery/checkout, mobile checkout with QR/copy, and developer
Popover/Sheet and responsive select drawer screenshots were visually reviewed. No meaningful clipping or
layout regression was found at the tested viewport sizes.

## Reproduction and environment

The implementation environment used Node 24.19.0, npm 11.9.0, Redis 6.2.14 and
Chromium 153.0.8010.0. These are not necessarily the versions on the project
owner's machine or in the deployed runtime.
Use the lockfile. With Redis server/CLI and openssl on PATH:

```sh
npm ci
npx playwright install --with-deps chromium
npm run check
```

The harness starts its own disposable Redis process and TLS REST bridge. It
exercises the production Upstash SDK, Redis TIME, Lua scripts, CAS, TTL and cleanup
against actual Redis, including independent service/server instances. The bridge
does not reproduce Upstash hosting, account permissions, network failover or quotas.
Domain/application unit tests additionally use deterministic in-memory models;
those results alone are not proof of Redis concurrency safety.

This environment supplied Redis binaries outside the repository using
`REDIS_SERVER=/path/to/redis-server` and `REDIS_CLI=/path/to/redis-cli`.
The normal Playwright download endpoint returned an unavailable response, so the
browser gate used a separately provisioned Chromium through
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium`. It ran real browser
assertions, not mocks; Playwright's preferred bundled browser version, Firefox,
WebKit, physical phones and screen readers were not tested. None of these
environment-specific binaries are shipped in the source archive.

The production build was also run with non-secret Redis/caller/completion/demo
marker values. Scanning generated client assets found none of those values.
Missing hosted credentials do not block compilation; runtime checkout validates
its configuration before use. All server-rendered live data routes remain dynamic.

### Running browser tests separately

Browser tests start their own production Next.js server. Stop the development
server using the same project directory, then rebuild before running:

```sh
npm run build
npm run test:browser
```

Rebuild after source changes. A missing `.next` production build causes setup
failure before checkout assertions run.

### Running hosted Upstash tests

With actual read/write REST credentials in `.env.local`:

```sh
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run --config vitest.upstash.config.ts
```

These tests use an isolated generated `live-test` namespace rather than resetting
the configured demo namespace. Both tests passed against the project owner's
Upstash database after the persistence compatibility fixes below.

## Findings and corrections

- Cached availability could leave Reserve enabled after a refresh failed, despite
  an error message. It now disables until authoritative availability recovers.
  Browser coverage asserts the failure, retry, empty response and recovery.
- Required funnel names were not consistently exposed in logs, and navigation
  lacked a resume observation. A framework-independent observation helper and
  allowlisted console adapter normalize the nine specified names, add source
  surface, and distinguish navigation from ordinary polling. Developer price/
  expiration observations use committed versions. Delivery stays best effort;
  a telemetry failure never changes purchase correctness.
- Added a genuine competing-device browser journey using different completion
  keys. It checks two responses, one durable Redis order and attempt, one
  confirmation destination, observer navigation and sold inventory.
- The retention regression previously assumed a payment completed within a 50ms
  test window. It now explicitly asserts completion and uses practical fixture
  windows while still waiting for actual metadata deletion and checking durable
  sold inventory/single recovery successor. An initial full run exposed this
  fixture failure; the corrected full gate passed. No assertion was removed.
- Browser context disposal uses a separate teardown budget and parallel close;
  scenario assertions retain their existing timeouts. A stale generated Turbopack
  cache was cleared before the successful build; no persisted application data
  was deleted.

### Hosted Redis compatibility

Live Upstash testing exposed serialization differences not reproduced by the
initial local Redis tests:

- Missing positional commit values now use `false` placeholders instead of JSON
  `null`, preserving proposal positions when decoded by the hosted Lua runtime.
- Empty reservation dictionaries returned as JSON arrays are normalized to
  objects before adding UUID-keyed reservations. Named properties added to a
  JavaScript array would otherwise be lost during serialization.
- Malformed nonempty reservation arrays are rejected rather than silently
  discarded.
- Regression tests cover positional preservation, reservation persistence,
  competing claims, completion/replay, inventory conservation and malformed
  persisted data.

Both hosted tests subsequently passed. This verifies their exercised scenarios
against the hosted service; it does not establish untested failover, capacity
or account-limit behavior.

### Responsive select and scrolling

- A shared responsive select retains native selection on desktop and uses an
  accessible bottom drawer on mobile. Consumers share the same controlled value
  and do not implement their own viewport-specific behavior.
- Browser tests cover mobile selection, selected inventory submission,
  keyboard/focus behavior and value preservation across viewport changes.
- Drawer options use a bounded native CSS scroll container, keeping the heading
  and Done button visible. There are no application-level wheel or touch
  handlers for scrolling.
- A regression test exercises wheel and touch scrolling in mobile Chromium
  emulation, reaches the final seat and checks that the page behind the drawer
  stays stationary.

The final project-owner browser run passed all 27 tests. These fixes did not
relax checkout, inventory, recovery or payment invariants and introduced no
new runtime dependencies.

## Manual and deployed verification

The project owner confirmed the following behavior during manual testing:

- A successful booking removed purchased tickets from available inventory.
- A checkout opened in an independent browser retained its selected tickets
  and synchronized countdown.
- Completing payment in the second browser produced the expected booking
  behavior while the original observing browser returned to the landing page.
- The mobile selection drawer and its scrolling behavior were reviewed and
  improved.
- The Vercel deployment was opened and manually exercised successfully.

The browser scenarios above were exercised during local/manual testing. The
deployed-app confirmation is a separate manual smoke result; it does not mean
every automated scenario was repeated against Vercel.

Automated browser tests ran against a locally started production server. No
automated deployed-site E2E run, comprehensive physical-device audit or load
test is claimed.

## Security and dependency review

Runtime variables are server-only and validated. Developer endpoints require
explicit opt-in, same-origin JSON, and a session/generation-bound signed unlock;
disabled mode returns 404. Tests cover malformed requests, unauthorized/cross-origin
access, stale versions, reset fencing and confirmation capability isolation.
The menu being hidden is not the authorization boundary.

No populated environment file was tracked in the reviewed implementation. A targeted scan of local Git history
found no private-key/token patterns, and the client-build marker scan found no
server secret values. These are scoped checks, not a comprehensive secret-scanning
certification. Review the repository before publishing; never add real `.env.local`.

At the recorded audit, five high development advisories affected the existing `braces`/`micromatch`/
`fast-glob`/Next lint-config chain. The production audit reported zero. npm's proposed
forced fix downgrades the Next lint configuration across major versions; it was
not applied. Audit results are time-sensitive; rerun for current findings and review a
compatible toolchain upgrade. Do not
mistake rerunning `npm audit` for remediation or use `--force` blindly.

## Remaining limitations

- **Remote verification:** hosted Upstash tests and manual Vercel smoke testing
  have passed. Remote GitHub Actions results and automated tests against the
  deployed site are not recorded here.
- **Device/accessibility:** keyboard controls, labels, focus containment and
  responsive Chromium layouts and emulated touch scrolling are covered;
  comprehensive physical-phone QR/deep-link behavior,
  assistive technology and additional engines require manual verification.
- **Synthetic payments and security:** no real inventory, buyer authentication,
  provider, emails or tickets. A real provider needs stable provider idempotency,
  webhook reconciliation and safe treatment of uncertain capture; a Redis timeout
  cannot undo an external charge. Confirmation capability is demo-grade.
- **Operations/scale:** durable Redis must be non-evicting. Scoped listing CAS and
  bounded temporary histories avoid namespace-wide purchase-history contention,
  but no load/failover/SLA benchmark is claimed. Add capacity tests, rate limits,
  backup/recovery policy and production authorization before real commerce.
- **Telemetry/reset:** logs are best effort, without a durable outbox or dedicated analytics
  reporting store; use durable orders as
  conversion truth. Interrupted reset cleanup can retain fenced inaccessible keys;
  logical invalidation is atomic. Never share a demo namespace with real data.

No unresolved critical code failure is known from the recorded validation.
Before submission, confirm the actual GitHub/Vercel links, assessor access,
image attribution, current dependency advisories and private developer-menu
instructions. Keep the README and acceptance matrix consistent with this record.
