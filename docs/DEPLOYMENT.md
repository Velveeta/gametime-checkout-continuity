# Host this assessment: Upstash, GitHub, and Vercel

**Current status:** source/build/local Redis validation is available; no hosted
Upstash database, GitHub repository, or Vercel deployment has been created here.
You will perform the account steps below. A successful build alone does not prove
that deployed checkout persistence works.

## 1. Create your Upstash Redis database

1. Sign in at [Upstash Console](https://console.upstash.com/) and create an
   account-owned **Redis** database. Use a name such as `gametime-assessment`.
2. Choose a primary region near the Vercel function region you intend to use.
   This app performs authoritative reads/writes through Redis scripts, so write
   latency matters. Review the selected plan's capacity/request limits; polling
   adds traffic. No particular paid plan is required by the code.
3. **Leave eviction disabled.** These keys are durable inventory/order data,
   not a disposable cache. Upstash disables eviction by default; verify it in
   database configuration. Evicting/deleting inventory can invalidate the sold-stock
   invariant. No application promise covers arbitrary durable-data deletion.
4. Open the database details / connection section. Copy the HTTPS REST endpoint
   and the normal **read/write REST token** into your private configuration.
   These map exactly to `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
   Do not use a `redis://` TCP URL, Redis password alone, read-only token, Developer
   API key, Vector token, or Search token.
5. Keep the database and token private. No local Redis service, public Redis port,
   migration SQL, WebSocket server, cron job, or keyspace-notification setup is
   needed for the deployed app.

Provider references: [create/connect](https://upstash.com/docs/redis/overall/getstarted),
[REST client variables](https://upstash.com/docs/redis/howto/connect-with-upstash-redis),
[eviction](https://upstash.com/docs/redis/features/eviction).

## 2. Configure the local files

From the directory containing this project's `package.json`:

```sh
npm ci
cp .env.example .env.local
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
```

Save those three independently generated outputs as caller, completion, and demo
secrets. Edit `.env.local` (not the committed example) using this mapping:

| Variable                     | Local example / required value                        | Vercel placement                                                        |
| ---------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `UPSTASH_REDIS_REST_URL`     | Your Upstash HTTPS REST endpoint                      | Production and/or Preview, as appropriate                               |
| `UPSTASH_REDIS_REST_TOKEN`   | Your read/write REST token                            | Secret in the selected environment                                      |
| `CHECKOUT_NAMESPACE`         | `gametime-local-richard`                              | Different stable values, e.g. `gametime-preview`, `gametime-assessment` |
| `CHECKOUT_CALLER_SECRET`     | First random output, >=32 characters                  | Secret; stable across instances/redeploys                               |
| `CHECKOUT_COMPLETION_SECRET` | Second distinct output, >=32 characters               | Secret; stable across instances/redeploys                               |
| `DEMO_MODE`                  | `true` for a controlled assessment; otherwise `false` | Explicit opt-in only for synthetic demos                                |
| `DEMO_SECRET`                | Third random output, >=32 characters when enabled     | Secret; give only to trusted assessors                                  |
| `PAYMENT_SCENARIO`           | `SUCCESS`                                             | `SUCCESS` unless intentionally changing the demo base scenario          |

Use plain values in the dashboard, without shell quotes. Do not rename these to
`KV_REST_API_URL`/`KV_REST_API_TOKEN`: if an integration supplies differently named
values, copy/map them to the exact names above. No `NEXT_PUBLIC_` variable or client
API-base URL is needed; the browser uses same-origin endpoints.

| File                                     | What it does / what you must edit                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `.env.local`                             | Create from the template and fill actual local values; ignored by Git                  |
| `.env.example`                           | Committed variable template; keep credentials blank                                    |
| `src/lib/env.ts`                         | Validates variable names, URL protocol, secrets, and demo opt-in; no edit needed       |
| `src/lib/checkout-runtime.ts`            | Reads server variables and composes services per invocation; no edit needed            |
| `src/infrastructure/redis/upstash.ts`    | Configures the existing HTTPS SDK; no edit needed                                      |
| `src/infrastructure/checkout/compose.ts` | Resolves active generation and initializes missing fixture data safely; no edit needed |
| `src/infrastructure/catalog/fixtures.ts` | Already contains the four events/16 listings; no setup edit needed                     |
| `next.config.ts` / `package.json`        | Already use Next server rendering and build/start scripts; no static export changes    |
| `.gitignore`                             | Excludes environment files, `.vercel`, dependencies/builds/test reports                |

Build needs no live credentials. Runtime reservation/checkout does. Next reads the
root `.env.local` automatically; restart `npm run dev` after changing it. Never put
credentials directly in TS/JS, `next.config.ts`'s `env` object, browser storage, or a
GitHub commit. The same namespace must mean the same dataset on every instance.
Prefer separate databases for stronger isolation; distinct namespaces isolate the
assessment when one database is used. Preview should not share Production's namespace
or signing secrets. Branch previews sharing one namespace can affect each other;
assign a branch-specific namespace if those demonstrations must be independent.

```sh
npm run dev
```

Open localhost:3000, reserve tickets, and make sure checkout works. First runtime
composition idempotently seeds the deterministic catalog/inventory. It does **not**
reset reservations or sales on navigation/redeploy. Do not manually delete individual
stock/order/receipt keys. V1 data is deliberately rejected; use a fresh namespace
instead of trying to repurpose an incompatible old dataset.

## 3. Verify hosted Redis before publishing

Local Redis integration tests are not evidence that your hosted account allows the
same operations. With Node 24 and the filled `.env.local`, load it explicitly:

```sh
node --env-file=.env.local --run test:upstash
```

This runs two real-Upstash tests in an isolated generated `live-test-<uuid>` namespace:
competing reservations/completion/replay, scenario persistence, Redis-time duration,
and reset fencing/SCAN/UNLINK cleanup. It does not reset your configured demo namespace.
It requires read/write and scripting capabilities. Inspect failures before publishing;
no pass is claimed for this command until you run it against your account.

For the complete local suite, install Redis >=6.2, redis-cli, openssl and Chromium:

```sh
# macOS prerequisite example:
brew install redis openssl
npx playwright install --with-deps chromium
npm run check
```

Do not point the local test harness at a hosted database; it owns disposable local
processes. See [validation details](VALIDATION.md) for suite boundaries.

## 4. Put the repository on your GitHub account

Review the code, README, acceptance matrix, image attribution, and local commit
history. The delivered archive includes `.git`; all commits so far are local.
Create an **empty** GitHub repository named, for example,
`gametime-checkout-continuity` (do not initialize a second README).

```sh
git status --short
git remote -v
# Replace YOUR_USERNAME with your account. There is no configured remote in this delivery.
git remote add origin https://github.com/YOUR_USERNAME/gametime-checkout-continuity.git
git push -u origin main
```

Authenticate using your own GitHub setup. Choose visibility according to the
assessment instructions; grant assessors access if private. Do not add `.env.local`,
logs, `.next`, dependencies or test screenshots. No GitHub credentials are required
inside this application's code or Vercel runtime environment.

## 5. Import and configure Vercel

1. Sign in at [Vercel](https://vercel.com/), choose **Add New → Project**, and import
   your GitHub repository. Authorize only the appropriate account/repository.
2. Select the **Next.js** framework preset. Root directory must contain `package.json`
   (`./` if you pushed this project's contents at repository root). Choose Node **24.x**.
3. Use Install Command `npm ci`, Build Command `npm run build`, and the framework's
   default output settings. Do not change the build to `npm run check`: the full
   test suite requires Redis/Chromium tools that belong in CI, not Vercel's build.
   Do not configure static export, an `out`/`dist` output, or a local Redis process.
   A custom `vercel.json` is unnecessary for the current App Router project.
4. Add the eight variables from the table to **Project → Settings → Environment
   Variables** for the environments you intend to deploy. Mark token/signing/demo
   secrets as Secret where offered. Production and Preview have separate values.
   Do not manually override NODE_ENV. Vercel's production runtime can still host an
   explicitly opted-in _synthetic_ demo; DEMO_MODE is a separate security gate.
5. Deploy. Environment edits affect new deployments, so redeploy after changing
   variables. A Vercel build success with missing Redis values can still leave
   checkout unavailable: complete the smoke steps below.
6. Confirm the actual function region/Node version and deployment logs. Align the
   database primary region where practical. Keep the signing secrets stable; changing
   them revokes caller/confirmation/demo access rather than migrating identities.
7. Check deployment protection in an independent/incognito browser. Assessors and
   the phone scanning the QR must be able to reach the URL. Use approved guest/access
   settings or the intended public synthetic-demo URL; do not publish secret bypass
   tokens. The developer endpoints still require their own scoped unlock.

Optional CLI after linking your existing Vercel project/account:

```sh
npx vercel@latest login
npx vercel@latest link
npx vercel@latest          # Preview deployment, using Preview settings
npx vercel@latest --prod   # Production deployment, using Production settings
```

Provider references: [Next.js deployment](https://vercel.com/docs/frameworks/full-stack/nextjs),
[Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions),
[environment scopes/redeployment](https://vercel.com/docs/environment-variables),
[CLI deployment](https://vercel.com/docs/projects/deploy-from-cli).
Instructions were checked against official documentation on 2026-10-20; account
plans/UI labels can change. No Vercel URL is claimed in this delivery.

## 6. Production smoke checklist and submission

Record the actual Vercel URL and date/results in VALIDATION.md only after testing.
Use the stable HTTPS deployment origin for both devices, not a mix of Preview,
Production, custom domain, localhost and Vercel aliases (cookies are origin-specific).

- Open home/event pages in an incognito browser: confirm images, fictional labels,
  venue/date details, complete prices and live availability.
- Reserve a small assigned selection. In another independent profile, see reduced
  stock; paste the checkout URL and compare deadlines/selections without another hold.
- If opted in, unlock Developer menu with the private demo secret. Verify price up/
  acknowledgement, price down/savings, duration synchronization, and expire-now.
  Confirm mounted expiry returns to event; separately reopen the old URL for recovery.
- On fresh checkouts, verify transient retry, definitive decline, and success.
  The buyer reaches a refreshable confirmation; the other view goes home. Confirm
  stock remains sold after the original deadline and revisiting checkout goes home.
- Scan the QR from an actual phone and test touch/Sheet/close controls. Avoid making
  unverified claims based only on responsive browser emulation.
- In Vercel logs, inspect allowlisted checkout_event records for session/surface
  correlation. Check Upstash usage/errors; do not paste credentials into screenshots.
- Verify anonymous developer writes fail without an unlock. For a deployment with
  DEMO_MODE=false, those routes must return 404 and the menu must be absent.
- If testing reset, use only the isolated synthetic namespace and type the required
  phrase. It invalidates all of that namespace's checkouts and confirmations.

Before sending: provide the GitHub URL, deployed URL, reviewer walkthrough and
private demo access instructions through the assessment's approved channel. Check
repository visibility and Vercel access from outside your signed-in session.

## Troubleshooting

| Symptom                                           | Check                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Catalog renders but checkout is unavailable       | All five Redis/namespace/signing variables exist at runtime; redeploy after edits                                         |
| Redis 401 / write failure                         | Exact HTTPS REST endpoint plus read/write token; database still active; scripting/quotas                                  |
| Sold tickets unexpectedly return after deployment | Namespace changed, database reset/evicted/deleted, or wrong environment connected; stop the demo and inspect data         |
| Demo menu absent / API 404                        | DEMO_MODE is exactly `true` on that deployment, then redeploy                                                             |
| Demo API 403                                      | Unlock this session/device with the current secret; grant expires after one hour or reset/secret rotation                 |
| Confirmation unavailable on second device         | Expected: only the completing device receives its capability; this is not account-based booking history                   |
| Phone cannot open QR                              | Reachable HTTPS origin, Vercel deployment protection, and cookie/origin consistency                                       |
| Build reports unreadable Turbopack cache          | Clear only generated `.next/cache/turbopack` locally, or redeploy without the stale build cache; do not delete Redis data |
