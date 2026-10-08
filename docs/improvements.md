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

A `MCP_API_KEY` environment variable. When set, the server skips all JWT validation and accepts that value as a static bearer token:

```bash
MCP_API_KEY=<any-random-string>
```

Connect Claude Code:

```bash
claude mcp add simplifi --transport http http://localhost:8787/mcp \
  --header "Authorization: Bearer <MCP_API_KEY>"
```

### What becomes optional

When `MCP_API_KEY` is set, these env vars are no longer required:

- `OAUTH_JWT_SECRET`
- `OAUTH_LOGIN_USERNAME`
- `OAUTH_LOGIN_PASSWORD`

The full OAuth server is still present and works unchanged — `MCP_API_KEY` just bypasses it. For remote deployments or Claude.ai web, leave `MCP_API_KEY` unset and use the OAuth flow as normal.

---

## 3. Auto Dataset ID Detection

The upstream server required `SIMPLIFI_DATASET_ID` — a numeric ID you had to find manually by inspecting network requests in browser DevTools.

### What we added

After a successful Simplifi login, the server calls `GET /datasets`, takes the first result's `id`, and stores it in a `simplifi_config` SQLite table. `SIMPLIFI_DATASET_ID` is now **optional** in `.env`.

```
Login → GET /datasets → store dataset_id → use on all subsequent API calls
```

If you have multiple Simplifi datasets and need a specific one, you can still pin it via `SIMPLIFI_DATASET_ID` in `.env` — that takes precedence over the auto-detected value.

**Files changed:** `src/simplifi/client.ts`, `src/db/database.ts`, `src/config.ts`

---

## 4. Browser-Based Quicken Connect Flow (No Credentials on Disk)

The upstream server required `SIMPLIFI_EMAIL` and `SIMPLIFI_PASSWORD` in `.env`. These credentials sat on disk, accessible to anything with read access to the file.

### What we added

A `/connect` route that handles the entire Quicken auth flow in the browser:

1. Server starts → detects no Simplifi tokens → opens `http://localhost:8787/connect` in the default browser automatically
2. User sees a Simplifi-branded login form
3. Credentials go directly from the browser form to Quicken's API (`POST /oauth/authorize`)
4. If MFA is required, a verification code page is shown mid-flow
5. On success, only the OAuth **tokens** are stored in SQLite — credentials are never written anywhere
6. On dataset ID discovery, the ID is stored in SQLite too

`SIMPLIFI_EMAIL` and `SIMPLIFI_PASSWORD` are now **optional** in `.env`.

### Auto-reopen on session expiry

When `getAccessToken()` fails (refresh token expired, no credentials to fall back on), a debounced `triggerReauth()` fires, re-opening the browser to `/connect`. Multiple concurrent tool call failures produce only one browser open per 10 seconds.

**Files changed:** `src/http/server.ts` (new `/connect` and `/connect/mfa` routes), `src/simplifi/auth-service.ts` (`attemptLoginWithCredentials`, `onNeedsReauth`), `src/index.ts`

---

## 5. Setup Wizard

```bash
yarn setup
```

Generates a random `MCP_API_KEY`, writes it to `.env`, and prints the exact `claude mcp add` command. No manual `.env` editing required for a first-time setup.

After running `yarn setup`, build and start the server with `yarn build && yarn start` — it auto-opens the browser for the Quicken connect flow.

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
| `src/simplifi/auth-service.ts` | `attemptLoginWithCredentials()`; `onNeedsReauth()` callback; debounced reauth; optional config credentials |
| `src/services/transaction-tool-service.ts` | `createTag`, `tagTransaction`, `untagTransaction`, `setTransactionTags`, `setTransactionMemo`, `listTransactionsByTag` |
| `src/mcp/server.ts` | 6 new tool registrations |
| `src/http/server.ts` | `/connect` and `/connect/mfa` routes; static API key middleware |
| `src/index.ts` | `openConnectPage()`; auto-open on first run; `onNeedsReauth` registration |
| `src/setup.ts` | New file — setup wizard |
| `docs/` | New directory — this file and auth plan |
