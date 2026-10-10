import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { AppConfig } from "../config.js";
import { logInfo, logWarn } from "../logger.js";
import { loginPage, mfaPage, redirectPage, successPage, type MfaInfo } from "./pages.js";
import { createMcpServer } from "../mcp/server.js";
import { OAuthService } from "../oauth/oauth-service.js";
import { SimplifiAuthService } from "../simplifi/auth-service.js";
import type { AttemptLoginResult } from "../simplifi/auth-service.js";
import { SimplifiClient } from "../simplifi/client.js";
import { TransactionToolService } from "../services/transaction-tool-service.js";

interface HttpServerDeps {
  config: AppConfig;
  oauthService: OAuthService;
  simplifiAuthService: SimplifiAuthService;
  simplifiClient: SimplifiClient;
  toolService: TransactionToolService;
  isReady: () => boolean;
  initializeSync: () => Promise<unknown>;
  notifyActivity: () => void;
}

export interface RunningHttpServer {
  close: () => Promise<void>;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

function readBearerToken(req: Request): string | null {
  const header = req.header("authorization");
  if (!header) {
    return null;
  }

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export async function startHttpServer(deps: HttpServerDeps): Promise<RunningHttpServer> {
  const { config, oauthService, simplifiAuthService, simplifiClient, toolService, isReady, initializeSync } = deps;

  const app = express();
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let connectNonce = randomBytes(32).toString("hex");
  let connectNonceExpiresAt = Date.now() + 15 * 60 * 1000;

  function currentConnectNonce(): string {
    if (Date.now() >= connectNonceExpiresAt) {
      connectNonce = randomBytes(32).toString("hex");
      connectNonceExpiresAt = Date.now() + 15 * 60 * 1000;
    }
    return connectNonce;
  }

  function isValidConnectNonce(value: unknown): boolean {
    if (typeof value !== "string" || Date.now() >= connectNonceExpiresAt) return false;
    const submitted = Buffer.from(value);
    const expected = Buffer.from(connectNonce);
    return submitted.length === expected.length && timingSafeEqual(submitted, expected);
  }

  // Externally visible origin: the PUBLIC_BASE_URL override if set, else what the client actually used
  // (honouring a reverse proxy's X-Forwarded-Proto/Host).
  const baseUrl = (req: Request): string => {
    if (config.server.publicBaseUrl) return config.server.publicBaseUrl;
    const first = (v: string | undefined) => v?.split(",")[0]?.trim();
    const proto = first(req.header("x-forwarded-proto")) ?? req.protocol;
    const host = first(req.header("x-forwarded-host")) ?? req.header("host") ?? `localhost:${config.server.port}`;
    return `${proto}://${host}`;
  };

  // Request log for the auth/discovery surface only (no query strings or bodies, which can hold codes).
  app.use((req, res, next) => {
    if (/^\/(oauth|\.well-known|mcp)/.test(req.path)) {
      res.on("finish", () => {
        logInfo("request", {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          origin: req.header("origin"),
          userAgent: req.header("user-agent")?.slice(0, 80),
        });
      });
    }
    next();
  });

  app.disable("x-powered-by");
  app.use(
    cors({
      origin: config.server.corsOrigin === "*" ? true : config.server.corsOrigin,
      credentials: false,
    }),
  );
  app.use("/connect", (_req, res, next) => {
    res.removeHeader("Access-Control-Allow-Origin");
    res.removeHeader("Access-Control-Allow-Credentials");
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    res.status(200).json(oauthService.getMetadata(baseUrl(req)));
  });

  app.get("/.well-known/openid-configuration", (req, res) => {
    res.status(200).json(oauthService.getMetadata(baseUrl(req)));
  });

  // Guard the Quicken sign-in against password/MFA guessing through this server. Behind a tunnel every
  // client shares the proxy's address, so these act as one global bucket, which suits a single-user server.
  const attemptLimiter = (limit: number, skipSuccessfulRequests: boolean) =>
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit,
      skipSuccessfulRequests,
      standardHeaders: true,
      legacyHeaders: false,
      validate: { xForwardedForHeader: false },
      handler: (_req, res) => {
        res.status(429).type("text/plain").send("Too many sign-in attempts. Try again later.");
      },
    });
  // Failed logins come back as 4xx, so only those count; a code check always answers 200, so count them all.
  const authorizeRateLimit = attemptLimiter(5, true);
  const mfaRateLimit = attemptLimiter(10, false);

