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
- `bun run dev` (starts mock API servers automatically and sets
  `RESEND_API_BASE_URL` to the local mock host).
- To trigger workshop indexing manually in local/dev environments:
  - set `WORKSHOP_INDEX_ADMIN_TOKEN` in `.env`
  - call `POST /internal/workshop-index/reindex` with
    `Authorization: Bearer <token>`
- Add new mock API servers by following `docs/agents/mock-api-servers.md`.
- If you only need the client bundle or worker, use:
  - `bun run dev:client`
  - `bun run dev:worker`
- Set `CLOUDFLARE_ENV` to switch Wrangler environments (defaults to
  `production`). Playwright sets this to `test`.

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
  and unnecessary cost). This command uses `GITHUB_TOKEN` when set, and
  otherwise attempts to reuse `gh auth token` locally when available.

## Remote Cloudflare commands with API tokens

When running Wrangler remote commands with `CLOUDFLARE_API_TOKEN`, also set
`CLOUDFLARE_ACCOUNT_ID` explicitly to avoid account membership lookup failures
in non-interactive environments.

## Remix package docs

Use the Remix package index for quick navigation:

- `docs/agents/remix/index.md`
