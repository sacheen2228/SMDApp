// NSE OI Spurts — fetches official NSE OI spurts data
// Source: https://www.nseindia.com/market-data/oi-spurts

export interface OISpurt {
  symbol: string;
  underlying: string;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
  ltp: number;
  ltpChange: number;
  ltpChangePct: number;
  volume: number;
  oi: number;
  oiChange: number;
  oiChangePct: number;
  iv: number;
  classification: "LONG_BUILDUP" | "SHORT_BUILDUP" | "SHORT_COVERING" | "LONG_UNWINDING";
  spurtScore: number;
  timestamp: string;
  source: string;
  freshness: "LIVE" | "FRESH" | "DELAYED" | "STALE";
}

export interface OISpurtSummary {
  totalSpurts: number;
  longBuildupCount: number;
  shortBuildupCount: number;
  shortCoveringCount: number;
  longUnwindingCount: number;
  overallBias: "BULLISH" | "BEARISH" | "MIXED" | "NEUTRAL";
  spurtScore: number;
  topSpurts: OISpurt[];
  timestamp: string;
  source: string;
  freshness: string;
}

const NSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/market-data/oi-spurts",
};

let nseCookie: string | null = null;
let cookieExpiry = 0;

async function getNSECookie(): Promise<string> {
  if (nseCookie && Date.now() < cookieExpiry) return nseCookie;
  try {
    const res = await fetch("https://www.nseindia.com", {
      headers: NSE_HEADERS,
      redirect: "follow",
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      nseCookie = setCookie.split(";")[0];
      cookieExpiry = Date.now() + 300_000;
      return nseCookie;
    }
  } catch {}
  return "";
}

function classifyOI(priceChange: number, oiChange: number): OISpurt["classification"] {
  if (priceChange > 0 && oiChange > 0) return "LONG_BUILDUP";
  if (priceChange < 0 && oiChange > 0) return "SHORT_BUILDUP";
  if (priceChange > 0 && oiChange < 0) return "SHORT_COVERING";
  if (priceChange < 0 && oiChange < 0) return "LONG_UNWINDING";
  return "LONG_BUILDUP";
}

function calculateSpurtScore(spurt: {
  oiChange: number;
  oiChangePct: number;
  ltpChangePct: number;
  volume: number;
}): number {
  let score = 0;

  // OI change magnitude (0-30)
  const oiMag = Math.min(30, Math.abs(spurt.oiChange) / 10000);
  score += oiMag;

  // OI change % (0-25)
  const oiPct = Math.min(25, Math.abs(spurt.oiChangePct) / 2);
  score += oiPct;

  // Price change % (0-20)
  const pricePct = Math.min(20, Math.abs(spurt.ltpChangePct) * 4);
  score += pricePct;

  // Volume (0-15)
  const volScore = Math.min(15, spurt.volume / 100000);
  score += volScore;

  // Persistence bonus (0-10) — high OI change + volume = persistent
  if (Math.abs(spurt.oiChangePct) > 10 && spurt.volume > 500000) {
    score += 10;
  }

  return Math.min(100, Math.round(score));
}

function classifyFreshness(ts: string): OISpurt["freshness"] {
  const ageMs = Date.now() - new Date(ts).getTime();
  if (ageMs < 60_000) return "LIVE";
  if (ageMs < 300_000) return "FRESH";
  if (ageMs < 900_000) return "DELAYED";
  return "STALE";
}

export async function fetchOISpurts(): Promise<OISpurtSummary> {
  const empty: OISpurtSummary = {
    totalSpurts: 0,
    longBuildupCount: 0,
    shortBuildupCount: 0,
    shortCoveringCount: 0,
    longUnwindingCount: 0,
    overallBias: "NEUTRAL",
    spurtScore: 0,
    topSpurts: [],
    timestamp: new Date().toISOString(),
    source: "nse-api",
    freshness: "UNAVAILABLE",
  };

  try {
    const cookie = await getNSECookie();
    const res = await fetch("https://www.nseindia.com/api/oi-spurts", {
      headers: { ...NSE_HEADERS, Cookie: cookie },
      cache: "no-store",
    });

    if (!res.ok) return empty;

    const data = await res.json();
    const rows = data?.data || data?.records || [];

    if (!Array.isArray(rows) || rows.length === 0) return empty;

    const spurs: OISpurt[] = rows.map((row: any) => {
      const symbol = row.symbol || row.SYM || "";
      const strike = parseFloat(row.strike || row.STRIKE || "0");
      const optType = (row.optionType || row.OPT_TYPE || row.ce_pe || "").toUpperCase();
      const ltp = parseFloat(row.ltp || row.LAST_PRICE || row.lastPrice || "0");
      const ltpChg = parseFloat(row.priceChange || row.CHANGE || row.change || "0");
      const ltpChgPct = parseFloat(row.priceChangePct || row.pChange || row.changePct || "0");
      const vol = parseInt(row.volume || row.VOLUME || "0", 10);
      const oi = parseInt(row.oi || row.OI || row.openInterest || "0", 10);
      const oiChg = parseInt(row.oiChange || row.OI_CHANGE || row.changeinOpenInterest || "0", 10);
      const oiChgPct = parseFloat(row.oiChangePct || row.oiChangePercentage || "0");
      const iv = parseFloat(row.iv || row.IMPLIED_VOLATILITY || "0");
      const expiry = row.expiry || row.EXPIRY || "";
      const underlying = row.underlying || row.UNDERLYING || symbol;

      const classification = classifyOI(ltpChg, oiChg);
      const spurtScore = calculateSpurtScore({
        oiChange: oiChg,
        oiChangePct: oiChgPct,
        ltpChangePct: ltpChgPct,
        volume: vol,
      });

      return {
        symbol,
        underlying,
        expiry,
        strike,
        optionType: optType === "CE" || optType === "CALL" ? "CE" : "PE",
        ltp,
        ltpChange: ltpChg,
        ltpChangePct: ltpChgPct,
        volume: vol,
        oi,
        oiChange: oiChg,
        oiChangePct: oiChgPct,
        iv,
        classification,
        spurtScore,
        timestamp: new Date().toISOString(),
        source: "nse-api",
        freshness: classifyFreshness(new Date().toISOString()),
      };
    });

    // Sort by spurt score
    spurs.sort((a, b) => b.spurtScore - a.spurtScore);

    const longBuildup = spurs.filter(s => s.classification === "LONG_BUILDUP").length;
    const shortBuildup = spurs.filter(s => s.classification === "SHORT_BUILDUP").length;
    const shortCovering = spurs.filter(s => s.classification === "SHORT_COVERING").length;
    const longUnwinding = spurs.filter(s => s.classification === "LONG_UNWINDING").length;

    let overallBias: OISpurtSummary["overallBias"] = "NEUTRAL";
    if (longBuildup > shortBuildup * 1.5) overallBias = "BULLISH";
    else if (shortBuildup > longBuildup * 1.5) overallBias = "BEARISH";
    else if (longBuildup > 0 && shortBuildup > 0) overallBias = "MIXED";

    const avgScore = spurs.length > 0
      ? Math.round(spurs.reduce((sum, s) => sum + s.spurtScore, 0) / spurs.length)
      : 0;

    return {
      totalSpurts: spurs.length,
      longBuildupCount: longBuildup,
      shortBuildupCount: shortBuildup,
      shortCoveringCount: shortCovering,
      longUnwindingCount: longUnwinding,
      overallBias,
      spurtScore: avgScore,
      topSpurts: spurs.slice(0, 20),
      timestamp: new Date().toISOString(),
      source: "nse-api",
      freshness: "LIVE",
    };
  } catch (err: any) {
    console.error("[OISpurts] Error:", err.message);
    return empty;
  }
}
