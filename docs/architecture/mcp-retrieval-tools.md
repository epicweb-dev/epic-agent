# MCP retrieval tools

This document describes the MCP retrieval tool surface used for workshop quiz
authoring workflows.

## Tool set

The MCP server currently exposes these retrieval-oriented tools:

- `list_workshops`
- `retrieve_learning_context`
- `retrieve_diff_context`
- `search_topic_context` (requires optional Vectorize + AI bindings)
- `retrieve_quiz_instructions` (quiz facilitation protocol / retention
  checklist)

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
- Re-run workshop indexing to populate vectors (GitHub Actions workflow "Load
  Workshop Content").

## `retrieve_quiz_instructions`

Returns evidence-based, step-by-step instructions for how an agent should run a
quiz to validate and reinforce a learner's understanding.

Key behavior:

- This tool returns a quiz protocol (not workshop content).
- It explicitly recommends asking exactly one question at a time, waiting for an
  attempt, giving immediate feedback, and revisiting missed concepts later
  (spaced retrieval).
- Pair it with retrieval tools like `retrieve_learning_context` or
  `search_topic_context` when you need source material to generate questions.

## Indexing trigger

Indexing is handled outside MCP tool calls.

Recommended (CI):

- Run the `🧠 Load Workshop Content` GitHub Actions workflow, which executes
  `bun tools/workshop-content-load-from-clones.ts` and indexes directly into D1
  (and Vectorize when configured) using Cloudflare APIs.
