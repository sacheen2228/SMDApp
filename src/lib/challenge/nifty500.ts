// ═══════════════════════════════════════════════════════════════════════════
// NIFTY 500 Universe — Stock List + Batch Fetcher
// Uses Yahoo Finance batch quotes (Tier 2 from nse-stock-data.ts)
// Covers ~200 representative NIFTY 500 stocks across all sectors.
// ═══════════════════════════════════════════════════════════════════════════

// ── Sector classification for NIFTY 500 stocks ──
const SECTOR_MAP: Record<string, string> = {
  // NIFTY 50 (already mapped in nse-stock-data.ts — included for completeness)
  RELIANCE: "Energy", TCS: "IT", HDFCBANK: "Banking", INFY: "IT",
  ICICIBANK: "Banking", HINDUNILVR: "FMCG", ITC: "FMCG", SBIN: "Banking",
  BHARTIARTL: "Telecom", KOTAKBANK: "Banking", LT: "Infrastructure",
  AXISBANK: "Banking", BAJFINANCE: "NBFC", ASIANPAINT: "Consumer",
  MARUTI: "Auto", SUNPHARMA: "Pharma", TITAN: "Consumer", ULTRACEMCO: "Cement",
  NESTLEIND: "FMCG", TATAMOTORS: "Auto", WIPRO: "IT", "M&M": "Auto",
  HCLTECH: "IT", POWERGRID: "Power", NTPC: "Power", ONGC: "Energy",
  TATASTEEL: "Metal", JSWSTEEL: "Metal", ADANIENT: "Conglomerate",
  ADANIPORTS: "Infrastructure", TECHM: "IT", HDFCLIFE: "Insurance",
  SBILIFE: "Insurance", BRITANNIA: "FMCG", CIPLA: "Pharma",
  DRREDDY: "Pharma", DIVISLAB: "Pharma", EICHERMOT: "Auto",
  GRASIM: "Cement", HEROMOTOCO: "Auto", HINDALCO: "Metal",
  INDUSINDBK: "Banking", BAJAJFINSV: "NBFC", COALINDIA: "Mining",
  BPCL: "Energy", TRENT: "Retail", APOLLOHOSP: "Healthcare",
  LTIM: "IT", HDFCAMC: "Finance", PIDILITIND: "Chemical",
  // NIFTY NEXT 50 + Midcap
  AUROPHARMA: "Pharma", CANBK: "Banking", PFC: "Finance", RECLTD: "Finance",
  IRFC: "Finance", IREDA: "Finance", SJVN: "Power", NHPC: "Power",
  BEL: "Defence", HAL: "Defence", BDL: "Defence", MAZAGONDOCK: "Defence",
  COCHINSHIP: "Defence", CUMMINSIND: "Industrial", THERMAX: "Industrial",
  SIEMENS: "Industrial", ABB: "Industrial", SCHNEIDER: "Industrial",
  HAVELLS: "Consumer", VOLTAS: "Consumer", BLUESTARLT: "Consumer",
  CROMPTON: "Consumer", BATAINDIA: "Consumer", PAGEIND: "Consumer",
  VSTIND: "FMCG", GODREJCP: "FMCG", MARICO: "FMCG", DABUR: "FMCG",
  COLPAL: "FMCG", EMAMILTD: "FMCG", UNITEDSPR: "FMCG",
  TATACONSUM: "FMCG", RADICO: "FMCG", CASTROLIND: "Energy",
  GLENMARK: "Pharma", LAURUSLABS: "Pharma", ALKEM: "Pharma",
  TORNTPHARM: "Pharma", IPCALAB: "Pharma", GSKPHARMA: "Pharma",
  PFIZER: "Pharma", ABBOTINDIA: "Pharma", SANOFI: "Pharma",
  // Banking & Financial
  FEDERALBNK: "Banking", IDFCFIRSTB: "Banking", BANDHANBNK: "Banking",
  AUBANK: "Banking", INDUSINDBK: "Banking", RBLBANK: "Banking",
  UJIVAN: "Banking", EQUITASBNK: "Banking", KARURVYSYA: "Banking",
  CITYUNION: "Banking", DCBBANK: "Banking", KARNATAKABANK: "Banking",
  "J&K": "Banking", TNSHAP: "Banking",
  MUTHOOTFIN: "NBFC", MANAPPURAM: "NBFC", CHOLAFIN: "NBFC",
  SHRIRAMFIN: "NBFC", BAJAJHLDNG: "Finance", HDFCAMC: "Finance",
  NAMINDIA: "Finance", SBICARD: "Finance", CROMPTON: "Consumer",
  CAMS: "Finance", CDSL: "Finance", MCX: "Finance",
  // IT
  MINDTREE: "IT", MPHASIS: "IT", COFORGE: "IT", PERSISTENT: "IT",
  COGENT: "IT", TATAELXSI: "IT", SONATSOFTW: "IT", HEXAWARE: "IT",
  BSOFT: "IT", DIXON: "IT", KAYNES: "IT", SYRMA: "IT",
  // Auto & Auto Ancillary
  MOTHERSON: "Auto", BOSCH: "Auto", SUNDRMFAST: "Auto",
  MRF: "Auto", APOLLOTYRE: "Auto", BALKRISIND: "Auto",
  CEATLTD: "Auto", JK: "Auto", AMARARAJA: "Auto",
  EXIDEIND: "Auto", LAOPALA: "Auto", ASHOKLEY: "Auto",
  TATACV: "Auto", EICHERMOT: "Auto", FORCEMOT: "Auto",
  MAHSCOOTER: "Auto", OLECTRA: "Auto", TVSMOTOR: "Auto",
  // Energy & Infrastructure
  ADANIGREEN: "Energy", ADANIENSOL: "Energy", TATAPOWER: "Power",
  JSWENERGY: "Power", TORNTPOWER: "Power", SJVN: "Power",
  NHPC: "Power", IRFC: "Finance", RVNL: "Infrastructure",
  IRB: "Infrastructure", AHL: "Infrastructure", LALPATHLAB: "Healthcare",
  DRPATH: "Healthcare", METROPOLIS: "Healthcare",
  // Consumer & Retail
  ZOMATO: "Consumer", NYKAA: "Consumer", POLYCAB: "Consumer",
  KEI: "Consumer", KAJARIACER: "Cement", ACC: "Cement",
  AMBUJACEM: "Cement", INDCEM: "Cement", JKCEMENT: "Cement",
  SHREECEM: "Cement", RAMCOCEM: "Cement",
  // Telecom & Media
  IDEA: "Telecom", INFRATEL: "Telecom",
  // Chemicals
  Aarti: "Chemical", SRF: "Chemical", NAVINFLUOR: "Chemical",
  DEEPAKNTR: "Chemical", CLEAN: "Chemical", ANURAS: "Chemical",
  ATUL: "Chemical", LAXMIMICAL: "Chemical", RAIN: "Chemical",
  // Metal & Mining
  NMDC: "Mining", HINDZINC: "Metal", VEDL: "Metal",
  JINDALSTEL: "Metal", SAIL: "Metal", RINL: "Metal",
  MOIL: "Mining", NationalAluminium: "Metal",
  // Defence & Aerospace
  BEML: "Defence", GRSE: "Defence", CAMPCO: "Defence",
};

