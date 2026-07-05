// NIFTY vs SENSEX CORRELATION TRADING ENGINE
// Ported from Python correlation bot
// Detects when indices drift apart and signals mean-reversion trades

const NIFTY_TICKER = "^NSEI";
const SENSEX_TICKER = "^BSESN";
const DAYS_OF_DATA = 70;
const ROLLING_WINDOW = 5;
const CORR_BREAKDOWN_LEVEL = 0.94;
const RETURN_DIFF_THRESHOLD = 0.15;

// --- Yahoo Finance historical fetch ---
async function fetchHistoricalClose(ticker: string): Promise<{ dates: string[]; closes: number[] }> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - DAYS_OF_DATA * 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${start}&period2=${end}&interval=1d`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Yahoo returned ${res.status} for ${ticker}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${ticker}`);

  const timestamps: number[] = result.timestamp || [];
  const closes: number[] = result.indicators?.quote?.[0]?.close || [];
  const dates = timestamps.map((t) => new Date(t * 1000).toISOString().split("T")[0]);
  return { dates, closes };
}

// --- Math helpers ---
function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function correlation(a: number[], b: number[]): number {
  if (a.length < 3) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

function covariance(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  return a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / a.length;
}

function variance(arr: number[]): number {
  const m = mean(arr);
  return arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
}

function rollingCorrelation(a: number[], b: number[], window: number): number[] {
  const result: number[] = [];
  for (let i = window - 1; i < a.length; i++) {
    const sliceA = a.slice(i - window + 1, i + 1);
    const sliceB = b.slice(i - window + 1, i + 1);
    result.push(correlation(sliceA, sliceB));
  }
  return result;
}

// --- Main analysis ---
export interface CorrelationResult {
  niftyPrice: number;
  sensexPrice: number;
  daysAnalyzed: number;
  overallCorrelation: number;
  last5dCorrelation: number;
  last20dCorrelation: number;
  beta: number;
  todayReturnDiff: number;
  avgDiff5d: number;
  diffStd: number;
  niftyVol: number;
  sensexVol: number;
  signal: "TRADE" | "WATCH" | "WAIT";
  reason: string;
  action: string;
  tip: string;
  history: { date: string; nifty: number; sensex: number; corr5d: number; returnDiff: number }[];
}

export async function runCorrelationAnalysis(): Promise<CorrelationResult> {
  const [niftyData, sensexData] = await Promise.all([
    fetchHistoricalClose(NIFTY_TICKER),
    fetchHistoricalClose(SENSEX_TICKER),
  ]);

  // Align dates
  const dateMap = new Map<string, { nifty: number; sensex: number }>();
  for (let i = 0; i < niftyData.dates.length; i++) {
    dateMap.set(niftyData.dates[i], { nifty: niftyData.closes[i], sensex: 0 });
  }
  for (let i = 0; i < sensexData.dates.length; i++) {
    const existing = dateMap.get(sensexData.dates[i]);
    if (existing) existing.sensex = sensexData.closes[i];
  }

  const aligned = Array.from(dateMap.entries())
    .filter(([, v]) => v.nifty > 0 && v.sensex > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));

  const niftyClose = aligned.map(([, v]) => v.nifty);
  const sensexClose = aligned.map(([, v]) => v.sensex);

  // Daily returns
  const niftyReturn: number[] = [];
  const sensexReturn: number[] = [];
  for (let i = 1; i < niftyClose.length; i++) {
    niftyReturn.push((niftyClose[i] - niftyClose[i - 1]) / niftyClose[i - 1]);
    sensexReturn.push((sensexClose[i] - sensexClose[i - 1]) / sensexClose[i - 1]);
  }

  const overallCorr = correlation(niftyReturn, sensexReturn);
  const rolling5 = rollingCorrelation(niftyReturn, sensexReturn, ROLLING_WINDOW);
  const rolling20 = rollingCorrelation(niftyReturn, sensexReturn, 20);

  const last5dCorr = rolling5[rolling5.length - 1] || 0;
  const last20dCorr = rolling20[rolling20.length - 1] || 0;

  // Return differences (in %)
  const returnDiff = niftyReturn.map((r, i) => (r - sensexReturn[i]) * 100);
  const todayDiff = returnDiff[returnDiff.length - 1] || 0;
  const recentDiff = returnDiff.slice(-ROLLING_WINDOW);
  const avgDiff5d = mean(recentDiff);
  const diffStd = std(returnDiff);

  // Beta
  const cov = covariance(niftyReturn, sensexReturn);
  const varS = variance(sensexReturn);
  const beta = varS === 0 ? 1 : cov / varS;

  // Volatility (annualized)
  const niftyVol = std(niftyReturn.slice(-20)) * Math.sqrt(252) * 100;
  const sensexVol = std(sensexReturn.slice(-20)) * Math.sqrt(252) * 100;

  // Signal generation
  let signal: "TRADE" | "WATCH" | "WAIT" = "WAIT";
  let reason = "";
  let action = "";
  let tip = "";

  if (last5dCorr < CORR_BREAKDOWN_LEVEL) {
    signal = "TRADE";
    if (todayDiff > RETURN_DIFF_THRESHOLD) {
      reason = `Correlation broke down (${last5dCorr.toFixed(4)}). Nifty moved ${todayDiff.toFixed(2)}% ahead of Sensex.`;
      action = "BUY SENSEX + SELL NIFTY — bet on comeback";
      tip = "Hold 1-3 days. Exit when 5d correlation goes back above 0.97.";
    } else if (todayDiff < -RETURN_DIFF_THRESHOLD) {
      reason = `Correlation broke down (${last5dCorr.toFixed(4)}). Sensex moved ${Math.abs(todayDiff).toFixed(2)}% ahead of Nifty.`;
      action = "BUY NIFTY + SELL SENSEX — bet on comeback";
      tip = "Hold 1-3 days. Exit when 5d correlation goes back above 0.97.";
    } else {
      signal = "WAIT";
      reason = `Correlation broke down (${last5dCorr.toFixed(4)}) but return gap is small (${todayDiff.toFixed(2)}%).`;
      action = "Wait for bigger gap before entering";
      tip = "Check again when gap exceeds 0.15%";
    }
  } else if (Math.abs(todayDiff) > 2 * diffStd) {
    signal = "TRADE";
    if (todayDiff > 0) {
      reason = `Nifty is ${todayDiff.toFixed(2)}% ahead of Sensex (normal: ±${diffStd.toFixed(2)}%).`;
      action = "BUY SENSEX / SELL NIFTY — bet on mean reversion";
    } else {
      reason = `Sensex is ${Math.abs(todayDiff).toFixed(2)}% ahead of Nifty (normal: ±${diffStd.toFixed(2)}%).`;
      action = "BUY NIFTY / SELL SENSEX — bet on mean reversion";
    }
    tip = `Stop loss if gap grows to 3x normal (>${(3 * diffStd).toFixed(2)}%)`;
  } else if (Math.abs(niftyVol - sensexVol) > 2.0) {
    signal = "WATCH";
    reason = `Volatility gap: Nifty ${niftyVol.toFixed(1)}% vs Sensex ${sensexVol.toFixed(1)}%. Options may be mispriced.`;
    action = "Check option prices for volatility spread opportunity";
    tip = "Compare IV of both indices. If one is much cheaper, consider a vol spread.";
  } else {
    reason = "Nifty and Sensex are moving normally together.";
    action = "No trade today";
    tip = `When 5d correlation drops below ${CORR_BREAKDOWN_LEVEL}, come back!`;
  }

  // History for chart
  const historyStart = Math.max(0, aligned.length - 30);
  const history = aligned.slice(historyStart).map((entry, idx) => {
    const ri = historyStart + idx - 1;
    return {
      date: entry[0],
      nifty: entry[1].nifty,
      sensex: entry[1].sensex,
      corr5d: ri >= ROLLING_WINDOW - 1 ? (rolling5[ri - (ROLLING_WINDOW - 1)] || 0) : 0,
      returnDiff: ri >= 0 ? (returnDiff[ri] || 0) : 0,
    };
  });

  return {
    niftyPrice: niftyClose[niftyClose.length - 1],
    sensexPrice: sensexClose[sensexClose.length - 1],
    daysAnalyzed: niftyReturn.length,
    overallCorrelation: overallCorr,
    last5dCorrelation: last5dCorr,
    last20dCorrelation: last20dCorr,
    beta,
    todayReturnDiff: todayDiff,
    avgDiff5d,
    diffStd,
    niftyVol,
    sensexVol,
    signal,
    reason,
    action,
    tip,
    history,
  };
}
