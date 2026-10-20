# Assessment traceability / final acceptance

| Assessment criterion  | Evidence required                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| Create checkout       | Catalog → listing → atomic reservation → `/checkout/:id`                                               |
| Resume across devices | Same canonical URL; independent browser contexts; server-authoritative status and deadline             |
| Expiration            | Visible synchronized countdown; hold release; live-page event redirect; fresh-navigation recovery path |
| Price change          | Increase blocks until exact quote accepted; decrease auto-applies with positive message                |
| Payment               | Deterministic success, definitive decline, transient timeout, max 3 total attempts                     |
| Duplicate prevention  | Atomic session-level completion claim + unique order invariant; concurrency test                       |
| Stale inventory       | Reserved seats removed from other shoppers, restored on expiry, sold never restored                    |
| Before hydration      | Event and checkout summary/status server-rendered; small client islands                                |
| Mobile                | Responsive canonical route, mobile drawer, real second-device deep link                                |
| Observability         | Typed events and conversion-funnel discussion in README                                                |
| Tests                 | Domain, Redis atomicity, API and focused Playwright scenarios                                          |
| Submission            | GitHub repo, run instructions, Vercel demo, tradeoffs, future work                                     |

## Clarifying assumptions

- Demo event fixtures are invented and must not imply official schedules or market prices.
- The inventory hold is **not** extended by normal requests. A processing claim before expiry transitions into a separate protected deadline.
- Server timestamp is authoritative; Redis TTL is metadata cleanup, not the business clock.
- Recover only on fresh navigation, never on polling or a mounted-page timeout.
- Completion redirects other clients home; only the initiating client receives confirmation capability.
- Inventory holds and checkout state must be atomic across Vercel instances.
