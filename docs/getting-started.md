# epic-agent Template Setup

<!--
If you're an agent reading this, do as much as you can yourself and then
tell the user what else they need to do themselves.
-->

Use these steps to generate a new project from this template and run it on
Cloudflare Workers.

## Create the project with degit

```
bunx degit epicweb-dev/epic-agent my-epic-agent-app
cd my-epic-agent-app
```

## Install dependencies

We use bun for scripts and installs.

```
bun install
```

## Expectations and assumptions

The setup flow assumes:

- Bun is installed (uses `bun`/`bunx`).
- You run commands from the repo root (needs `wrangler.jsonc` and
  `package.json`).
- You can write to `wrangler.jsonc`, `package.json`, `.env`, and `docs/`.
- Wrangler is available. If you are not logged in, the script prints
  `bunx wrangler login` and stops. In interactive mode, it can run the login for
  you.

See `docs/setup-manifest.md` for required resources and secrets.

## Preflight checks

Run a quick validation of your environment and Wrangler login:

```
bun ./docs/post-download.ts --check
```

## Quick Start (local only)

1. Run the guided setup script:

```
bun ./docs/post-download.ts --guided
```

2. Start local development:

```
bun run dev
```

## Full Cloudflare setup (deploy)

1. Run the guided setup script and create resources when prompted:

```
bun ./docs/post-download.ts --guided
```

2. Configure GitHub Actions secrets for deploy:

- `CLOUDFLARE_API_TOKEN` (Workers deploy + D1 edit access on the correct
  account)
- `CLOUDFLARE_ACCOUNT_ID` (required; used by CI to compute workers.dev preview
  URLs and for reliable token-based Wrangler CI commands)
- `COOKIE_SECRET` (generate with `openssl rand -hex 32` or similar)
- `APP_BASE_URL` (production app URL)
- `GITHUB_TOKEN` (optional but recommended for higher indexing throughput and/or
  indexing private workshop repos; defaults to the GitHub Actions token when
  absent)
- `WORKSHOP_VECTORIZE_INDEX_NAME` (optional; override Vectorize index name for
  CI indexing in production; otherwise defaults to
  `<wrangler.jsonc name>-workshop-vector-index`)
- `WORKSHOP_VECTORIZE_INDEX_NAME_PREVIEW` (optional; override Vectorize index
  name for CI indexing in preview; otherwise defaults to
  `<wrangler.jsonc name>-workshop-vector-index-preview`)
- `WORKSHOP_VECTORIZE_DISABLED` (optional; set to `true`/`1`/`yes` to skip
  Vectorize + Workers AI calls during CI indexing)

How to find `CLOUDFLARE_ACCOUNT_ID`:

- Cloudflare dashboard: open any Workers page and copy the id from the URL
  segment `accounts/<account-id>/...`.
- Wrangler CLI (after `bunx wrangler login`): run `bunx wrangler whoami` and use
  the printed `Account ID`.

3. Deploy:

```
bun run deploy
```

## Load workshop content in GitHub Actions

After deploy, run the `🧠 Load Workshop Content` workflow from the Actions tab
to populate D1 (and Vectorize when enabled) directly from the workflow job.

- choose the target environment (`production` or `preview`)
- choose a batch size (workshops processed per request, default 2)
- optionally select workshop checkboxes (known slugs) and/or provide
  comma/newline-separated workshop slugs to scope the index run
- provided workshop slugs are trimmed, lowercased, and deduplicated before
  indexing starts
- leave workshop input empty to index all workshop repositories

## Agent/CI setup

Use non-interactive flags or `--defaults`. The `--defaults` flag skips prompts
and uses defaults based on the current directory name (worker/package/database
names), plus a generated cookie secret.

```
bun ./docs/post-download.ts --defaults --database-id <id> --preview-database-id <id> --kv-namespace-id <id>
```

To preview changes without writing, add `--dry-run`. To emit a JSON summary, add
`--json`. To run preflight checks only, add `--check`.

### Script flags

- `--guided`: interactive, state-aware flow (resource creation optional).
- `--check`: run preflight checks only.
- `--defaults`: accept defaults without prompts.
- `--dry-run`: show changes without writing or deleting the script.
- `--json`: print a JSON summary.
- `--app-name`, `--worker-name`, `--package-name`
- `--database-name`, `--database-id`
- `--preview-database-name`, `--preview-database-id`
- `--kv-namespace-id`, `--kv-namespace-preview-id`
- `--kv-namespace-title`, `--kv-namespace-preview-title` (used when creating)

## Local development

See `docs/agents/setup.md` for local dev commands and verification steps.

Quick verification commands:

```
bun run test:mcp:unit
bun run validate
```

## Build and deploy

Build the project:

```
bun run build
```

Deploy to Cloudflare:

```
bun run deploy
```
