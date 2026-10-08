import { exec } from "node:child_process";
import { loadConfig } from "./config.js";
import { DatabaseContext } from "./db/database.js";
import { startHttpServer } from "./http/server.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { OAuthService } from "./oauth/oauth-service.js";
import { TransactionToolService } from "./services/transaction-tool-service.js";
import { ReferenceDataService } from "./services/reference-data-service.js";
import { SimplifiAuthService } from "./simplifi/auth-service.js";
import { SimplifiClient } from "./simplifi/client.js";
import { SyncService } from "./sync/sync-service.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new DatabaseContext(config.cache.dbPath);
  const oauthService = new OAuthService(config.oauth, db);

  const simplifiAuthService = new SimplifiAuthService(config.simplifi, db);
  const simplifiClient = new SimplifiClient(
    config.simplifi,
    simplifiAuthService,
    () => db.getDatasetId(),
    (id) => db.saveDatasetId(id),
  );
  const syncService = new SyncService(config.simplifi, db, simplifiClient);

  // Warm cache once in background; server startup should remain fast.
  void syncService.ensureInitialized().catch((error: unknown) => {
    logError("Initial Simplifi sync failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  syncService.start();

  const referenceDataService = new ReferenceDataService(config.simplifi, db, simplifiClient);
  const toolService = new TransactionToolService(
    db,
    syncService,
    simplifiClient,
    referenceDataService,
    config.simplifi.maxStaleMs,
  );
  const httpServer = await startHttpServer({
    config,
    oauthService,
    simplifiAuthService,
    simplifiClient,
    toolService,
    isReady: () => db.getSimplifiTokens() !== null && Boolean(db.getSyncState().lastFullSyncAt),
    initializeSync: () => syncService.ensureInitialized(),
    notifyActivity: () => syncService.notifyActivity(),
  });

  function openConnectPage(): void {
    const connectUrl = `${config.server.publicBaseUrl}/connect`;
    logInfo("Opening browser to Simplifi connect page", { url: connectUrl });
    console.log(`\n🔗  Open this URL to connect your Simplifi account:\n    ${connectUrl}\n`);
    const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${openCmd} "${connectUrl}"`, (err) => {
      if (err) logWarn("Could not open browser automatically", { error: err.message });
    });
  }

  // Open browser whenever the session expires and needs reconnecting.
  simplifiAuthService.onNeedsReauth(openConnectPage);

  // Also open immediately on first run (no tokens yet).
  if (!db.getSimplifiTokens()) {
    openConnectPage();
  }

  const shutdown = async (signal: string): Promise<void> => {
    logInfo("Shutting down", { signal });
    syncService.stop();
    await httpServer.close();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error: unknown) => {
  logError("Fatal startup error", {
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  process.exit(1);
});
