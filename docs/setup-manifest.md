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
- `GITHUB_TOKEN` (optional but recommended for workshop indexing rate limits)
- `WORKSHOP_INDEX_ADMIN_TOKEN` (required to call manual reindex endpoint)
- `WORKSHOP_CONTEXT_DEFAULT_MAX_CHARS` (optional, default `50000`)
- `WORKSHOP_CONTEXT_HARD_MAX_CHARS` (optional, default `80000`)

Manual reindex endpoint:

- `POST /internal/workshop-index/reindex`
- `Authorization: Bearer <WORKSHOP_INDEX_ADMIN_TOKEN>` (bearer scheme is
  case-insensitive)

The reindex endpoint also supports cursor batching to reduce the risk of
long-running requests:

- request fields: `cursor` and `batchSize` (1-20)
- response field: `nextCursor` (present when more workshops remain)

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
- `GITHUB_TOKEN` (optional, recommended for indexing throughput)
- `WORKSHOP_INDEX_ADMIN_TOKEN` (required for protected manual reindex trigger)

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
- workshop slugs are trimmed, lowercased, and deduplicated before sending the
  reindex payload
- workshop filters are capped at 100 unique slugs after normalization
- normalized reindex payloads must remain within the route body-size limit
  (50,000 characters)
- if the provided workshop list collapses to empty after trimming/deduping, the
  workflow falls back to indexing all discovered workshop repositories
- if any requested workshop slug is unknown, reindex fails fast with an explicit
  `400` response naming missing workshops
- the workflow resolves a target base URL in this order:
  - preferred: the environment-specific `workers.dev` URL derived from
    `wrangler.jsonc` (requires `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`)
  - fallback (production only): `APP_BASE_URL`
- target URLs must be absolute `http://` or `https://` base URLs
- before indexing, the workflow preflights
  `POST /internal/workshop-index/reindex` without `Authorization`:
  - `401` means the Worker has `WORKSHOP_INDEX_ADMIN_TOKEN` configured
    (expected)
  - `503` means the Worker is missing `WORKSHOP_INDEX_ADMIN_TOKEN`
- the workflow retries transient network failures when calling the protected
  reindex endpoint
- reindex HTTP calls use connect/request timeouts to avoid hanging CI jobs
- the workflow paginates reindex requests when needed:
  - it sets `batchSize` (default 5, max 20)
  - it continues calling the route while `nextCursor` is returned
- the workflow expects a successful JSON response (`ok: true`) from the reindex
  endpoint and fails fast otherwise
- when the reindex endpoint returns an error JSON payload, the workflow surfaces
  both `error` and `details` fields in job logs for faster diagnosis (whether
  `details` is returned as an array or a string)
- workflow summary output includes the returned reindex run ids for easier log
  correlation (`workshop_index_runs.id`)

When PR preview deploys run, CI deploys a unique Worker per PR named
`epic-agent-pr-<number>`, updates a pull request comment with the computed
workers.dev preview URL, and links to the workflow run.

When the PR is closed, CI automatically deletes the corresponding preview
Worker.

If `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` are not configured, cloud
deploy/migration steps and preview URL computation are skipped in CI.
