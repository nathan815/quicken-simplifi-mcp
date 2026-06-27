#!/usr/bin/env node
/**
 * One-time setup: generates an MCP_API_KEY and writes .env.
 * Simplifi credentials are NOT handled here — they're entered via the browser
 * connect page (http://localhost:8787/connect) when the server starts.
 * Run with: yarn setup
 */

import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_PATH = resolve(process.cwd(), ".env");
const EXAMPLE_PATH = resolve(process.cwd(), ".env.example");

function mergeEnv(existing: string, updates: Record<string, string>): string {
  const lines = existing.split("\n");
  const remaining = new Set(Object.keys(updates));

  const merged = lines.map((line) => {
    const key = line.match(/^([A-Z0-9_]+)=/)?.[1];
    if (key && remaining.has(key)) {
      remaining.delete(key);
      return `${key}=${updates[key]!}`;
    }
    return line;
  });

  for (const key of remaining) {
    merged.push(`${key}=${updates[key]!}`);
  }

  return merged.join("\n");
}

function main() {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║   Simplifi MCP — Setup               ║");
  console.log("╚══════════════════════════════════════╝\n");

  const existing = existsSync(ENV_PATH)
    ? readFileSync(ENV_PATH, "utf8")
    : existsSync(EXAMPLE_PATH)
      ? readFileSync(EXAMPLE_PATH, "utf8")
      : "";

  // Check if an API key already exists
  const existingKey = existing.match(/^MCP_API_KEY=(.+)$/m)?.[1]?.trim();
  const apiKey = existingKey && existingKey.length > 0 ? existingKey : randomBytes(32).toString("hex");

  if (existingKey && existingKey.length > 0) {
    console.log("✓ MCP_API_KEY already set — keeping existing key");
  } else {
    console.log("✓ Generated new MCP_API_KEY");
  }

  const merged = mergeEnv(existing, { MCP_API_KEY: apiKey });
  writeFileSync(ENV_PATH, merged, "utf8");
  console.log(`✓ Written to ${ENV_PATH}`);

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  console.log("Next steps:\n");
  console.log("  1. Start the server (a browser window will open to sign in):");
  console.log("       yarn start\n");
  console.log("  2. Sign in to your Simplifi account in the browser.\n");
  console.log("  3. Add the MCP to Claude Code:");
  console.log(`       claude mcp add simplifi --transport http http://localhost:8787/mcp \\`);
  console.log(`         --header "Authorization: Bearer ${apiKey}"\n`);
  console.log("  4. Start chatting about your finances!\n");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

main();