// ── NIFTY 500 representative universe (200+ stocks) ──
// Organized by sector for easy maintenance.
export const NIFTY500_SYMBOLS: string[] = [
  // === NIFTY 50 (core) ===
  "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "HINDUNILVR", "ITC", "SBIN",
  "BHARTIARTL", "KOTAKBANK", "LT", "AXISBANK", "BAJFINANCE", "ASIANPAINT", "MARUTI",
  "SUNPHARMA", "TITAN", "ULTRACEMCO", "NESTLEIND", "TATAMOTORS", "WIPRO", "M&M",
  "HCLTECH", "POWERGRID", "NTPC", "ONGC", "TATASTEEL", "JSWSTEEL", "ADANIENT",
  "ADANIPORTS", "TECHM", "HDFCLIFE", "SBILIFE", "BRITANNIA", "CIPLA", "DRREDDY",
  "DIVISLAB", "EICHERMOT", "GRASIM", "HEROMOTOCO", "HINDALCO", "INDUSINDBK",
  "BAJAJFINSV", "COALINDIA", "BPCL", "TRENT", "APOLLOHOSP", "LTIM", "HDFCAMC", "PIDILITIND",
  // === Banking & Financial (extended) ===
  "FEDERALBNK", "IDFCFIRSTB", "BANDHANBNK", "AUBANK", "RBLBANK",
  "MUTHOOTFIN", "MANAPPURAM", "CHOLAFIN", "SHRIRAMFIN", "BAJAJHLDNG",
  "SBICARD", "CAMS", "CDSL", "PFC", "RECLTD", "IRFC", "IREDA",
  // === IT (extended) ===
  "MINDTREE", "MPHASIS", "COFORGE", "PERSISTENT", "TATAELXSI",
  "SONATSOFTW", "HEXAWARE", "BSOFT", "DIXON", "KAYNES",
  // === Auto & Ancillary ===
  "MOTHERSON", "BOSCH", "SUNDRMFAST", "MRF", "APOLLOTYRE",
  "BALKRISIND", "CEATLTD", "AMARARAJA", "EXIDEIND", "ASHOKLEY",
  "TVSMOTOR", "FORCEMOT", "TATACV",
  // === Pharma ===
  "AUROPHARMA", "GLENMARK", "LAURUSLABS", "ALKEM", "TORNTPHARM",
  "IPCALAB", "GSKPHARMA", "PFIZER", "ABBOTINDIA", "SANOFI",
  // === Consumer & FMCG ===
  "GODREJCP", "MARICO", "DABUR", "COLPAL", "EMAMILTD",
  "VOLTAS", "HAVELLS", "BATAINDIA", "PAGEIND", "VSTIND",
  "TATACONSUM", "RADICO", "ZYDUSLIFE", "POLYCAB", "KEI",
  // === Energy & Power ===
  "ADANIGREEN", "ADANIENSOL", "TATAPOWER", "JSWENERGY", "TORNTPOWER",
  "SJVN", "NHPC", "BEL", "HAL",
  // === Infrastructure & Defence ===
  "RVNL", "BEML", "GRSE", "BDL", "MAZAGONDOCK", "COCHINSHIP",
  // === Cement ===
  "KAJARIACER", "ACC", "AMBUJACEM", "JKCEMENT", "SHREECEM", "RAMCOCEM",
  // === Metal & Mining ===
  "NMDC", "HINDZINC", "VEDL", "JINDALSTEL", "SAIL", "MOIL",
  // === Chemicals ===
  "SRF", "NAVINFLUOR", "DEEPAKNTR", "CLEAN", "ATUL",
  // === Telecom & Media ===
  "IDEA", "INFRATEL",
  // === Healthcare ===
  "LALPATHLAB", "METROPOLIS",
  // === Conglomerate / Others ===
  "ZEEL", "INDUSTOWER", "CROMPTON", "VOLTAS", "BLUESTARLT",
];

