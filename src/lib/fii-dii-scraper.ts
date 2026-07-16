import { chromium, type Browser } from "playwright";

export interface FIIDIIResult {
  fiiNet: number | null; // Crores, negative = net selling
  diiNet: number | null;
  totalNet: number | null;
  fiiStreak: string | null;
  regime: string | null;
  asOf: string | null;
  source: "live" | "stale" | "unavailable";
}

// Two independent real sources (both ultimately NSE-derived):
//  1. MrChartist JSON API — fast, no browser needed, primary.
//  2. NiftyTrader scrape (Playwright) — browser fallback if the JSON API fails.
// NSE/BSE/Moneycontrol/Sensibull/Investing/Trendlyne/ET are all blocked or
// access-denied from this host, so these two are the only reachable options.
const MRCHARTIST_URL = "https://fii-diidata.mrchartist.com/api/data";
const NIFTYTRADER_URLS = [
  "https://www.niftytrader.in/fii-dii-data",
  "https://www.niftytrader.in/fii-dii-trading-activity",
];

// In-memory cache (server side). Sources update once per session.
let cache: { data: FIIDIIResult; ts: number } | null = null;
const CACHE_MS = 10 * 60 * 1000; // fresh data valid for 10 min
const STALE_MS = 6 * 60 * 60 * 1000; // serve up to 6h-old data as "stale"

let browserPromise: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
  }
  return browserPromise;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// Parse "−₹4,206 Cr" / "+₹2,986 Cr" / "-Rs 4206 cr" into a signed number (crores).
function parseCr(text: string | undefined): number | null {
  if (!text) return null;
  const m = text.match(/[−\-+]?\s*₹?\s*([\d,]+)(?:\.?\d*)?\s*Cr/i);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/,/g, ""));
  if (!isFinite(num)) return null;
  const sign = /[−-]/.test(text) ? -1 : 1;
  return sign * num;
}

// ─── Primary source: MrChartist JSON API ─────────────────────────
async function fetchMrChartist(): Promise<FIIDIIResult | null> {
  try {
    const res = await withTimeout(
      fetch(MRCHARTIST_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) }),
      13000,
      "mrchartist fetch",
    );
    if (!res.ok) return null;
    const j = await res.json();
    const fiiNet = typeof j.fii_net === "number" ? j.fii_net : null;
    const diiNet = typeof j.dii_net === "number" ? j.dii_net : null;
    if (fiiNet === null && diiNet === null) return null;
    return {
      fiiNet,
      diiNet,
      totalNet: typeof j.fii_net === "number" && typeof j.dii_net === "number" ? j.fii_net + j.dii_net : null,
      fiiStreak: typeof j.fii_streak === "string" ? j.fii_streak : null,
      regime: typeof j.regime === "string" ? j.regime : null,
      asOf: j._updated_at ?? j.date ?? null,
      source: "live",
    };
  } catch (e: any) {
    console.error("[FII/DII] MrChartist failed:", e?.message || e);
    return null;
  }
}

// ─── Fallback source: NiftyTrader scrape ─────────────────────────
function extractFromText(text: string): {
  fiiNet: number | null; diiNet: number | null; totalNet: number | null;
  fiiStreak: string | null; regime: string | null; asOf: string | null;
} {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // Strategy A: label blocks — "FII CASH −₹4,206 Cr", "DII CASH +₹2,986 Cr".
  const fiiA = text.match(/FII CASH[^₹]*₹?\s*([−\-+]?[\d,]+)\s*Cr/i)?.[0];
  const diiA = text.match(/DII CASH[^₹]*₹?\s*([−\-+]?[\d,]+)\s*Cr/i)?.[0];
  const totalA = text.match(/TOTAL NET[^₹]*₹?\s*([−\-+]?[\d,]+)\s*Cr/i)?.[0];

  // Strategy B: sentence form — "FII sold ₹4,206 Cr cash", "DII bought ₹2,986 Cr".
  const fiiBraw = text.match(/FII\s+(?:sold|bought)\s+₹?\s*([−\-+]?[\d,]+)\s*Cr/i)?.[0];
  const diiBraw = text.match(/DII\s+(?:sold|bought)\s+₹?\s*([−\-+]?[\d,]+)\s*Cr/i)?.[0];

  const fiiCash = fiiA ?? fiiBraw ?? undefined;
  const diiCash = diiA ?? diiBraw ?? undefined;
  const totalNet = totalA ?? undefined;

  const fiiStreak = lines.find((l) => /^\d+\s*Day\s+(Selling|Buying)$/i.test(l)) ?? null;
  const regime = lines.find((l) => /^(DISTRIBUTION|ACCUMULATION|ROTATION|NEUTRAL)/i.test(l)) ?? null;
  const asOf = lines.find((l) => /^Updated\s+/i.test(l)) ?? null;

  return {
    fiiNet: parseCr(fiiCash),
    diiNet: parseCr(diiCash),
    totalNet: parseCr(totalNet),
    fiiStreak,
    regime,
    asOf,
  };
}

async function fetchNiftyTrader(): Promise<FIIDIIResult | null> {
  let browser: Browser | null = null;
  try {
    browser = await withTimeout(getBrowser(), 15000, "browser launch");
    for (const url of NIFTYTRADER_URLS) {
      try {
        const page = await withTimeout(browser.newPage(), 10000, "newPage");
        await withTimeout(page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }), 18000, "goto");
        const text = await withTimeout(page.evaluate(() => document.body.innerText), 10000, "evaluate");
        await page.close().catch(() => {});
        const ex = extractFromText(text);
        if (ex.fiiNet !== null || ex.diiNet !== null || ex.totalNet !== null) {
          return { ...ex, source: "live" };
        }
      } catch {
        // try next URL
      }
    }
    return null;
  } catch (err: any) {
    console.error("[FII/DII] NiftyTrader scrape failed:", err?.message || err);
    return null;
  }
}

export async function fetchFIIDII(): Promise<FIIDIIResult> {
  // Fresh cache hit.
  if (cache && Date.now() - cache.ts < CACHE_MS) return cache.data;

  // 1) Primary: fast JSON API.
  const primary = await fetchMrChartist();
  if (primary) {
    cache = { data: primary, ts: Date.now() };
    return primary;
  }

  // 2) Fallback: browser scrape.
  const fallback = await fetchNiftyTrader();
  if (fallback) {
    cache = { data: fallback, ts: Date.now() };
    return fallback;
  }

  // 3) Last-known real data (stale) so the gap tab doesn't drop to MISSING.
  if (cache && Date.now() - cache.ts < STALE_MS) {
    return { ...cache.data, source: "stale" };
  }

  return {
    fiiNet: null, diiNet: null, totalNet: null,
    fiiStreak: null, regime: null, asOf: null, source: "unavailable",
  };
}
