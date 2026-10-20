# Wave 06 validation and readiness

Date: 2026-10-20. Source is prepared for assessment review. Local verification and
external deployment verification are separate gates. No GitHub remote, account-owned
Upstash credentials, Vercel project, or deployment URL was available in this run.

## Commands and results

| Command                                         | Result                                         | Scope                                                                              |
| ----------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `npm ci`                                        | Passed, 461 packages installed                 | Clean lockfile installation                                                        |
| `npm run format`                                | Passed                                         | ESLint brace/spacing fixes followed by Prettier                                    |
| `npm run format:check`                          | Passed                                         | Supplied 80-column formatting configuration                                        |
| `npm run lint`                                  | Passed, zero warnings                          | Includes required braces/1TBS and section spacing                                  |
| `npm run typecheck`                             | Passed                                         | Next route types and strict TypeScript                                             |
| `npm test`                                      | 123 passed across 12 files                     | Pure domain, deterministic application models and adapter/helper contracts         |
| `npm run test:integration`                      | 67 passed across four files                    | Actual disposable Redis, production Lua/SDK adapters and HTTP application adapters |
| `npm run build`                                 | Passed                                         | Production Next.js build; dynamic checkout/event routes                            |
| `npm run test:http`                             | One passed                                     | Built server routes over HTTP with real Redis behind the REST bridge               |
| `npm run test:browser`                          | 24 passed                                      | 19 checkout and five developer-menu journeys in Chromium                           |
| `npm run check`                                 | Passed                                         | Complete gate, in the order above from formatting through browser tests            |
| `npm audit --omit=dev --json`                   | Zero production vulnerabilities                | Audit at validation time                                                           |
| `npm audit --json`                              | Five high advisories, development dependencies | Existing `braces` → lint-toolchain dependency chain; see below                     |
| `node --env-file=.env.local --run test:upstash` | Not run: credentials unavailable               | Two opt-in hosted tests; not included in the local pass total                      |
| GitHub Actions                                  | Not run remotely                               | Workflow configured; no remote repository connected                                |
| Deployed smoke tests                            | Not run                                        | No deployment or URL created                                                       |

**215 tests passed locally.** Browser emulation is not a physical-device test.
The [acceptance matrix](ACCEPTANCE_MATRIX.md) supplies requirement-level evidence;
the [deployment guide](DEPLOYMENT.md) supplies exact remaining account/configuration
and smoke-test steps.

Desktop discovery/checkout, mobile checkout with QR/copy, and developer
Popover/Sheet screenshots were visually reviewed. No meaningful clipping or
layout regression was found at the tested viewport sizes.

## Reproduction and environment

Validated with Node 24.19.0, npm 11.9.0, Redis 6.2.14 and Chromium 153.0.8010.0.
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

No checkout state, atomic persistence, recovery or payment business contract was
relaxed. No new runtime dependency or feature beyond Wave 06 was introduced.

## Security and dependency review

Runtime variables are server-only and validated. Developer endpoints require
explicit opt-in, same-origin JSON, and a session/generation-bound signed unlock;
disabled mode returns 404. Tests cover malformed requests, unauthorized/cross-origin
access, stale versions, reset fencing and confirmation capability isolation.
The menu being hidden is not the authorization boundary.

No populated environment file is tracked. A targeted scan of local Git history
found no private-key/token patterns, and the client-build marker scan found no
server secret values. These are scoped checks, not a comprehensive secret-scanning
certification. Review the repository before publishing; never add real `.env.local`.

The five high development advisories are npm's existing `braces`/`micromatch`/
`fast-glob`/Next lint-config chain. Production audit reports zero. npm's proposed
forced fix downgrades the Next lint configuration across major versions; it was
not applied. Review the advisory/toolchain upgrade before submission; do not
mistake rerunning `npm audit` for remediation or use `--force` blindly.

## Remaining limitations

- **External readiness gate:** create account-owned Upstash, run the two hosted
  tests, publish to your GitHub account, configure Vercel and perform deployed smoke
  tests. No hosted atomicity or production URL is represented as verified here.
- **Device/accessibility:** keyboard controls, labels, focus containment and
  responsive Chromium layouts are covered; actual phone QR/deep-link behavior,
  assistive technology and additional engines require manual verification.
- **Synthetic payments and security:** no real inventory, buyer authentication,
  provider, emails or tickets. A real provider needs stable provider idempotency,
  webhook reconciliation and safe treatment of uncertain capture; a Redis timeout
  cannot undo an external charge. Confirmation capability is demo-grade.
- **Operations/scale:** durable Redis must be non-evicting. Scoped listing CAS and
  bounded temporary histories avoid namespace-wide purchase-history contention,
  but no load/failover/SLA benchmark is claimed. Add capacity tests, rate limits,
  backup/recovery policy and production authorization before real commerce.
- **Telemetry/reset:** logs are best effort, not an outbox; use durable orders as
  conversion truth. Interrupted reset cleanup can retain fenced inaccessible keys;
  logical invalidation is atomic. Never share a demo namespace with real data.

No unresolved critical code failure was found in the executed local suites.
Submission remains conditional on the external gates above. Review source/history,
image attribution, dependency advisories, assessor access and the private demo
secret before sending GitHub/Vercel links.
