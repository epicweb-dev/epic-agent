# Data storage

This project uses three Cloudflare storage systems for different purposes.

## D1 (`APP_DB`)

Relational app data lives in D1.

Current schema is defined by migrations in `migrations/`:

- `users`: login identity and password hash
- `password_resets`: hashed reset tokens with expiry and foreign key to users
- `workshop_index_runs`: manual indexing run metadata and counters (workshops,
  exercises, steps, sections, section chunks)
- `indexed_workshops`: indexed workshop manifests and coverage metadata
- `indexed_exercises`: indexed exercise summaries per workshop
- `indexed_steps`: indexed problem/solution step pairs
- `indexed_sections`: retrieval-ready context sections (instructions/code/diffs)
- `indexed_section_chunks`: chunked section content for optional vector indexing

App access pattern:

- SQL helpers in `worker/db.ts` provide typed wrappers (`queryFirst`,
  `queryAll`, `exec`)
- app handlers (for example `server/handlers/auth.ts`) use these helpers for
  database calls
- MCP retrieval/indexing logic uses direct prepared statements for bulk index
  writes and ordered section reads
- workshop index replacement avoids raw `BEGIN/COMMIT` SQL transaction
  statements (unsupported in Workers SQLite runtime) and relies on D1 prepared
  statement writes instead

## KV (`OAUTH_KV`)

OAuth provider state is stored in KV through the
`@cloudflare/workers-oauth-provider` integration.

- Binding is configured in `wrangler.jsonc`
- This supports OAuth client and token flows without custom storage code in the
  app handlers

## Durable Objects (`MCP_OBJECT`)

MCP server runtime state is hosted via a Durable Object class (`MCP`) in
`mcp/index.ts`, exposed through the `/mcp` route.

- The Worker forwards authorized MCP requests to `MCP.serve(...).fetch`
- Durable Objects provide a stateful execution model for MCP operations

## Vectorize (`WORKSHOP_VECTOR_INDEX`, optional)

Workshop indexing is designed to support vector chunk upserts for semantic
retrieval expansion. The current MVP retrieval path is deterministic and D1
backed, while Vectorize remains an optional cloud binding.

- MCP tool `search_topic_context` uses Vectorize + Workers AI when configured.
- Reindex replaces per-workshop chunk vectors and removes prior vector IDs in
  batches to reduce stale semantic matches.
- Embedding generation and Vectorize upserts run in bounded batches to keep
  request payloads within practical limits for larger workshops.
- If a repository write fails after fresh vector upsert, reindex attempts a
  best-effort rollback delete of the newly inserted vector IDs.
- If bindings are absent, the tool returns a clear unavailability error instead
  of failing silently.

## Configuration reference

Bindings are configured per environment in `wrangler.jsonc`:

- `APP_DB` (D1)
- `OAUTH_KV` (KV)
- `MCP_OBJECT` (Durable Objects)
- `ASSETS` (static assets bucket)
