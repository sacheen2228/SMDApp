// scripts/smoke-live.ts — hit every API route with a live request and report
// status, latency, payload size and whether the payload carries real data.
import { readFileSync } from "fs";
import { execSync } from "child_process";

const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:3000";
const routes = execSync("find src/app/api -name route.ts | sed 's|src/app/api/||; s|/route.ts||' | sort", { encoding: "utf8" })
  .trim().split("\n");

const SKIP = new Set([
  "auth/[...nextauth]", "webhook/tradingview", "telegram/webhook", "events/stream",
  "breeze/stream", "coindcx/stream", "coindcx/websocket", "cron/eod-squareoff",
  "cron/dom-analysis", "cron/institutional-positioning", "web-intel/sync", "voice/audio/[file]",
]);

type Row = { route: string; method: string; status: number; ms: number; bytes: number; verdict: string; note: string };
const rows: Row[] = [];

for (const r of routes) {
  if (SKIP.has(r)) continue;
  const file = `src/app/api/${r}/route.ts`;
  let src = "";
  try { src = readFileSync(file, "utf8"); } catch { continue; }
  const methods = ["GET", "POST"].filter((m) => new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`).test(src));
  if (!methods.length) continue;
  const method = methods[0];
  const url = `${BASE}/api/${r}${method === "GET" ? "?symbol=NIFTY&interval=5m" : ""}`;
  const t0 = Date.now();
  let status = 0, body = "";
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "POST" ? JSON.stringify({ symbol: "NIFTY" }) : undefined,
      signal: AbortSignal.timeout(Number(process.env.SMOKE_TIMEOUT_MS || 20_000)),
    });
    status = res.status;
    body = await res.text();
  } catch (e: any) {
    rows.push({ route: r, method, status: 0, ms: Date.now() - t0, bytes: 0, verdict: "TIMEOUT", note: String(e.message).slice(0, 60) });
    console.log(`TIMEOUT    ${r.padEnd(34)}${method.padEnd(5)}`);
    continue;
  }
  const ms = Date.now() - t0;
  const bytes = body.length;
  let verdict = "OK";
  let note = "";
  if (status >= 500) { verdict = "ERROR"; note = body.slice(0, 120).replace(/\s+/g, " "); }
  else if (status === 405 || status === 404) { verdict = status === 405 ? "POST-ONLY" : "NOT-FOUND"; note = ""; }
  else if (status >= 400) { verdict = "CLIENT-ERR"; note = body.slice(0, 100).replace(/\s+/g, " "); }
  else {
    // data-presence heuristic
    const emptyArray = /"[^"]*":\s*\[\s*\]/.test(body);
    const nullish = /"[^"]*":\s*null/.test(body);
    const noData = /"data"\s*:\s*(null|\[\s*\])|"error"|"ok"\s*:\s*false/.test(body);
    if (noData) { verdict = "NO-DATA"; note = body.slice(0, 90).replace(/\s+/g, " "); }
    else if (bytes < 120) { verdict = "THIN"; note = body.slice(0, 90).replace(/\s+/g, " "); }
    else if (emptyArray && bytes < 400) { verdict = "THIN"; note = "empty arrays"; }
    else if (nullish && bytes < 400) { verdict = "THIN"; note = "null fields"; }
  }
  rows.push({ route: r, method, status, ms, bytes, verdict, note });
  console.log(`${verdict.padEnd(11)}${r.padEnd(34)}${method.padEnd(5)}${String(status).padEnd(5)}${String(ms).padStart(6)}ms ${String(bytes).padStart(8)}B ${note}`);
}

rows.sort((a, b) => a.verdict.localeCompare(b.verdict) || b.bytes - a.bytes);
const pad = (s: string | number, n: number) => String(s).padEnd(n);
console.log(`\n══════════ LIVE SMOKE — ${rows.length} routes ══════════`);
console.log(`${pad("verdict", 11)}${pad("route", 34)}${pad("m", 5)}${pad("code", 5)}${pad("ms", 7)}${pad("bytes", 9)}note`);
for (const r of rows) {
  console.log(`${pad(r.verdict, 11)}${pad(r.route, 34)}${pad(r.method, 5)}${pad(r.status, 5)}${pad(r.ms, 7)}${pad(r.bytes, 9)}${r.note}`);
}
const tally: Record<string, number> = {};
for (const r of rows) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
console.log("\nTALLY:", tally);
