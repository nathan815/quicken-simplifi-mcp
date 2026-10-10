# Improvements Over Upstream

This fork of [krconv/quicken-simplifi-mcp](https://github.com/krconv/quicken-simplifi-mcp) adds five categories of improvements: new MCP tools, simplified authentication, auto dataset ID detection, a browser-based Quicken connect flow, and a setup wizard.

---

## 1. New MCP Tools

The upstream server had no way to create or modify tags or memos on transactions — you could list tags but not apply them. Six new tools fill that gap.

### `create_tag`
Create a new tag in Simplifi.

```json
{ "name": "Vacation" }
```

### `tag_transaction`
Add one or more tags to a transaction without disturbing any existing tags.

```json
{ "transactionId": "...", "tagIds": ["412008791498810112"] }
```

### `untag_transaction`
Remove specific tags from a transaction by ID.

```json
{ "transactionId": "...", "tagIds": ["412008791498810112"] }
```

### `set_transaction_tags`
Replace all tags on a transaction with an exact set. Pass `[]` to clear all tags.

```json
{ "transactionId": "...", "tagIds": ["id1", "id2"] }
```

### `set_transaction_memo`
Set or clear the memo/note field on a transaction.

```json
{ "transactionId": "...", "memo": "Reimbursed by work" }
```

### `list_transactions_by_tag`
Filter transactions by tag name or ID, with the same pagination and date filters as `list_transactions`.

```json
{ "tagName": "Vacation", "dateFrom": "2025-01-01" }
```

**Implementation notes:**
- `tag_transaction` / `untag_transaction` read the current tags from cache, merge/subtract, then call the existing `updateTransaction` path
- `list_transactions_by_tag` uses SQLite's `json_each()` to query the tags array inside raw JSON — no schema migration needed
- Tag objects sent to Simplifi use `{ id, name }` shape, resolved from the local tags cache

---

## 2. Simplified Local Authentication (`MCP_API_KEY`)

The upstream server implemented a full OAuth 2.0 Authorization Code + PKCE server to protect the `/mcp` endpoint. For a single-user server running locally (Claude Code or Claude Desktop on the same machine), this is overkill.

### What we added

An optional `MCP_API_KEY` environment variable. When set, `/mcp` accepts that value as a static bearer token (constant-time comparison) **in addition to** normal OAuth JWTs, so OAuth clients like Claude.ai keep working. Setting it also enables the `/connect` login page (see section 4):

```bash
MCP_API_KEY=<any-random-string>
```

Connect Claude Code:

```bash
claude mcp add simplifi --transport http http://localhost:8787/mcp \
  --header "Authorization: Bearer <MCP_API_KEY>"
```

### What becomes optional

When `MCP_API_KEY` is set, `OAUTH_JWT_SECRET` is optional (a random per-process secret is used if it is unset, so access tokens issued before a restart stop validating; clients then refresh using the refresh tokens persisted in SQLite and get new ones, so set a fixed secret if you want that to be seamless). `OAUTH_LOGIN_USERNAME` / `OAUTH_LOGIN_PASSWORD` no longer exist: the OAuth authorize page signs in with your Quicken email and password (see `docs/plan-unified-oauth.md`).

Clients that cannot run OAuth (e.g. an agent reaching the server over a private network) use the key. For Claude.ai web, which only supports OAuth, use the OAuth flow. Keep `HOST` bound to a private interface when the key is set.

---

## 3. Auto Dataset ID Detection

The upstream server required `SIMPLIFI_DATASET_ID` — a numeric ID you had to find manually by inspecting network requests in browser DevTools.

### What we added

After a successful Simplifi login, the server calls `GET /datasets`, takes the first result's `id`, and stores it in a `simplifi_config` SQLite table. `SIMPLIFI_DATASET_ID` is now **optional** in `.env`.

The stored ID is cleared on every fresh credential login (including after MFA), so signing in as a different account re-detects its dataset instead of reusing the previous one. Note this only resets the dataset ID; transactions already cached in SQLite are not cleared, so switching accounts on an existing cache directory still needs a fresh `CACHE_DB_PATH`.

```
Login → GET /datasets → store dataset_id → use on all subsequent API calls
```

If `/datasets` returns more than one dataset, the first is used and a warning listing every dataset's ID and name is logged. To use a different one, pin it via `SIMPLIFI_DATASET_ID` in `.env` — that takes precedence over the auto-detected value.

**Files changed:** `src/simplifi/client.ts`, `src/db/database.ts`, `src/config.ts`

---

## 4. Browser-Based Quicken Connect Flow (No Credentials on Disk)

The upstream server required `SIMPLIFI_EMAIL` and `SIMPLIFI_PASSWORD` in `.env`. These credentials sat on disk, accessible to anything with read access to the file.

### What we added

A `/connect` route that handles the Quicken auth flow in the browser. It is only served while `MCP_API_KEY` is set (otherwise it returns 404 and OAuth is the only way in):

1. Open `http://localhost:8787/connect` yourself (the server no longer opens a browser)
2. User sees a Simplifi-branded login form (CSRF nonce, rate limited to 5 attempts per 15 minutes)
3. The browser posts your credentials to this server, which forwards them to Quicken's API; they are held in memory only (for the duration of an MFA step) and never written to disk
4. If MFA is required, a verification code page is shown mid-flow
5. On success, only the OAuth **tokens** are stored in SQLite — credentials are never written anywhere
6. On dataset ID discovery, the ID is stored in SQLite too

`SIMPLIFI_EMAIL` and `SIMPLIFI_PASSWORD` are now **optional** in `.env`.

### Session expiry

When the Quicken refresh token expires and there are no `.env` credentials to fall back on, `getAccessToken()` revokes all OAuth refresh tokens so OAuth clients re-run the login, and throws a "re-authenticate" error. Static-key users reconnect at `/connect`.

### Restricting who can log in

Set `ALLOWED_EMAIL` (comma separated) so only your Quicken account can complete `/oauth/authorize` or `/connect`. Without it, any valid Quicken login replaces the stored session.

Sign-in attempts are rate limited: `/oauth/authorize` allows 5 failed logins and `/oauth/mfa` 10 code attempts per 15 minutes (`/connect` has its own limit). The limits are one global bucket rather than per client, because behind a tunnel all requests share the proxy's address.

**Files changed:** `src/http/server.ts` (gated `/connect` and `/connect/mfa` routes), `src/simplifi/auth-service.ts` (`attemptLoginWithCredentials`, allowed-email check)

---

## 5. Setup Wizard

```bash
yarn setup
```

Generates a random `MCP_API_KEY`, writes it to `.env`, and prints the exact `claude mcp add` command. No manual `.env` editing required for a first-time setup.

After running `yarn setup`, build and start the server with `yarn build && yarn start`, then open `http://localhost:8787/connect` to sign in to Quicken.

---

## Minimum Required Configuration

Upstream required 8+ env vars including Simplifi credentials and OAuth secrets. This fork requires only:

```bash
MCP_API_KEY=<random>   # generated by `yarn setup`
```

Everything else is auto-detected or handled interactively.

---

## File Change Summary

| File | Change |
|---|---|
| `src/types.ts` | Added `TagRef`, `Dataset`, `DatasetListResponse`; added `tags` field to `Transaction` |
| `src/config.ts` | Made `SIMPLIFI_EMAIL`, `PASSWORD`, `DATASET_ID`, and all OAuth fields optional; added `MCP_API_KEY` / `staticApiKey` |
| `src/db/database.ts` | Added `simplifi_config` table; `getDatasetId`/`saveDatasetId`; `listTransactionsByTag` |
| `src/simplifi/client.ts` | Dynamic dataset ID resolution; `listDatasets()`; `authedRequestNoDataset()` |
| `src/simplifi/auth-service.ts` | `attemptLoginWithCredentials()` (with `ALLOWED_EMAIL` check); OAuth token revocation on session expiry; optional config credentials |
| `src/services/transaction-tool-service.ts` | `createTag`, `tagTransaction`, `untagTransaction`, `setTransactionTags`, `setTransactionMemo`, `listTransactionsByTag` |
| `src/mcp/server.ts` | 6 new tool registrations |
| `src/http/server.ts` | `/connect` and `/connect/mfa` routes (only with `MCP_API_KEY`); static key or JWT on `/mcp`; Quicken login on `/oauth/authorize` |
| `src/index.ts` | Readiness/sync wiring (no browser auto-open) |
| `src/setup.ts` | New file — setup wizard |
| `docs/` | New directory — this file and auth plan |