// Deduplicate
export const NIFTY500_UNIQUE = [...new Set(NIFTY500_SYMBOLS)];

// ── Yahoo Finance batch fetcher (reuses crumb auth from nse-stock-data.ts) ──
const YF_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
let yfCrumbCache: { crumb: string; cookie: string; expiresAt: number } | null = null;

async function getYFCrumb(): Promise<{ crumb: string; cookie: string }> {
  if (yfCrumbCache && Date.now() < yfCrumbCache.expiresAt) {
    return { crumb: yfCrumbCache.crumb, cookie: yfCrumbCache.cookie };
  }
  const cookieRes = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": YF_UA },
    signal: AbortSignal.timeout(5000),
  });
  const setCookie = cookieRes.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0] || "";
  const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": YF_UA, Cookie: cookie },
    signal: AbortSignal.timeout(5000),
  });
  const crumb = (await crumbRes.text()).trim();
  yfCrumbCache = { crumb, cookie, expiresAt: Date.now() + 50 * 60 * 1000 };
  return { crumb, cookie };
}

export interface Nifty500Quote {
  symbol: string;
  ltp: number;
  change: number;
  changePct: number;
  volume: number;
  prevClose: number;
  dayHigh: number;
  dayLow: number;
  weekHigh52: number;
  weekLow52: number;
  sector: string;
  relativeVolume: number;
  near52WHigh: boolean;
  near52WLow: boolean;
}

