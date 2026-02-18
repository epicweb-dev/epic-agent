# Authentication

`epic-agent` uses two related authentication models:

1. Cookie-based app sessions for browser users
2. OAuth bearer tokens for MCP access

## Browser app sessions

Session cookie behavior is implemented in `server/auth-session.ts`.

- Cookie name: `epic-agent_session`
- `httpOnly: true`
- `sameSite: 'Lax'`
- signed with `COOKIE_SECRET`
- max age: 7 days

The cookie payload stores:

- `id` (user id as string)
- `email`

`server/handler.ts` calls `setAuthSessionSecret` on each request so cookie
signing and verification are available to handlers.

## Login and signup

`POST /auth` is implemented by `server/handlers/auth.ts`.

- Accepts JSON body with `email`, `password`, and `mode` (`login` or `signup`)
- Uses D1 (`users` table) for user lookups and inserts
- Hashes passwords with `server/password-hash.ts`
- Returns signed session cookie via `Set-Cookie` on success
- Emits structured audit events through `server/audit-log.ts`

Related handlers:

- `GET /login` and `GET /signup`: `server/handlers/auth-page.ts`
- `POST /logout`: `server/handlers/logout.ts`
- `POST /session`: `server/handlers/session.ts` for session status checks
- `GET /account`: `server/handlers/account.ts` (redirects to login if missing
  session)

## Password reset

Password reset handlers are in `server/handlers/password-reset.ts`.

- `POST /password-reset` creates a one-time token and stores only its hash
- `POST /password-reset/confirm` verifies token hash and expiry, then updates
  password
- reset tokens expire after 1 hour
- when configured, email delivery is done via Resend

## OAuth for MCP

OAuth endpoints are implemented in `worker/oauth-handlers.ts` and routed from
`worker/index.ts`.

- Authorization endpoint: `/oauth/authorize`
- Token endpoint: `/oauth/token` (via provider)
- Client registration: `/oauth/register` (via provider)
- Supported scopes: `profile`, `email`

`/mcp` is protected by `worker/mcp-auth.ts`:

- Requires `Authorization: Bearer <token>` (bearer scheme is case-insensitive)
- Token is validated via OAuth provider helpers (`unwrapToken`)
- Audience must match the app origin or `<origin>/mcp`
- Unauthenticated requests return `401` with `WWW-Authenticate` metadata

## Admin token for workshop reindex

`POST /internal/workshop-index/reindex` is protected with a dedicated bearer
token (`WORKSHOP_INDEX_ADMIN_TOKEN`). This endpoint is intended for explicit
manual indexing runs and is separate from OAuth MCP auth.

The admin token uses the `Authorization: Bearer <token>` header, where the
bearer scheme is case-insensitive (`Bearer` / `bearer`).

By default, the reindex endpoint only accepts requests on localhost
(development) to prevent production deployments from calling GitHub. To allow
remote requests (not recommended), set `WORKSHOP_INDEX_ALLOW_REMOTE_REINDEX=1`
(or `true`/`yes`) in addition to `WORKSHOP_INDEX_ADMIN_TOKEN`.

## What to read when changing auth

- `worker/index.ts` for route order and integration points
- `worker/oauth-handlers.ts` for OAuth authorization logic
- `worker/mcp-auth.ts` for MCP token enforcement
- `server/auth-session.ts` for cookie format/signing
- `server/handlers/auth.ts` for app login/signup flow
