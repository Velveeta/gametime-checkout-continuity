# Wave 00 — foundation and contracts

**Read:** `AGENTS.md`, this wave. **Do not implement other waves.**

Create Next.js App Router TS strict app; Tailwind 4; shadcn/ui with Radix primitives; Vitest; ESLint; typecheck; minimal TanStack Query provider. Set up `src/domain`, `src/application`, `src/infrastructure`, `src/components`, `src/app`, `src/lib`. Establish environment schema and `.env.example` for Upstash REST credentials and demo-mode secret/config (never commit real values). Add basic scripts and CI-friendly commands.

Define shared domain contracts (no infrastructure code yet): `Event`, `Listing`, `SeatAllocation` (assigned contiguous seats vs general admission quantity), `PriceQuote` (ticket subtotal, fees, total, currency, version), `CheckoutSession` (id, event/listing/seat selection, status, reservationExpiresAt, processingDeadlineAt?, recoveryRetainUntil, version, acknowledgedQuoteVersion?, paymentAttemptCount, createdAt, orderId?), `Order`, and typed domain errors. Explicit statuses: ACTIVE, PRICE_REVIEW, PROCESSING, PAYMENT_RETRYABLE, PAYMENT_FAILED, COMPLETED, EXPIRED. Avoid mutually contradictory flags; use discriminated unions where practical. Define repository, inventory, payment, analytics, and clock interfaces; service APIs only as contracts. Document state diagram/transition table in `docs/STATE_MODEL.md`, including expiry-intent distinction, no hold extension, payment protection, terminal behavior.

**Invariants to record:** session creation atomically reserves; only a current, unexpired reservation can claim completion; price increase requires exact quote-version acceptance; payment processing holds inventory separately; only one order per checkout; order confirmation requires a completion capability returned to the initiating caller, not merely knowledge of session ID; terminal checkout navigation goes home. Price decreases auto-apply. Checkout completion and inventory sale are atomic from the domain perspective; real gateway reconciliation is out of scope.

**Acceptance:** install, lint, typecheck, test runner, initial Next build succeed. No fake Redis implementation required yet. Handoff `handoffs/00-foundation.md`.
