# MCP retrieval tools

This document describes the MCP retrieval tool surface used for workshop quiz
authoring workflows.

## Tool set

The MCP server currently exposes these retrieval-oriented tools:

- `list_workshops`
- `retrieve_learning_context`
- `retrieve_diff_context`
- `search_topic_context` (requires optional Vectorize + AI bindings)

## `list_workshops`

Returns indexed workshop metadata and coverage summary.

Typical use:

- discover available workshop slugs
- identify whether diff context is available (`hasDiffs`)
- optionally paginate with `limit` + `cursor`

Supported filters:

- `product`
- `hasDiffs`
- `limit` is clamped to a maximum of `100` per page
- `all` (boolean) fetches all pages (defaults to `true`; set `all: false` to
  paginate manually with `limit` + `cursor`)

## `retrieve_learning_context`

Returns deterministic bundled context sections for quiz authoring.

Modes:

- explicit scope (`workshop`, `exerciseNumber`, optional `stepNumber`)
- random scope (`random: true`) with uniform sampling over indexed exercises

Response controls:

- `maxChars` (bounded by server defaults/hard max)
- continuation via `cursor`

Response metadata includes:

- scope (`workshop`, `exerciseNumber`, optional `stepNumber`)
- `sections[]`
- `truncated`
- optional `nextCursor`

## `retrieve_diff_context`

Returns diff-focused context sections (`is_diff` sections) for a scoped
workshop/exercise(/step).

Supports:

- optional case-insensitive `focus` filtering over diff section
  label/kind/source path/content
- whitespace-only `focus` values are treated as omitted
- same payload controls as learning context (`maxChars`, `cursor`)

If a non-empty `focus` value yields no diff matches, the tool returns a
focus-specific error so callers can quickly adjust their query. Errors include
the requested scope (workshop/exercise and step when provided).

## `search_topic_context`

Semantic search over vectorized chunk content.

Behavior and requirements:

- `query` must be at least 3 non-whitespace characters
- When `WORKSHOP_VECTOR_INDEX` + `AI` bindings are configured, the tool performs
  semantic (vector) search.
- When either binding is missing, the tool falls back to a case-insensitive
  keyword search over indexed D1 content (so callers still get useful results).
  The response includes `mode`, `vectorSearchAvailable`, and `warnings` so
  callers can detect the fallback.

Behavior:

- embeds the user query
- validates optional scope filters (`workshop`, `exerciseNumber`, `stepNumber`)
  against indexed D1 records before embedding/querying and before checking
  Vectorize/AI availability
- queries vector index with optional scope filters
- resolves matched vector IDs back to chunk + section metadata in D1 using a
  batched lookup
- includes `sourcePath` in ranked matches when section provenance is available
- trims and dedupes matched vector IDs before returning ranked matches

Enabling semantic search:

- Create a Vectorize index with `dimensions: 768` and `metric: cosine`.
- Bind it in `wrangler.jsonc` as `WORKSHOP_VECTOR_INDEX` via the `vectorize`
  config, and add an `ai` binding named `AI`.
- Re-run workshop indexing to populate vectors (GitHub Actions
  `🧠 Load Workshop Content` or `POST /internal/workshop-index/reindex`).

## Manual indexing trigger

Indexing is handled outside MCP tool calls.

Recommended (CI):

- Run the `🧠 Load Workshop Content` GitHub Actions workflow, which executes
  `bun tools/workshop-content-load-from-clones.ts` and indexes directly into D1
  (and Vectorize when configured) using Cloudflare APIs.

Optional (deployed Worker endpoint):

- `POST /internal/workshop-index/reindex`
- `Authorization: Bearer <WORKSHOP_INDEX_ADMIN_TOKEN>` (bearer scheme is
  case-insensitive)

The reindex route refreshes indexed workshop metadata, sections, and optional
vector chunks used by retrieval tools. Optional `workshops` filters may be sent
as an array or as a comma/newline-delimited string; values are trimmed,
lowercased, and deduplicated server-side. Empty lists fall back to full
discovery-based reindex. For operational safety, the route accepts at most 100
workshop filters after normalization (trim/lowercase/dedupe). If any requested
workshop slug is unknown, the request fails with a `400` invalid-payload
response and explicit details. The route also rejects malformed JSON payloads
with `400` instead of silently defaulting to full reindex behavior. The route
enforces a maximum request body size (50,000 characters), including an early
`Content-Length` guard when present, and returns `413` when exceeded.

To avoid long-running request timeouts, the reindex route also supports optional
pagination:

- request fields: `cursor` and `batchSize` (1-20)
- response field: `nextCursor` (present when more workshops remain)

Indexer GitHub API requests include bounded retry/backoff for transient failures
(network fetch failures, 5xx/429, and secondary rate limits) before surfacing an
error, and they honor `Retry-After` delays when provided by GitHub (capped to a
bounded maximum delay).
