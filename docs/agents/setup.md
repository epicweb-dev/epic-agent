# Setup

Quick notes for getting a local epic-agent environment running.

## Prerequisites

- Bun (used for installs and scripts).
- A recent Node runtime for tooling that Bun delegates to.

## Install

- `bun install`

## Local development

- Copy `.env.test` to `.env` before starting any work, then update secrets as
  needed.
- `.env.example` is a safe, committed template used by GitHub Actions preview
  deployments when syncing Cloudflare Worker secrets.
- `bun run dev` (starts mock API servers automatically and sets
  `RESEND_API_BASE_URL` to the local mock host).
- To trigger workshop indexing manually in local/dev environments:
  - set `WORKSHOP_INDEX_ADMIN_TOKEN` in `.env`
  - call `POST /internal/workshop-index/reindex` with
    `Authorization: Bearer <token>` (bearer scheme is case-insensitive)
  - optional `workshops` payload can be an array or comma/newline-delimited
    string; values are normalized to lowercase slugs
  - optional batching fields:
    - `batchSize` (1-20) to process workshops in smaller requests
    - `cursor` for continuation, using the `nextCursor` returned by the prior
      response
- Add new mock API servers by following `docs/agents/mock-api-servers.md`.
- If you only need the client bundle or worker, use:
  - `bun run dev:client`
  - `bun run dev:worker`
- Set `CLOUDFLARE_ENV` to switch Wrangler environments (defaults to
  `production`). Playwright sets this to `test`.

## Optional: semantic topic search (Vectorize + Workers AI)

`search_topic_context` works without Vectorize/AI (keyword fallback), but you
can enable semantic search in environments where you have Cloudflare Vectorize
and Workers AI available.

1. Create a Vectorize index with `dimensions: 768` and `metric: cosine`.
2. Add bindings in `wrangler.jsonc` for the target environment (`production` or
   `preview`):

```jsonc
{
	"env": {
		"production": {
			"ai": { "binding": "AI" },
			"vectorize": [
				{
					"binding": "WORKSHOP_VECTOR_INDEX",
					"index_name": "epic-agent-workshop-vector-index",
				},
			],
		},
	},
}
```

3. Re-run workshop indexing to upsert vectors (GitHub Actions
   `🧠 Load Workshop Content` or `POST /internal/workshop-index/reindex`).

## Checks

- `bun run validate` runs format check, lint fix, build, typecheck, Playwright
  tests, and MCP E2E tests.
- `bun run test:e2e:install` to install Playwright browsers.
- `bun run test:e2e` to run Playwright specs.
- `bun run test:mcp:unit` to run MCP retrieval/indexing unit tests and route
  tests.
- `bun run test:mcp` to run MCP server E2E tests.
- `bun run test:mcp:network` to include network-dependent manual reindex MCP E2E
  coverage (skipped by default in `test:mcp` to avoid flaky/rate-limit failures
  and unnecessary cost). This command uses `GITHUB_TOKEN`/`GH_TOKEN` when set,
  and otherwise attempts to reuse `gh auth token` locally when available. If
  neither credential source is available, the manual reindex network case is
  skipped.

## Remote Cloudflare commands with API tokens

When running Wrangler remote commands with `CLOUDFLARE_API_TOKEN`, also set
`CLOUDFLARE_ACCOUNT_ID` explicitly. CI also uses it to compute workers.dev
preview URLs.

## CI preview deploy resources

- PR preview deployments provision isolated Cloudflare resources per preview:
  - a dedicated D1 database
  - a dedicated KV namespace for `OAUTH_KV`
- The preview cleanup workflow deletes the preview Workers and these resources
  when the PR closes.

How to find `CLOUDFLARE_ACCOUNT_ID`:

- Cloudflare dashboard: open any Workers page and copy the id from the URL
  segment `accounts/<account-id>/...`.
- Wrangler CLI (after `bunx wrangler login`): run `bunx wrangler whoami` and use
  the printed `Account ID`.

## Remix package docs

Use the Remix package index for quick navigation:

- `docs/agents/remix/index.md`
