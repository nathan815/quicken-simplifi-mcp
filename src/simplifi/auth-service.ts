import { URL } from "node:url";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import { logInfo, logWarn } from "../logger.js";
import type { SimplifiTokenSet } from "../types.js";
import { isExpired, nowIso } from "../utils.js";
import { DatabaseContext } from "../db/database.js";

const AUTHORIZATION_SKEW_MS = 60_000;

interface PendingMfa {
  mfaId: string;
  mfaChannel: string;
  email?: string;
  phone?: string;
  threatMetrixSessionId: string;
  expiresAt: number;
  // credentials held in-memory only for the duration of the connect flow
  loginEmail?: string;
  loginPassword?: string;
  expiryTimer: NodeJS.Timeout;
}

export type AttemptLoginResult =
  | { status: "ok" }
  | { status: "mfa_required"; pendingId: string; mfaChannel: string; email?: string; phone?: string };

export class SimplifiAuthService {
  private readonly pendingMfaMap = new Map<string, PendingMfa>();
  private reauthCallback?: () => void;
  private reauthDebounceTimer?: ReturnType<typeof setTimeout>;

  public constructor(
    private readonly config: AppConfig["simplifi"],
    private readonly db: DatabaseContext,
  ) {}

  /** Register a callback that fires (at most once per 10s) when the server needs the user to reconnect. */
  public onNeedsReauth(callback: () => void): void {
    this.reauthCallback = callback;
  }

  private triggerReauth(): void {
    if (this.reauthDebounceTimer) return;
    this.reauthCallback?.();
    this.reauthDebounceTimer = setTimeout(() => {
      this.reauthDebounceTimer = undefined;
    }, 10_000);
  }

