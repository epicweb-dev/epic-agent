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
- paginate with `limit` + `cursor`

Supported filters:

- `product`
- `hasDiffs`

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
- same payload controls as learning context (`maxChars`, `cursor`)

If a non-empty `focus` value yields no diff matches, the tool returns a
focus-specific error so callers can quickly adjust their query.

## `search_topic_context`

Semantic search over vectorized chunk content.

Requirements:

- `WORKSHOP_VECTOR_INDEX` binding
- `AI` binding for embeddings
- `query` must be at least 3 non-whitespace characters

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

If bindings are missing, the tool returns an explicit unavailability error.

## Manual indexing trigger

Indexing is manual-only and handled outside MCP tool calls via:

- `POST /internal/workshop-index/reindex`
- `Authorization: Bearer <WORKSHOP_INDEX_ADMIN_TOKEN>`

This route refreshes indexed workshop metadata, sections, and optional vector
chunks used by retrieval tools.

Indexer GitHub API requests include bounded retry/backoff for transient failures
(network fetch failures, 5xx/429, and secondary rate limits) before surfacing an
error, and they honor `Retry-After` delays when provided by GitHub (capped to a
bounded maximum delay).
