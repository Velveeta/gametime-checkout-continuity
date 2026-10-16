# Wave 00 handoff

- **Commit:** `1544070eaa9ee986e8a1f9b4f2e052dae28b15c4` (implementation); this handoff is committed separately.
- **Delivered:**
  - Next App Router / React 19 / strict TypeScript / Tailwind 4 scaffold; local shadcn/Radix button and per-provider TanStack Query client.
  - Server environment schema, `.env.example`, server-only entrypoint, npm scripts, lockfile and GitHub CI workflow.
  - Shared domain models/errors, atomic repository and service contracts, `docs/STATE_MODEL.md`.
- **Contracts added/changed:** `src/domain/models.ts`, `values.ts`, `errors.ts`; `src/application/ports.ts`, `checkout-service.ts`. Atomic command union intentionally has no generic save. Only a newly won claim returns CLAIMED; only first successful settlement returns a completion capability. Confirmation requires order ID plus capability. Fresh-navigation recovery differs from mounted expiry.
- **Validation:** `npm ci` passed; `npm run check` passed: lint (zero warnings), typecheck, Vitest (32/32 tests, 3/3 files), production Next build. Lint rerun after boundary-rule refinement passed. Local production smoke passed: homepage/compiled Tailwind CSS HTTP 200, server-rendered content and semantic markup, disabled action, unimplemented checkout HTTP 404. CI workflow itself has not run remotely.
- **Known limitations:** Contracts only; no catalog, adapters, lifecycle implementation, APIs or E2E yet. Tests cover value/env boundaries and compile-time state narrowing, not future checkout correctness. No deployment. npm reports ESLint 9 deprecation; retained for installed Next plugins' peer compatibility.
- **Next wave:** With approval, read `specs/01-catalog-inventory.md` plus AGENTS and this handoff. Implement selection/availability validation; preserve atomic reservation, fixed deadlines, processing protection, and no framework/client imports in domain/application. Do not implement future waves speculatively.
- **Decisions/deviations:** USD-only prototype; timestamps normalized to canonical UTC (display uses event IANA zone). Terminal payment failure releases inventory and navigates home. Lost completion-capability recovery is outside current contracts. Redis client and Playwright installs deferred until used; no functional scope deviation from Wave 00.