  app.get("/oauth/authorize", (req, res) => {
    try {
      const request = oauthService.parseAuthorizeRequest(toRecord(req.query));
      res.status(200).type("html").send(oauthService.buildAuthorizePage(request));
    } catch (error) {
      res.status(400).type("text/plain").send(error instanceof Error ? error.message : "Invalid authorize request");
    }
  });

  app.post("/oauth/register", (req, res) => {
    // Registration bodies are client metadata (no secrets); log them to debug client compatibility.
    logInfo("OAuth client registration", { body: toRecord(req.body), userAgent: req.header("user-agent") });
    const response = oauthService.buildClientRegistrationResponse(toRecord(req.body), baseUrl(req));
    res.status(201).json(response);
  });

  app.post("/oauth/authorize", authorizeRateLimit, async (req, res) => {
    try {
      const request = oauthService.parseAuthorizeRequest(toRecord(req.body));
      const email = typeof req.body.email === "string" ? req.body.email.trim() : "";
      const password = typeof req.body.password === "string" ? req.body.password : "";

      if (!email || !password) {
        res.status(400).type("html").send(oauthService.buildAuthorizePage(request, "Email and password are required."));
        return;
      }

      const result = await simplifiAuthService.attemptLoginWithCredentials(email, password);

      if (result.status === "mfa_required") {
        res
          .status(200)
          .type("html")
          .send(oauthService.buildMfaPage(request, result.pendingId, result));
        return;
      }

      void simplifiClient.getDatasetId().catch(() => {});
      const code = oauthService.issueAuthorizationCode(request);
      const redirect = oauthService.buildAuthorizeRedirect(request, code);
      res.set("Cache-Control", "no-store").status(200).type("html").send(redirectPage(redirect));
    } catch (error) {
      logWarn("OAuth authorize failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(400).type("text/plain").send(error instanceof Error ? error.message : "Invalid authorize request");
    }
  });

  app.post("/oauth/mfa", mfaRateLimit, async (req, res) => {
    try {
      const request = oauthService.parseAuthorizeRequest(toRecord(req.body));
      const pendingId = typeof req.body.pending_mfa_id === "string" ? req.body.pending_mfa_id : "";
      const mfaCode = typeof req.body.mfa_code === "string" ? req.body.mfa_code.trim() : "";

      if (!pendingId || !mfaCode) {
        res.status(400).type("text/plain").send("Missing pending_mfa_id or mfa_code");
        return;
      }

      try {
        await simplifiAuthService.completeMfaLogin(pendingId, mfaCode);
      } catch (mfaError) {
        const mfaInfo = simplifiAuthService.getPendingMfaInfo(pendingId) ?? {
          mfaChannel: "EMAIL",
        };
        res
          .status(200)
          .type("html")
          .send(
            oauthService.buildMfaPage(
              request,
              pendingId,
              mfaInfo,
              mfaError instanceof Error ? mfaError.message : "Verification failed. Please try again.",
            ),
          );
        return;
      }

      void simplifiClient.getDatasetId().catch(() => {});
      const code = oauthService.issueAuthorizationCode(request);
      const redirect = oauthService.buildAuthorizeRedirect(request, code);
      res.set("Cache-Control", "no-store").status(200).type("html").send(redirectPage(redirect));
    } catch (error) {
      res.status(400).type("text/plain").send(error instanceof Error ? error.message : "Invalid MFA request");
    }
  });

  app.post("/oauth/token", (req, res) => {
    try {
      const payload = oauthService.exchangeToken(toRecord(req.body));
      res.status(200).json(payload);
    } catch (error) {
      res.status(400).json({
        error: "invalid_request",
        error_description: error instanceof Error ? error.message : "Token request failed",
      });
    }
  });

  // ── Simplifi browser connect flow ──────────────────────────────────────────
  // Credentials are typed here, POSTed to Quicken's API, and never written to disk.
  // Only the resulting OAuth tokens are stored in the local SQLite cache.

  function connectPage(
    opts: { error?: string; mfa?: { pendingId: string; info: MfaInfo }; success?: boolean } = {},
  ): string {
    if (opts.success) {
      return successPage();
    }
    if (opts.mfa) {
      return mfaPage({
        action: "/connect/mfa",
        hidden: { connect_nonce: currentConnectNonce(), pending_id: opts.mfa.pendingId },
        mfaInfo: opts.mfa.info,
        errorMessage: opts.error,
      });
    }
    return loginPage({
      action: "/connect",
      hidden: { connect_nonce: currentConnectNonce() },
      subtitle: "Enter your Quicken Simplifi credentials to link your account.",
      errorMessage: opts.error,
    });
  }

  function requireConnectNonce(req: Request, res: Response, next: NextFunction): void {
    if (!isValidConnectNonce(req.body.connect_nonce)) {
      res.status(403).type("html").send(connectPage({ error: "Invalid or expired connection request. Reload this page." }));
      return;
    }
    next();
  }

  const connectRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).type("text/plain").send("Too many connection attempts. Try again later.");
    },
  });

  // /connect only exists when MCP_API_KEY is set; otherwise OAuth is the only way in.
  app.use("/connect", (_req, res, next) => {
    if (!config.oauth.staticApiKey) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    next();
  });

  app.get("/connect", (_req, res) => {
    if (isReady()) {
      res.status(200).type("html").send(connectPage({ success: true }));
      return;
    }
    res.status(200).type("html").send(connectPage());
  });

  app.post("/connect", requireConnectNonce, connectRateLimit, async (req, res) => {
    const email = typeof req.body.email === "string" ? req.body.email.trim() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";

    if (!email || !password) {
      res.status(400).type("html").send(connectPage({ error: "Email and password are required." }));
      return;
    }

    let result: AttemptLoginResult;
    try {
      result = await simplifiAuthService.attemptLoginWithCredentials(email, password);
    } catch (error) {
      logWarn("Simplifi connect login failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(200).type("html").send(connectPage({ error: "Login failed. Check your email and password." }));
      return;
    }

    if (result.status === "mfa_required") {
      res.status(200).type("html").send(
        connectPage({ mfa: { pendingId: result.pendingId, info: result } }),
      );
      return;
    }

    try {
      await simplifiClient.getDatasetId();
      await initializeSync();
      res.status(200).type("html").send(connectPage({ success: true }));
    } catch (error) {
      logWarn("Simplifi initial sync after login failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(200).type("html").send(
        connectPage({ error: "Account connected, but initial data sync failed. Retry connecting to finish setup." }),
      );
    }
  });

  app.post("/connect/mfa", requireConnectNonce, connectRateLimit, async (req, res) => {
    const pendingId = typeof req.body.pending_id === "string" ? req.body.pending_id : "";
    const mfaCode = typeof req.body.mfa_code === "string" ? req.body.mfa_code.trim() : "";

    if (!pendingId || !mfaCode) {
      res.status(400).type("html").send(connectPage({ error: "Missing verification data." }));
      return;
    }

    const mfaInfo = simplifiAuthService.getPendingMfaInfo(pendingId);
    if (!mfaInfo) {
      res.status(400).type("html").send(connectPage({ error: "Session expired. Please sign in again." }));
      return;
    }

    try {
      await simplifiAuthService.completeMfaLogin(pendingId, mfaCode);
    } catch (error) {
      res.status(200).type("html").send(
        connectPage({ mfa: { pendingId, info: mfaInfo }, error: "Incorrect code. Try again." }),
      );
      return;
    }

    try {
      await simplifiClient.getDatasetId();
      await initializeSync();
      res.status(200).type("html").send(connectPage({ success: true }));
    } catch (error) {
      logWarn("Simplifi initial sync after MFA failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(200).type("html").send(
        connectPage({ error: "Account connected, but initial data sync failed. Retry connecting to finish setup." }),
      );
    }
  });

  // ───────────────────────────────────────────────────────────────────────────

  // RFC 9728 protected-resource metadata: tells MCP clients which authorization server guards /mcp.
  // Served at the root and at the path-suffixed location for the /mcp resource.
  const protectedResourceMetadata = (req: Request, res: Response): void => {
    const base = baseUrl(req);
    res.status(200).json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp:read", "mcp:write"],
    });
  };
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);

  // RFC 6750 / RFC 9728: point unauthenticated clients at the metadata so they can start the OAuth flow.
  const unauthorized = (req: Request, res: Response, description: string, hadToken: boolean): void => {
    const metadataUrl = `${baseUrl(req)}/.well-known/oauth-protected-resource`;
    const params = [`resource_metadata="${metadataUrl}"`];
    if (hadToken) {
      params.unshift('error="invalid_token"', `error_description="${description.replace(/"/g, "'")}"`);
    }
    res.set("WWW-Authenticate", `Bearer ${params.join(", ")}`);
    res.status(401).json({ error: "invalid_token", error_description: description });
  };

  const requireAccessToken = (req: Request, res: Response, next: NextFunction): void => {
    const token = readBearerToken(req);
    if (!token) {
      unauthorized(req, res, "Missing bearer token", false);
      return;
    }

    // Optional static API key (constant-time compare); otherwise fall through to OAuth JWT validation.
    const staticKey = config.oauth.staticApiKey;
    if (staticKey) {
      const submitted = Buffer.from(token);
      const expected = Buffer.from(staticKey);
      if (submitted.length === expected.length && timingSafeEqual(submitted, expected)) {
        next();
        return;
      }
    }

    try {
      oauthService.verifyAccessToken(token);
      next();
    } catch (error) {
      unauthorized(req, res, error instanceof Error ? error.message : "Token verification failed", true);
    }
  };

  // Handle all MCP requests (GET for SSE, POST for JSON-RPC, DELETE for session close).
  // A new McpServer+transport pair is created per session; the transport itself validates
  // session IDs and whether the first request is an initialize — no manual pre-checks needed.
  app.all("/mcp", requireAccessToken, async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    let transport = sessionId ? sessions.get(sessionId) : undefined;

    try {
      if (!transport) {
        const mcpServer = createMcpServer(toolService, deps.notifyActivity);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            sessions.set(newSessionId, transport!);
          },
        });

        transport.onclose = () => {
          if (transport!.sessionId) {
            sessions.delete(transport!.sessionId);
          }
        };

        await mcpServer.connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logWarn("Error handling /mcp request", {
        error: error instanceof Error ? error.message : String(error),
        method: req.method,
      });

      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error", error_description: "Failed to handle MCP request" });
      }
    }
  });

  app.get("/", (req, res) => {
    res.status(200).json({
      name: "quicken-simplifi-mcp",
      status: "ok",
      mcp: `${baseUrl(req)}/mcp`,
      oauthAuthorize: `${baseUrl(req)}/oauth/authorize`,
      oauthToken: `${baseUrl(req)}/oauth/token`,
    });
  });

  const server = app.listen(config.server.port, config.server.host);
  await new Promise<void>((resolve) => {
    server.once("listening", () => resolve());
  });

  const address = server.address() as AddressInfo;
  logInfo("HTTP server started", {
    host: address.address,
    port: address.port,
  });

  return {
    close: async () => {
      // server.close() only resolves once every connection ends, and MCP clients keep streaming (SSE)
      // connections open indefinitely, so close the transports and drop remaining connections ourselves.
      const closing = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });

      await Promise.allSettled([...sessions.values()].map((transport) => transport.close()));
      sessions.clear();
      server.closeIdleConnections();
      // Give in-flight responses a moment to finish, then cut whatever is left.
      const force = setTimeout(() => server.closeAllConnections(), 1000);
      force.unref();

      try {
        await closing;
      } finally {
        clearTimeout(force);
      }
    },
  };
}
