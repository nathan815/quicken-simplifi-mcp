import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { AppConfig } from "../config.js";
import { logInfo, logWarn } from "../logger.js";
import { createMcpServer } from "../mcp/server.js";
import { OAuthService } from "../oauth/oauth-service.js";
import { SimplifiAuthService } from "../simplifi/auth-service.js";
import { SimplifiClient } from "../simplifi/client.js";
import { TransactionToolService } from "../services/transaction-tool-service.js";

interface HttpServerDeps {
  config: AppConfig;
  oauthService: OAuthService;
  simplifiAuthService: SimplifiAuthService;
  simplifiClient: SimplifiClient;
  toolService: TransactionToolService;
  hasSimplifiTokens: () => boolean;
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
  const { config, oauthService, simplifiAuthService, simplifiClient, toolService, hasSimplifiTokens } = deps;

  const app = express();
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  app.disable("x-powered-by");
  app.use(
    cors({
      origin: config.server.corsOrigin === "*" ? true : config.server.corsOrigin,
      credentials: false,
    }),
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.status(200).json(oauthService.getMetadata(config.server.publicBaseUrl));
  });

  app.get("/.well-known/openid-configuration", (_req, res) => {
    res.status(200).json(oauthService.getMetadata(config.server.publicBaseUrl));
  });

  app.get("/oauth/authorize", (req, res) => {
    try {
      const request = oauthService.parseAuthorizeRequest(toRecord(req.query));
      res.status(200).type("html").send(oauthService.buildAuthorizePage(request));
    } catch (error) {
      res.status(400).type("text/plain").send(error instanceof Error ? error.message : "Invalid authorize request");
    }
  });

  app.post("/oauth/register", (req, res) => {
    const response = oauthService.buildClientRegistrationResponse(toRecord(req.body), config.server.publicBaseUrl);
    res.status(201).json(response);
  });

  app.post("/oauth/authorize", async (req, res) => {
    try {
      const request = oauthService.parseAuthorizeRequest(toRecord(req.body));
      const username = typeof req.body.username === "string" ? req.body.username : "";
      const password = typeof req.body.password === "string" ? req.body.password : "";

      if (!oauthService.validateLogin(username, password)) {
        res.status(401).type("html").send(oauthService.buildAuthorizePage(request, "Invalid credentials"));
        return;
      }

      const result = await simplifiAuthService.attemptLogin();

      if (result.status === "mfa_required") {
        res
          .status(200)
          .type("html")
          .send(oauthService.buildMfaPage(request, result.pendingId, result));
        return;
      }

      const code = oauthService.issueAuthorizationCode(request);
      const redirect = oauthService.buildAuthorizeRedirect(request, code);
      res.redirect(302, redirect);
    } catch (error) {
      res.status(400).type("text/plain").send(error instanceof Error ? error.message : "Invalid authorize request");
    }
  });

  app.post("/oauth/mfa", async (req, res) => {
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

      const code = oauthService.issueAuthorizationCode(request);
      const redirect = oauthService.buildAuthorizeRedirect(request, code);
      res.redirect(302, redirect);
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

  function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function connectPage(opts: { error?: string; mfa?: { pendingId: string; channel: string; hint?: string }; success?: boolean } = {}): string {
    const styles = `
      *{box-sizing:border-box}
      body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f0fdf4;min-height:100vh;display:flex;align-items:center;justify-content:center}
      .card{background:#fff;border:1px solid #bbf7d0;border-radius:16px;padding:32px;width:100%;max-width:400px;box-shadow:0 4px 24px rgba(0,0,0,.06)}
      .logo{display:flex;align-items:center;gap:10px;margin-bottom:24px}
      .logo-mark{width:36px;height:36px;background:#15803d;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:18px}
      h1{margin:0 0 4px;font-size:20px;font-weight:700;color:#14532d}
      p.sub{margin:0 0 20px;color:#4b5563;font-size:14px}
      label{display:block;font-size:13px;font-weight:500;color:#374151;margin-bottom:6px}
      input[type=email],input[type=password],input[type=text]{width:100%;padding:10px 12px;border:1.5px solid #d1fae5;border-radius:8px;font-size:15px;outline:none;transition:.15s}
      input:focus{border-color:#16a34a;box-shadow:0 0 0 3px rgba(22,163,74,.12)}
      .field{margin-bottom:16px}
      button[type=submit]{width:100%;padding:11px;background:#16a34a;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;transition:.15s}
      button:hover{background:#15803d}
      .error{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:16px}
      .notice{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;border-radius:8px;padding:10px 14px;font-size:12px;margin-bottom:20px}
      .success{text-align:center;padding:8px 0}
      .check{font-size:48px;margin-bottom:12px}
    `;

    if (opts.success) {
      return `<!doctype html><html><head><meta charset="utf-8"><title>Connected</title><style>${styles}</style></head>
<body><div class="card">
  <div class="logo"><div class="logo-mark">S</div><span style="font-weight:700;font-size:18px;color:#14532d">Simplifi MCP</span></div>
  <div class="success">
    <div class="check">✅</div>
    <h1>Connected!</h1>
    <p style="color:#4b5563;font-size:14px;margin:8px 0 0">Your Simplifi account is linked. You can close this tab — the MCP server is ready.</p>
  </div>
</div></body></html>`;
    }

    if (opts.mfa) {
      const hint = opts.mfa.hint ? ` (${escapeHtml(opts.mfa.hint)})` : "";
      const err = opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : "";
      return `<!doctype html><html><head><meta charset="utf-8"><title>Verify — Simplifi MCP</title><style>${styles}</style></head>
<body><div class="card">
  <div class="logo"><div class="logo-mark">S</div><span style="font-weight:700;font-size:18px;color:#14532d">Simplifi MCP</span></div>
  <h1>Two-step verification</h1>
  <p class="sub">A code was sent to your ${escapeHtml(opts.mfa.channel)}${hint}.</p>
  ${err}
  <form method="POST" action="/connect/mfa">
    <input type="hidden" name="pending_id" value="${escapeHtml(opts.mfa.pendingId)}">
    <div class="field">
      <label>Verification code</label>
      <input type="text" name="mfa_code" inputmode="numeric" autocomplete="one-time-code" autofocus required placeholder="123456">
    </div>
    <button type="submit">Verify</button>
  </form>
</div></body></html>`;
    }

    const err = opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : "";
    return `<!doctype html><html><head><meta charset="utf-8"><title>Connect — Simplifi MCP</title><style>${styles}</style></head>
<body><div class="card">
  <div class="logo"><div class="logo-mark">S</div><span style="font-weight:700;font-size:18px;color:#14532d">Simplifi MCP</span></div>
  <h1>Connect your Simplifi account</h1>
  <p class="sub">Enter your Quicken Simplifi credentials to link your account.</p>
  <div class="notice">🔒 Your credentials are sent directly to Quicken and are never stored on disk. Only the resulting session token is saved locally.</div>
  ${err}
  <form method="POST" action="/connect">
    <div class="field">
      <label>Email</label>
      <input type="email" name="email" autocomplete="email" autofocus required placeholder="you@example.com">
    </div>
    <div class="field">
      <label>Password</label>
      <input type="password" name="password" autocomplete="current-password" required>
    </div>
    <button type="submit">Connect account</button>
  </form>
</div></body></html>`;
  }

  app.get("/connect", (_req, res) => {
    if (hasSimplifiTokens()) {
      res.status(200).type("html").send(connectPage({ success: true }));
      return;
    }
    res.status(200).type("html").send(connectPage());
  });

  app.post("/connect", async (req, res) => {
    const email = typeof req.body.email === "string" ? req.body.email.trim() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";

    if (!email || !password) {
      res.status(400).type("html").send(connectPage({ error: "Email and password are required." }));
      return;
    }

    try {
      const result = await simplifiAuthService.attemptLoginWithCredentials(email, password);

      if (result.status === "mfa_required") {
        res.status(200).type("html").send(
          connectPage({ mfa: { pendingId: result.pendingId, channel: result.mfaChannel, hint: result.email } }),
        );
        return;
      }

      // Trigger dataset ID detection immediately so the MCP is ready to use
      void simplifiClient.getDatasetId().catch(() => {});

      res.status(200).type("html").send(connectPage({ success: true }));
    } catch (error) {
      logWarn("Simplifi connect login failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(200).type("html").send(connectPage({ error: "Login failed. Check your email and password." }));
    }
  });

  app.post("/connect/mfa", async (req, res) => {
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
      void simplifiClient.getDatasetId().catch(() => {});
      res.status(200).type("html").send(connectPage({ success: true }));
    } catch (error) {
      res.status(200).type("html").send(
        connectPage({ mfa: { pendingId, channel: mfaInfo.mfaChannel, hint: mfaInfo.email }, error: "Incorrect code. Try again." }),
      );
    }
  });

  // ───────────────────────────────────────────────────────────────────────────

  const requireAccessToken = (req: Request, res: Response, next: NextFunction): void => {
    const token = readBearerToken(req);
    if (!token) {
      res.status(401).json({ error: "invalid_token", error_description: "Missing bearer token" });
      return;
    }

    // Static API key mode: skip full OAuth JWT validation
    if (config.oauth.staticApiKey) {
      if (token === config.oauth.staticApiKey) {
        next();
        return;
      }
      res.status(401).json({ error: "invalid_token", error_description: "Invalid API key" });
      return;
    }

    try {
      oauthService.verifyAccessToken(token);
      next();
    } catch (error) {
      res.status(401).json({
        error: "invalid_token",
        error_description: error instanceof Error ? error.message : "Token verification failed",
      });
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

  app.get("/", (_req, res) => {
    res.status(200).json({
      name: "quicken-simplifi-mcp",
      status: "ok",
      mcp: `${config.server.publicBaseUrl}/mcp`,
      oauthAuthorize: `${config.server.publicBaseUrl}/oauth/authorize`,
      oauthToken: `${config.server.publicBaseUrl}/oauth/token`,
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
      for (const [sessionId] of sessions.entries()) {
        sessions.delete(sessionId);
      }

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
