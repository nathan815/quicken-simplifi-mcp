# Plan: Unified OAuth Flow (No Stored Credentials)

> **Status: implemented.** Deviations from the plan below: `/connect` was kept (served only when `MCP_API_KEY` is set, for clients that cannot do OAuth); `MCP_API_KEY` is an opt-in alternative to OAuth JWTs on `/mcp`; and `ALLOWED_EMAIL` restricts which Quicken account may log in.

## Problem

The current auth setup has two separate credential concerns:

1. **Quicken credentials** — handled by the browser `/connect` page (not stored on disk ✓)
2. **MCP gate credentials** — `OAUTH_LOGIN_USERNAME` / `OAUTH_LOGIN_PASSWORD` stored in `.env` (separate from Quicken, still on disk)

For a **remote deployment** targeting Claude.ai, the full OAuth flow is required (Claude.ai won't accept a static `MCP_API_KEY`). That means the user must manage two sets of credentials: one for Quicken, one for the MCP gate. They also have to visit two pages on first setup: the OAuth authorize page and the `/connect` page.

There's also no tight coupling between Quicken session health and OAuth token validity — if the Quicken refresh token expires, the server errors but Claude.ai doesn't know to re-authenticate.

## Proposed Solution

**Merge both flows into one.** Replace the generic username/password OAuth gate with the Quicken login itself. Your Quicken identity becomes your identity for the MCP.

No `OAUTH_LOGIN_USERNAME` or `OAUTH_LOGIN_PASSWORD` needed. No separate `/connect` page. One browser flow handles everything.

---

## New Unified Flow

### First connection (Claude.ai adds the MCP)

```
Claude.ai discovers OAuth metadata
        ↓
Opens browser → GET /oauth/authorize
        ↓
User sees Quicken login form (email + password)
        ↓
Server POSTs credentials to Quicken's API
        ↓   [if MFA required → MFA code page → verify]
        ↓
Quicken tokens stored in SQLite
Dataset ID auto-detected and stored
        ↓
Server issues OAuth auth code → redirect to Claude.ai
        ↓
Claude.ai exchanges code for tokens (the OAuth refresh token's expiry is tied to the Quicken refresh token; the JWT access token stays short-lived)
        ↓
MCP connected. Both auth layers satisfied in one browser session.
```

### Token expiry and reconnection

```
Quicken refresh token expires (~30 days)
        ↓
Server attempts refresh → fails
        ↓
Server revokes all stored OAuth refresh tokens in SQLite
        ↓
Claude.ai next tool call → 401 (refresh token rejected)
        ↓
Claude.ai re-runs OAuth flow → Quicken login page
        ↓
User logs in → fresh Quicken tokens + fresh OAuth JWT
```

---

## Implementation Plan

### 1. Update `/oauth/authorize` GET — show Quicken login form

Replace the generic "Username / Password" form with a Quicken-branded email/password form. Reuse the styling from the existing `/connect` page.

**File:** `src/oauth/oauth-service.ts` — `buildAuthorizePage()`

```typescript
// Before: shows OAUTH_LOGIN_USERNAME / OAUTH_LOGIN_PASSWORD fields
// After: shows Quicken email / password fields with Simplifi branding
```

### 2. Update `POST /oauth/authorize` handler — authenticate to Quicken

Replace `oauthService.validateLogin(username, password)` with `simplifiAuthService.attemptLoginWithCredentials(email, password)`.

If MFA is required, show the MFA page before issuing the auth code — exactly as the current `/connect/mfa` flow works, but embedded in the OAuth authorize response.

**File:** `src/http/server.ts`

```typescript
// Before:
if (!oauthService.validateLogin(username, password)) { ... }
const result = await simplifiAuthService.attemptLogin(); // uses .env creds

// After:
const result = await simplifiAuthService.attemptLoginWithCredentials(email, password);
if (result.status === 'mfa_required') {
  res.send(oauthService.buildMfaPage(...));
  return;
}
// issue auth code
```

### 3. Tie the OAuth refresh token lifetime to the Quicken refresh token

After a successful Quicken login, the response includes `refreshTokenExpired` (an ISO timestamp). Use that as the expiry of the OAuth refresh token. The JWT access token keeps its short TTL (`OAUTH_ACCESS_TOKEN_TTL_SECONDS`) and is renewed with the refresh token.

**File:** `src/oauth/oauth-service.ts` — `issueTokenPair()`

```typescript
// OAuth refresh token expires with the Quicken refresh token; the JWT access token stays short-lived
const refreshExpiresAt = simplifiTokens?.refreshTokenExpiresAt ?? fallbackFromConfig;
```

This means the OAuth session naturally ends when the Quicken session would expire — no manual coordination needed.

### 4. Revoke OAuth tokens when Quicken refresh fails

In `SimplifiAuthService.getAccessToken()`, when the Quicken refresh attempt fails and there are no credentials to fall back on, revoke all OAuth refresh tokens in addition to triggering the reauth callback.

**File:** `src/simplifi/auth-service.ts`

```typescript
// When Quicken refresh fails:
this.db.revokeAllOAuthRefreshTokens();
this.triggerReauth();
throw new Error('Quicken session expired — please reconnect');
```

Add `revokeAllOAuthRefreshTokens()` to `DatabaseContext`:

**File:** `src/db/database.ts`

```sql
UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE revoked_at IS NULL
```

### 5. Remove `/connect` page

The `/connect` and `/connect/mfa` routes become redundant — everything they did is now handled by `/oauth/authorize`. Remove them from `src/http/server.ts`.

The `openConnectPage()` logic in `index.ts` also goes away — the `onNeedsReauth` callback becomes a no-op for local use (Claude.ai handles it via OAuth re-auth automatically).

### 6. Update config

Remove `loginUsername` and `loginPassword` from `AppConfig.oauth`. They're no longer used.

**File:** `src/config.ts`

### 7. Update `.env.example`

```bash
# No OAUTH_LOGIN_USERNAME / OAUTH_LOGIN_PASSWORD needed
# No SIMPLIFI_EMAIL / SIMPLIFI_PASSWORD needed
# No MCP_API_KEY for remote deployments (use OAuth)

OAUTH_JWT_SECRET=<random-32-bytes>
OAUTH_ALLOWED_REDIRECT_URIS=https://claude.ai/api/mcp/auth/callback

PUBLIC_BASE_URL=https://your-server.com
```

---

## What Gets Removed

| Thing | Reason |
|---|---|
| `OAUTH_LOGIN_USERNAME` | Replaced by Quicken email |
| `OAUTH_LOGIN_PASSWORD` | Replaced by Quicken password |
| `OAuthService.validateLogin()` | No longer called |
| `/connect` and `/connect/mfa` routes | Merged into OAuth flow |
| `openConnectPage()` in `index.ts` | Not needed — Claude.ai triggers re-auth |
| `onNeedsReauth` browser-open logic | Not needed remotely |

---

## What Stays

- `MCP_API_KEY` static token mode — still useful for local Claude Code/Desktop use without a browser OAuth dance
- All Quicken API client code
- MFA handling — moved from `/connect/mfa` into the `/oauth/mfa` route (or `/oauth/authorize` POST with MFA state)
- Dataset ID auto-detection
- All 5 new tagging/memo tools

---

## Trade-offs

**Gains:**
- Zero credentials stored on disk for remote deployments
- Single browser flow for first-time setup
- Token lifetimes are coupled — Quicken expiry automatically triggers Claude re-auth
- No separate MCP password to manage or forget

**Losses:**
- Slightly more complex OAuth authorize handler (must handle Quicken MFA mid-flow)
- If Quicken is down during the OAuth flow, connecting Claude.ai fails entirely
- JWT TTL is now dynamic (set at login time) rather than a fixed config value

**Risk:** The Quicken OAuth flow currently uses hardcoded `acme_web` client credentials reverse-engineered from their web app. If Quicken changes their auth endpoints or secrets, the entire connect flow breaks. This is inherent to the unofficial API approach and not specific to this plan.
