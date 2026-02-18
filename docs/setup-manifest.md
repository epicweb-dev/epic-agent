# Setup manifest

This document describes the infrastructure and secrets that epic-agent expects.

## Cloudflare resources

Create or provide the following resources (prod + preview):

- D1 database
  - `database_name`: `<app-name>`
  - `database_name` (preview): `<app-name>-preview`
- KV namespace for OAuth/session storage
  - `binding`: `OAUTH_KV`
  - title (prod): `<app-name>-oauth`
  - title (preview): `<app-name>-oauth-preview`
- (Optional for workshop semantic indexing) Vectorize index
  - `binding`: `WORKSHOP_VECTOR_INDEX`
  - used for chunk embedding upserts during manual workshop indexing
- (Optional for workshop semantic indexing) Workers AI binding
  - `binding`: `AI`
  - used to generate embeddings when Vectorize indexing is enabled

The post-download script will write the resulting IDs into `wrangler.jsonc`.

## Rate limiting (Cloudflare dashboard)

Use Cloudflare's built-in rate limiting rules instead of custom Worker logic.

1. Open the Cloudflare dashboard for the zone that routes to your Worker.
2. Go to `Security` → `WAF` → `Rate limiting rules` (or `Rules` →
   `Rate limiting rules`).
3. Create a rule that targets auth endpoints, for example:
   - Expression:
     `(http.request.method eq "POST" and http.request.uri.path in {"/auth" "/oauth/authorize" "/oauth/token" "/oauth/register"})`
   - Threshold: `10` requests per `1 minute` per IP (tune as needed).
   - Action: `Block` or `Managed Challenge`.

## Environment variables

Local development uses `.env`, which Wrangler loads automatically:

- `COOKIE_SECRET` (generate with `openssl rand -hex 32`)
- `APP_BASE_URL` (optional; defaults to request origin, example
  `https://app.example.com`)
- `RESEND_API_BASE_URL` (optional, defaults to `https://api.resend.com`)
- `RESEND_API_KEY` (optional, required to send via Resend)
- `RESEND_FROM_EMAIL` (optional, required to send via Resend)
- `WORKSHOP_CONTEXT_DEFAULT_MAX_CHARS` (optional, default `50000`)
- `WORKSHOP_CONTEXT_HARD_MAX_CHARS` (optional, default `80000`)

Tests use `.env.test` when `CLOUDFLARE_ENV=test` (set by Playwright).

## GitHub Actions secrets

Configure these secrets for deploy workflows:

- `CLOUDFLARE_API_TOKEN` (Workers deploy + D1 edit access on the correct
  account)
- `CLOUDFLARE_ACCOUNT_ID` (required; used by CI to compute workers.dev preview
  URLs and for reliable token-based Wrangler commands)
- `COOKIE_SECRET` (same format as local)
- `APP_BASE_URL` (production base URL)
- `RESEND_API_KEY` (optional, required to send via Resend)
- `RESEND_FROM_EMAIL` (optional, required to send via Resend)
- `GITHUB_TOKEN` (optional, recommended for indexing throughput and/or indexing
  private workshop repos; defaults to the GitHub Actions token when absent)
- `WORKSHOP_VECTORIZE_INDEX_NAME` (optional; override Vectorize index name for
  CI indexing in production; otherwise defaults to
  `<wrangler.jsonc name>-workshop-vector-index`)
- `WORKSHOP_VECTORIZE_INDEX_NAME_PREVIEW` (optional; override Vectorize index
  name for CI indexing in preview; otherwise defaults to
  `<wrangler.jsonc name>-workshop-vector-index-preview`)
- `WORKSHOP_VECTORIZE_DISABLED` (optional; set to `true`/`1`/`yes` to skip
  Vectorize + Workers AI calls during CI indexing)
- `EPICSHOP_AUTH_INFOS` (optional; base64-encoded auth JSON for headless
  epicshop CLI; enables transcript inclusion in workshop context export; run
  `epicshop auth login` locally, then extract and base64-encode `authInfos` from
  your data file)

How to find `CLOUDFLARE_ACCOUNT_ID`:

- Cloudflare dashboard: open any Workers page and copy the id from the URL
  segment `accounts/<account-id>/...`.
- Wrangler CLI (after `bunx wrangler login`): run `bunx wrangler whoami` and use
  the printed `Account ID`.

To load workshop content into D1 + Vectorize from CI, run the
`🧠 Load Workshop Content` GitHub Actions workflow (`workflow_dispatch`):

- choose `production` or `preview` target environment
- optionally provide a comma/newline-separated workshop list to limit indexing
  scope
- leave the workshop list empty to index all discovered workshop repositories
- workshop slugs are trimmed, lowercased, and deduplicated before indexing
- workshop filters are capped at 100 unique slugs after normalization
- if the provided workshop list collapses to empty after trimming/deduping, the
  workflow falls back to indexing all discovered workshop repositories
- if any requested workshop slug is unknown, indexing fails fast with an
  explicit error naming missing workshops
- the workflow runs `bun tools/workshop-content-load-from-clones.ts`, which:
  - discovers workshop repositories via GitHub Search API
  - clones each repository into a temporary directory
  - runs `bunx epicshop exercises context` to export instructions, diffs, and
    transcripts as JSON
  - reads `wrangler.jsonc` to locate the environment-specific `APP_DB` database
    id
  - indexes workshops into D1 using the Cloudflare D1 API
  - unless `WORKSHOP_VECTORIZE_DISABLED` is set, ensures a Vectorize index
    exists (auto-creating it when missing), generates embeddings via the Workers
    AI API (bge-base-en-v1.5; chunks truncated to 512 chars for token limits),
    and upserts vectors into Vectorize; retries failed batches with smaller
    splits and skips individual chunks that still fail
  - paginates over workshop repositories using `batchSize` (default 2, max 20)
    until all workshops are processed
- workflow summary output includes the generated reindex run id for easier log
  correlation (`workshop_index_runs.id`)

To keep indexed workshop content fresh automatically, CI also runs the
`Nightly Workshop Reindex` workflow (`schedule`, production only). It:

- runs daily at `10:00 UTC` (roughly `03:00` Mountain Standard Time)
- discovers workshop repositories via GitHub Search (same as the manual job)
- reads `indexed_workshops.source_sha` from D1 to find the last indexed commit
  for each workshop
- uses the GitHub compare API to detect whether any file changes since that
  commit touched `exercises/` or `extra/`
- reindexes only the affected workshops (and reindexes when compare fails, to
  avoid silently missing changes)

It requires the same GitHub Actions secrets as the manual indexing workflow (at
minimum `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, plus a token for
GitHub API access when workshop repos are private).

When PR preview deploys run, CI deploys a unique Worker per PR named
`epic-agent-pr-<number>`, updates a pull request comment with the computed
workers.dev preview URL, and links to the workflow run.

When the PR is closed, CI automatically deletes the corresponding preview
Worker.

If `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` are not configured, cloud
deploy/migration steps and preview URL computation are skipped in CI.