  public async getAccessToken(): Promise<string> {
    const cached = this.db.getSimplifiTokens();

    if (cached && !isExpired(cached.accessTokenExpiresAt, AUTHORIZATION_SKEW_MS)) {
      return cached.accessToken;
    }

    if (cached?.refreshToken) {
      try {
        const refreshed = await this.refreshToken(cached.refreshToken);
        this.db.saveSimplifiTokens(refreshed);
        return refreshed.accessToken;
      } catch (error) {
        logWarn("Simplifi token refresh failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.db.deleteSimplifiTokens();
      }
    }

    if (cached) this.db.deleteSimplifiTokens();

    // No .env credentials to fall back on — revoke OAuth tokens so Claude.ai triggers re-auth.
    if (!this.config.email || !this.config.password) {
      this.db.revokeAllOAuthRefreshTokens();
      this.triggerReauth();
      throw new Error(
        "Quicken session expired. Please re-authenticate via OAuth.",
      );
    }

    const created = await this.loginWithCredentials();
    this.db.saveSimplifiTokens(created);
    return created.accessToken;
  }

  /**
   * Login using explicit credentials (browser connect flow — credentials never written to disk).
   * If MFA is required, returns a pendingId that must be resolved via completeMfaLogin().
   */
  public async attemptLoginWithCredentials(loginEmail: string, loginPassword: string): Promise<AttemptLoginResult> {
    const threatMetrixSessionId = randomUUID();
    const authorizeResponse = await this.callAuthorize({
      email: loginEmail,
      password: loginPassword,
      mfaChannel: null,
      mfaCode: null,
      mfaId: null,
      threatMetrixSessionId,
      threatMetrixRequestId: null,
    });

    if (authorizeResponse.status === 202) {
      const body = (await authorizeResponse.json()) as Record<string, unknown>;
      const mfaId = String(body.mfaId ?? "");
      const mfaChannel = typeof body.mfaChannel === "string" ? body.mfaChannel : "EMAIL";
      const mfaEmailHint = typeof body.email === "string" ? body.email : undefined;
      const phone = typeof body.phone === "string" ? body.phone : undefined;

      const pendingId = randomUUID();
      const pending: PendingMfa = {
        mfaId,
        mfaChannel,
        email: mfaEmailHint,
        phone,
        threatMetrixSessionId,
        expiresAt: Date.now() + 10 * 60 * 1000,
        loginEmail,
        loginPassword,
        expiryTimer: setTimeout(() => this.deletePendingMfa(pendingId), 10 * 60 * 1000),
      };
      pending.expiryTimer.unref();
      this.pendingMfaMap.set(pendingId, pending);

      return { status: "mfa_required", pendingId, mfaChannel, email: mfaEmailHint, phone };
    }

    const token = await this.processSuccessfulAuthorize(authorizeResponse);
    this.db.saveSimplifiTokens(token);
    logInfo("Simplifi browser connect login completed");
    return { status: "ok" };
  }

  /**
   * Completes an MFA challenge initiated by attemptLogin(). On success the
   * Simplifi tokens are saved to the database.
   */
  public async completeMfaLogin(pendingId: string, mfaCode: string): Promise<void> {
    const pending = this.pendingMfaMap.get(pendingId);
    if (!pending) {
      throw new Error("MFA session not found or expired. Please restart the authorization flow.");
    }

    if (Date.now() > pending.expiresAt) {
      this.deletePendingMfa(pendingId);
      throw new Error("MFA session expired. Please restart the authorization flow.");
    }

    const authorizeResponse = await this.callAuthorize({
      email: pending.loginEmail,
      password: pending.loginPassword,
      mfaChannel: pending.mfaChannel,
      mfaCode,
      mfaId: pending.mfaId,
      threatMetrixSessionId: pending.threatMetrixSessionId,
      threatMetrixRequestId: this.config.threatMetrixRequestId ?? null,
    });

    if (![200, 201].includes(authorizeResponse.status)) {
      const body = await authorizeResponse.text();
      throw new Error(`Simplifi MFA verification failed: status=${authorizeResponse.status}, body=${body}`);
    }

    const token = await this.processSuccessfulAuthorize(authorizeResponse);
    this.db.saveSimplifiTokens(token);
    this.deletePendingMfa(pendingId);
    logInfo("Simplifi MFA login completed");
  }

  public getPendingMfaInfo(pendingId: string): Pick<PendingMfa, "mfaChannel" | "email" | "phone"> | undefined {
    const pending = this.pendingMfaMap.get(pendingId);
    if (!pending || Date.now() > pending.expiresAt) {
      if (pending) this.deletePendingMfa(pendingId);
      return undefined;
    }
    return { mfaChannel: pending.mfaChannel, email: pending.email, phone: pending.phone };
  }

  private deletePendingMfa(pendingId: string): void {
    const pending = this.pendingMfaMap.get(pendingId);
    if (!pending) return;
    clearTimeout(pending.expiryTimer);
    this.pendingMfaMap.delete(pendingId);
  }

  private async loginWithCredentials(): Promise<SimplifiTokenSet> {
    const threatMetrixSessionId = this.config.threatMetrixSessionId ?? randomUUID();
    const threatMetrixRequestId = this.config.threatMetrixRequestId ?? null;

    const authorizeResponse = await this.callAuthorize({
      mfaChannel: null,
      mfaCode: null,
      mfaId: null,
      threatMetrixSessionId,
      threatMetrixRequestId,
    });

    if (authorizeResponse.status === 202) {
      const body = await authorizeResponse.text();
      throw new Error(
        `Simplifi MFA required. Please re-authorize your MCP client via the OAuth login flow. body=${body}`,
      );
    }

    if (![200, 201].includes(authorizeResponse.status)) {
      const body = await authorizeResponse.text();
      throw new Error(`Simplifi authorize failed: status=${authorizeResponse.status}, body=${body}`);
    }

    const token = await this.processSuccessfulAuthorize(authorizeResponse);
    logInfo("Simplifi credential login completed");
    return token;
  }

  private async callAuthorize(opts: {
    email?: string;
    password?: string;
    mfaChannel: string | null;
    mfaCode: string | null;
    mfaId: string | null;
    threatMetrixSessionId: string;
    threatMetrixRequestId: string | null;
  }): Promise<Response> {
    const authorizeUrl = new URL("/oauth/authorize", this.config.baseUrl);

    return this.request(authorizeUrl.toString(), {
      method: "POST",
      body: JSON.stringify({
        clientId: this.config.clientId,
        username: opts.email ?? this.config.email,
        password: opts.password ?? this.config.password,
        redirectUri: this.config.redirectUri,
        responseType: "code",
        mfaChannel: opts.mfaChannel,
        mfaCode: opts.mfaCode,
        mfaId: opts.mfaId,
        threatMetrixRequestId: opts.threatMetrixRequestId,
        threatMetrixSessionId: opts.threatMetrixSessionId,
      }),
      headers: {
        "tm-session-id": opts.threatMetrixSessionId,
      },
    });
  }

  private async processSuccessfulAuthorize(response: Response): Promise<SimplifiTokenSet> {
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("Simplifi authorize did not return a location header with auth code");
    }

    const codeUrl = new URL(location);
    const code = codeUrl.searchParams.get("code");
    if (!code) {
      throw new Error("Simplifi authorize location header missing authorization code");
    }

    return this.exchangeAuthorizationCode(code);
  }

