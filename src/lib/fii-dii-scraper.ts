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

// NiftyTrader is the only FII/DII source reachable from this host (NSE, BSE,
// Moneycontrol, Sensibull, Investing, Trendlyne, ET are all blocked / denied).
// Resilience is therefore built via: (a) multiple extraction strategies on the
// same page, (b) a one-shot retry on transient failures, and (c) a stale-cache
// fallback so the gap tab keeps showing the last known REAL figure instead of
// dropping to MISSING when a live scrape briefly fails.
const SOURCE_URLS = [
  "https://www.niftytrader.in/fii-dii-data",
  "https://www.niftytrader.in/fii-dii-trading-activity",
];

// In-memory cache (server side). NiftyTrader updates once per session.
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

// Extract figures from raw page text using two independent strategies so a
// minor layout change to either format still yields data.
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

async function scrapeOnce(): Promise<FIIDIIResult | null> {
  let browser: Browser | null = null;
  try {
    browser = await withTimeout(getBrowser(), 15000, "browser launch");
    let lastErr: any = null;
    for (const url of SOURCE_URLS) {
      try {
        const page = await withTimeout(browser.newPage(), 10000, "newPage");
        await withTimeout(
          page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }),
          18000,
          "goto",
        );
        const text = await withTimeout(page.evaluate(() => document.body.innerText), 10000, "evaluate");
        await page.close().catch(() => {});

        const ex = extractFromText(text);
        if (ex.fiiNet !== null || ex.diiNet !== null || ex.totalNet !== null) {
          return { ...ex, source: "live" };
        }
        lastErr = "no figures extracted from " + url;
      } catch (e: any) {
        lastErr = e?.message || e;
        // try next URL
      }
    }
    console.error("[FII/DII] all sources failed:", lastErr);
    return null;
  } catch (err: any) {
    console.error("[FII/DII] scrape failed:", err?.message || err);
    return null;
  }
}

export async function fetchFIIDII(): Promise<FIIDIIResult> {
  // Fresh cache hit.
  if (cache && Date.now() - cache.ts < CACHE_MS) return cache.data;

  const fresh = await scrapeOnce();
  if (fresh) {
    cache = { data: fresh, ts: Date.now() };
    return fresh;
  }

  // Live scrape failed — fall back to a recent (stale) cache so the gap tab
  // still shows the last known REAL figures rather than dropping to MISSING.
  if (cache && Date.now() - cache.ts < STALE_MS) {
    return { ...cache.data, source: "stale" };
  }

  return {
    fiiNet: null, diiNet: null, totalNet: null,
    fiiStreak: null, regime: null, asOf: null, source: "unavailable",
  };
}
