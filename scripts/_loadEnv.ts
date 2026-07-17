// scripts/_loadEnv.ts
//
// Load .env into process.env BEFORE any other module is imported.
//
// IMPORTANT: this must be imported as the FIRST import in any entry script
// (e.g. dailyScanCron.ts). ES module imports are hoisted and evaluated in
// source order, so importing this before sendIntradayAlerts / sendDailyDigest
// guarantees process.env.TELEGRAM_* is populated before those modules read
// TELEGRAM_DIGEST_CHAT_IDS at module-eval time.

import fs from "node:fs";
import path from "node:path";

export function loadEnv(): void {
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* best-effort */
  }
}

loadEnv();