  private async refreshToken(refreshToken: string): Promise<SimplifiTokenSet> {
    const tokenUrl = new URL("/oauth/token", this.config.baseUrl);

    const response = await this.request(tokenUrl.toString(), {
      method: "POST",
      body: JSON.stringify({
        grantType: "refreshToken",
        responseType: "token",
        redirectUri: this.config.redirectUri,
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        refreshToken,
      }),
    });

    if (response.status !== 200) {
      const body = await response.text();
      throw new Error(`Simplifi token refresh failed: status=${response.status}, body=${body}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return this.parseTokenPayload(payload);
  }

  private async exchangeAuthorizationCode(code: string): Promise<SimplifiTokenSet> {
    const tokenUrl = new URL("/oauth/token", this.config.baseUrl);

    const response = await this.request(tokenUrl.toString(), {
      method: "POST",
      body: JSON.stringify({
        grantType: "authorization_code",
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        code,
        redirectUri: this.config.redirectUri,
      }),
    });

    if (response.status !== 200) {
      const body = await response.text();
      throw new Error(`Simplifi token exchange failed: status=${response.status}, body=${body}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return this.parseTokenPayload(payload);
  }

  private parseTokenPayload(payload: Record<string, unknown>): SimplifiTokenSet {
    const accessToken = this.pickString(payload, "accessToken") ?? this.pickString(payload, "access_token");
    const refreshToken = this.pickString(payload, "refreshToken") ?? this.pickString(payload, "refresh_token");

    if (!accessToken || !refreshToken) {
      throw new Error("Simplifi token response did not include access and refresh tokens");
    }

    const accessTokenExpiresAt =
      this.pickString(payload, "accessTokenExpired") ??
      this.calculateExpiryFromSeconds(payload.expires_in) ??
      new Date(Date.now() + 55 * 60 * 1000).toISOString();

    const refreshTokenExpiresAt = this.pickString(payload, "refreshTokenExpired") ?? undefined;

    return {
      accessToken,
      accessTokenExpiresAt,
      refreshToken,
      refreshTokenExpiresAt,
    };
  }

  private pickString(payload: Record<string, unknown>, key: string): string | undefined {
    const value = payload[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private calculateExpiryFromSeconds(value: unknown): string | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return undefined;
    }
    return new Date(Date.now() + value * 1000).toISOString();
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);

    try {
      return await fetch(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "content-type": "application/json;charset=UTF-8",
          accept: "application/json, text/plain, */*",
          "app-client-id": this.config.clientId,
          "app-release": "6.5.0",
          "app-build": "63580",
          ...(init.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  public clearTokens(): void {
    this.db.saveSimplifiTokens({
      accessToken: "",
      accessTokenExpiresAt: nowIso(),
      refreshToken: "",
    });
  }
}