// ── Batch fetch NIFTY 500 quotes (10 at a time to avoid rate limits) ──
export async function fetchNifty500Batch(
  symbols: string[] = NIFTY500_UNIQUE,
  batchSize = 10,
): Promise<Map<string, Nifty500Quote>> {
  const result = new Map<string, Nifty500Quote>();
  const batches: string[][] = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    batches.push(symbols.slice(i, i + batchSize));
  }

  try {
    const { crumb, cookie } = await getYFCrumb();

    for (const batch of batches) {
      try {
        const tickers = batch.map(s => `${s}.NS`).join(",");
        const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(tickers)}&crumb=${encodeURIComponent(crumb)}`;
        const res = await fetch(url, {
          headers: { "User-Agent": YF_UA, Cookie: cookie },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) continue;
        const data = await res.json();

        for (const q of data?.quoteResponse?.result || []) {
          const raw = q.symbol?.replace(".NS", "");
          if (!raw || !batch.includes(raw)) continue;
          const ltp = q.regularMarketPrice;
          if (!ltp) continue;
          const prev = q.regularMarketPreviousClose || ltp;
          const vol = q.regularMarketVolume || 0;
          const avgVol = q.averageDailyVolume3Month || vol;
          const wH = q.fiftyTwoWeekHigh || 0;
          const wL = q.fiftyTwoWeekLow || 0;

          result.set(raw, {
            symbol: raw,
            ltp,
            change: parseFloat((q.regularMarketChange ?? (ltp - prev)).toFixed(2)),
            changePct: parseFloat((q.regularMarketChangePercent ?? ((ltp - prev) / prev) * 100).toFixed(2)),
            volume: vol,
            prevClose: prev,
            dayHigh: q.regularMarketDayHigh || ltp,
            dayLow: q.regularMarketDayLow || ltp,
            weekHigh52: wH,
            weekLow52: wL,
            sector: SECTOR_MAP[raw] || "Other",
            relativeVolume: avgVol > 0 ? Math.round((vol / avgVol) * 100) / 100 : 1,
            near52WHigh: wH > 0 ? ltp >= wH * 0.95 : false,
            near52WLow: wL > 0 ? ltp <= wL * 1.05 : false,
          });
        }

        // Small delay between batches
        if (batches.indexOf(batch) < batches.length - 1) {
          await new Promise(r => setTimeout(r, 200));
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Crumb fetch failed — return whatever we got
  }

  return result;
}

// ── Get sector averages for relative strength ──
export function getSectorStrength(quotes: Map<string, Nifty500Quote>): Record<string, { avgChange: number; avgRelVol: number; count: number }> {
  const sectors: Record<string, { totalChange: number; totalRelVol: number; count: number }> = {};
  for (const q of quotes.values()) {
    const s = q.sector;
    if (!sectors[s]) sectors[s] = { totalChange: 0, totalRelVol: 0, count: 0 };
    sectors[s].totalChange += q.changePct;
    sectors[s].totalRelVol += q.relativeVolume;
    sectors[s].count++;
  }
  const result: Record<string, { avgChange: number; avgRelVol: number; count: number }> = {};
  for (const [s, v] of Object.entries(sectors)) {
    result[s] = {
      avgChange: Math.round((v.totalChange / v.count) * 100) / 100,
      avgRelVol: Math.round((v.totalRelVol / v.count) * 100) / 100,
      count: v.count,
    };
  }
  return result;
}
