import { chromium, type Browser } from "playwright";

export interface FIIDIIResult {
  fiiNet: number | null; // Crores, negative = net selling
  diiNet: number | null;
  totalNet: number | null;
  fiiStreak: string | null;
  regime: string | null;
  asOf: string | null;
  source: "live" | "unavailable";
}

const NIFTYTRADER_URL = "https://www.niftytrader.in/fii-dii-data";

// In-memory cache (server side). NiftyTrader updates once per session.
let cache: { data: FIIDIIResult; ts: number } | null = null;
const CACHE_MS = 10 * 60 * 1000;

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

export async function fetchFIIDII(): Promise<FIIDIIResult> {
  if (cache && Date.now() - cache.ts < CACHE_MS) return cache.data;

  const empty: FIIDIIResult = {
    fiiNet: null, diiNet: null, totalNet: null,
    fiiStreak: null, regime: null, asOf: null, source: "unavailable",
  };

  let browser: Browser | null = null;
  try {
    browser = await withTimeout(getBrowser(), 15000, "browser launch");
    const page = await withTimeout(browser.newPage(), 10000, "newPage");
    await withTimeout(
      page.goto(NIFTYTRADER_URL, { waitUntil: "domcontentloaded", timeout: 15000 }),
      18000,
      "goto",
    );
    const text = await withTimeout(
      page.evaluate(() => document.body.innerText),
      10000,
      "evaluate",
    );
    await page.close().catch(() => {});

    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

    // Robust extraction via regex on the full page text. NiftyTrader renders
    // "FII CASH <value>" / "DII CASH <value>" / "TOTAL NET <value>" blocks.
    const fiiCash = text.match(/FII CASH[^₹]*₹?\s*([−\-+]?[\d,]+)\s*Cr/i)?.[0];
    const diiCash = text.match(/DII CASH[^₹]*₹?\s*([−\-+]?[\d,]+)\s*Cr/i)?.[0];
    const totalNet = text.match(/TOTAL NET[^₹]*₹?\s*([−\-+]?[\d,]+)\s*Cr/i)?.[0];
    const fiiStreak = lines.find((l) => /^\d+\s*Day\s+(Selling|Buying)$/i.test(l));
    const regime = lines.find((l) => /^(DISTRIBUTION|ACCUMULATION|ROTATION|NEUTRAL)/i.test(l));
    const asOf = lines.find((l) => /^Updated\s+/i.test(l));

    const result: FIIDIIResult = {
      fiiNet: parseCr(fiiCash),
      diiNet: parseCr(diiCash),
      totalNet: parseCr(totalNet),
      fiiStreak: fiiStreak ?? null,
      regime: regime ?? null,
      asOf: asOf ?? null,
      source: "live",
    };

    // Only cache when we actually got the core figures.
    if (result.fiiNet !== null || result.diiNet !== null || result.totalNet !== null) {
      cache = { data: result, ts: Date.now() };
    }
    return result;
  } catch (err: any) {
    console.error("[FII/DII] scrape failed:", err?.message || err);
    return empty;
  }
}
