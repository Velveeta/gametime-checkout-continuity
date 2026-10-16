# Infrastructure boundary

No Redis adapter or in-memory substitute exists in Wave 00. Implement application
ports here in later waves. Use atomic Redis operations with server time; keep
clients and environment access out of domain/application. Validate required
credentials through `src/lib/env.ts` before constructing future adapters.
