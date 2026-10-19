# Infrastructure boundary

`catalog/` contains validated, deeply frozen fictional seed data and its read
adapter. `redis/` implements inventory persistence with Upstash-compatible EVAL.
It has no checkout orchestrator or memory-backed substitute.

`client.ts` is a server-only factory; importing the app never connects or seeds.
`inventory-lua.ts` exports write-free functions for later composition in the
checkout repository's atomic session/reservation/order commands. See
`docs/INVENTORY.md` before integrating those functions into later waves.
