// Option Chain Data Generator for Indian Markets (NIFTY, BANKNIFTY, FINNIFTY)
// Generates realistic simulated options data

export interface OptionData {
  strike: number;
  ce: {
    oi: number;
    oiChg: number;
    volume: number;
    iv: number;
    ltp: number;
    chg: number;
    delta: number;
    theta: number;
    gamma: number;
    vega: number;
  } | null;
  pe: {
    oi: number;
    oiChg: number;
    volume: number;
    iv: number;
    ltp: number;
    chg: number;
    delta: number;
    theta: number;
    gamma: number;
    vega: number;
  } | null;
}

export interface ExpiryInfo {
  date: string;
  label: string;
  daysToExpiry: number;
}

export interface MarketSummary {
  spotPrice: number;
  spotChange: number;
  spotChangePct: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  indiaVIX: number;
  vixChange: number;
  pcr: number; // Put-Call Ratio
  maxPain: number;
  totalCallOI: number;
  totalPutOI: number;
  totalCallVolume: number;
  totalPutVolume: number;
  atmStrike: number;
}

export interface OptionChainResponse {
  symbol: string;
  spotPrice: number;
  expiries: ExpiryInfo[];
  selectedExpiry: string;
  data: OptionData[];
  summary: MarketSummary;
  timestamp: string;
}

// Seeded random number generator for consistent data
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// Symbol configurations
const SYMBOL_CONFIG: Record<string, {
  lotSize: number;
  stepSize: number;
  rangeFactor: number;
  basePrice: number;
}> = {
  NIFTY: { lotSize: 25, stepSize: 50, rangeFactor: 0.08, basePrice: 24000 },
  BANKNIFTY: { lotSize: 15, stepSize: 100, rangeFactor: 0.10, basePrice: 51000 },
  FINNIFTY: { lotSize: 25, stepSize: 50, rangeFactor: 0.08, basePrice: 23000 },
  MIDCPNIFTY: { lotSize: 50, stepSize: 25, rangeFactor: 0.08, basePrice: 12000 },
  SENSEX: { lotSize: 10, stepSize: 100, rangeFactor: 0.08, basePrice: 79000 },
};

// Generate expiry dates (weekly + monthly)
function generateExpiries(): ExpiryInfo[] {
  const expiries: ExpiryInfo[] = [];
  const now = new Date();
  const currentDay = now.getDay();

  // Generate next 6 weekly expiries (Thursdays)
  for (let i = 0; i < 6; i++) {
    const daysUntilThursday = ((4 - currentDay + 7) % 7) + (i * 7);
    const expiryDate = new Date(now);
    expiryDate.setDate(now.getDate() + daysUntilThursday);
    expiryDate.setHours(15, 30, 0, 0);

    const daysToExpiry = Math.max(1, Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    const label = expiryDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

    expiries.push({
      date: expiryDate.toISOString().split('T')[0],
      label,
      daysToExpiry,
    });
  }

  // Add monthly expiries (last Thursday of next 2 months)
  for (let m = 1; m <= 2; m++) {
    const month = new Date(now.getFullYear(), now.getMonth() + m + 1, 0); // Last day of month+m
    const lastDay = month.getDate();
    const lastThursday = new Date(month);

    // Find last Thursday
    for (let d = lastDay; d >= 1; d--) {
      lastThursday.setDate(d);
      if (lastThursday.getDay() === 4) break;
    }

    lastThursday.setHours(15, 30, 0, 0);

    // Check if already in expiries
    const dateStr = lastThursday.toISOString().split('T')[0];
    if (!expiries.find(e => e.date === dateStr)) {
      const daysToExpiry = Math.max(1, Math.ceil((lastThursday.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
      const label = lastThursday.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      expiries.push({ date: dateStr, label, daysToExpiry });
    }
  }

  return expiries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

// Black-Scholes approximations for Greeks
function calculateGreeks(
  spot: number,
  strike: number,
  timeToExpiry: number, // in years
  iv: number, // as decimal (e.g., 0.15 for 15%)
  isCall: boolean
): { delta: number; theta: number; gamma: number; vega: number } {
  const r = 0.07; // Risk-free rate ~7%
  const sqrtT = Math.sqrt(timeToExpiry);
  const d1 = (Math.log(spot / strike) + (r + (iv * iv) / 2) * timeToExpiry) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;

  // Cumulative normal distribution approximation
  const cdf = (x: number) => {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.SQRT2;
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1.0 + sign * y);
  };

  // PDF of normal distribution
  const pdf = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

  let delta: number;
  const gamma = pdf(d1) / (spot * iv * sqrtT);
  const vega = spot * pdf(d1) * sqrtT / 100; // Per 1% change in IV
  let theta: number;

  if (isCall) {
    delta = cdf(d1);
    theta = (-(spot * pdf(d1) * iv) / (2 * sqrtT) - r * strike * Math.exp(-r * timeToExpiry) * cdf(d2)) / 365;
  } else {
    delta = cdf(d1) - 1;
    theta = (-(spot * pdf(d1) * iv) / (2 * sqrtT) + r * strike * Math.exp(-r * timeToExpiry) * cdf(-d2)) / 365;
  }

  return {
    delta: Math.round(delta * 100) / 100,
    theta: Math.round(theta * 100) / 100,
    gamma: Math.round(gamma * 10000) / 10000,
    vega: Math.round(vega * 100) / 100,
  };
}

// Generate option chain data
export function generateOptionChain(symbol: string = 'NIFTY', expiryDate?: string): OptionChainResponse {
  const config = SYMBOL_CONFIG[symbol] || SYMBOL_CONFIG.NIFTY;
  const rand = seededRandom(Date.now());

  // Generate realistic spot price with some movement
  const baseMovement = (rand() - 0.48) * config.basePrice * 0.02; // Slight upward bias
  const spotPrice = Math.round((config.basePrice + baseMovement) * 100) / 100;
  const prevClose = Math.round((config.basePrice - (rand() - 0.48) * config.basePrice * 0.01) * 100) / 100;
  const spotChange = Math.round((spotPrice - prevClose) * 100) / 100;
  const spotChangePct = Math.round((spotChange / prevClose) * 10000) / 100;

  const expiries = generateExpiries();
  const selectedExpiry = expiryDate || expiries[0]?.date || new Date().toISOString().split('T')[0];
  const expiryInfo = expiries.find(e => e.date === selectedExpiry) || expiries[0];
  const daysToExpiry = expiryInfo?.daysToExpiry || 1;
  const timeToExpiry = Math.max(daysToExpiry / 365, 1 / 365);

  // ATM strike
  const atmStrike = Math.round(spotPrice / config.stepSize) * config.stepSize;

  // Generate strikes range
  const range = config.rangeFactor * spotPrice;
  const minStrike = Math.round((spotPrice - range) / config.stepSize) * config.stepSize;
  const maxStrike = Math.round((spotPrice + range) / config.stepSize) * config.stepSize;

  const strikes: number[] = [];
  for (let s = minStrike; s <= maxStrike; s += config.stepSize) {
    strikes.push(s);
  }

  // India VIX simulation
  const indiaVIX = Math.round((13 + rand() * 8) * 100) / 100;
  const vixChange = Math.round((rand() - 0.5) * 3 * 100) / 100;

  // Generate option data for each strike
  const data: OptionData[] = strikes.map(strike => {
    const moneyness = (strike - spotPrice) / spotPrice;
    const distanceFromATM = Math.abs(strike - atmStrike) / config.stepSize;

    // Base IV - smile shape
    const baseIV = 0.13 + Math.abs(moneyness) * 0.8 + (rand() - 0.5) * 0.02;
    const ceIV = Math.round(Math.max(0.05, baseIV + (rand() - 0.5) * 0.03) * 10000) / 100;
    const peIV = Math.round(Math.max(0.05, baseIV + 0.01 + (rand() - 0.5) * 0.03) * 10000) / 100;

    // OI pattern - higher near ATM, realistic distribution
    const oiMultiplier = Math.exp(-distanceFromATM * 0.15);
    const roundNumberOI = Math.random() > 0.3;

    const baseCallOI = roundNumberOI
      ? Math.round((50000 + rand() * 500000) * oiMultiplier / 100) * 100
      : Math.round((50000 + rand() * 500000) * oiMultiplier);

    const basePutOI = roundNumberOI
      ? Math.round((40000 + rand() * 400000) * oiMultiplier / 100) * 100
      : Math.round((40000 + rand() * 400000) * oiMultiplier);

    // Add significant OI at round numbers and support/resistance levels
    let callOI = baseCallOI;
    let putOI = basePutOI;
    if (distanceFromATM < 4) {
      callOI = Math.round(callOI * (1.5 + rand() * 2));
      putOI = Math.round(putOI * (1.5 + rand() * 2));
    }

    // OI Change
    const ceOIChg = Math.round((rand() - 0.4) * callOI * 0.3 / 100) * 100;
    const peOIChg = Math.round((rand() - 0.4) * putOI * 0.3 / 100) * 100;

    // Volume
    const ceVolume = Math.round((10000 + rand() * 300000) * oiMultiplier);
    const peVolume = Math.round((8000 + rand() * 250000) * oiMultiplier);

    // LTP based on intrinsic + time value
    const ceIntrinsic = Math.max(0, spotPrice - strike);
    const peIntrinsic = Math.max(0, strike - spotPrice);
    const ceTimeValue = Math.max(0.05, (ceIV / 100) * spotPrice * Math.sqrt(timeToExpiry) * 0.4 * Math.exp(-distanceFromATM * 0.3));
    const peTimeValue = Math.max(0.05, (peIV / 100) * spotPrice * Math.sqrt(timeToExpiry) * 0.4 * Math.exp(-distanceFromATM * 0.3));

    const ceLTP = Math.round((ceIntrinsic + ceTimeValue) * 100) / 100;
    const peLTP = Math.round((peIntrinsic + peTimeValue) * 100) / 100;

    // Price change
    const ceChg = Math.round((rand() - 0.45) * ceLTP * 0.2 * 100) / 100;
    const peChg = Math.round((rand() - 0.55) * peLTP * 0.2 * 100) / 100;

    // Greeks
    const ceGreeks = calculateGreeks(spotPrice, strike, timeToExpiry, ceIV / 100, true);
    const peGreeks = calculateGreeks(spotPrice, strike, timeToExpiry, peIV / 100, false);

    // Deep ITM options might have very low volume/OI
    const ceDeepITM = strike < spotPrice - range * 0.7;
    const peDeepITM = strike > spotPrice + range * 0.7;

    return {
      strike,
      ce: ceDeepITM ? null : {
        oi: callOI,
        oiChg: ceOIChg,
        volume: ceDeepITM ? Math.round(ceVolume * 0.1) : ceVolume,
        iv: ceIV,
        ltp: ceLTP,
        chg: ceChg,
        ...ceGreeks,
      },
      pe: peDeepITM ? null : {
        oi: putOI,
        oiChg: peOIChg,
        volume: peDeepITM ? Math.round(peVolume * 0.1) : peVolume,
        iv: peIV,
        ltp: peLTP,
        chg: peChg,
        ...peGreeks,
      },
    };
  });

  // Calculate totals
  const totalCallOI = data.reduce((sum, d) => sum + (d.ce?.oi || 0), 0);
  const totalPutOI = data.reduce((sum, d) => sum + (d.pe?.oi || 0), 0);
  const totalCallVolume = data.reduce((sum, d) => sum + (d.ce?.volume || 0), 0);
  const totalPutVolume = data.reduce((sum, d) => sum + (d.pe?.volume || 0), 0);
  const pcr = totalPutOI > 0 ? Math.round((totalCallOI / totalPutOI) * 100) / 100 : 0;

  // Max Pain calculation - find strike where combined OI is maximum
  let maxPainStrike = atmStrike;
  let maxCombinedOI = 0;
  data.forEach(d => {
    const combined = (d.ce?.oi || 0) + (d.pe?.oi || 0);
    if (combined > maxCombinedOI) {
      maxCombinedOI = combined;
      maxPainStrike = d.strike;
    }
  });

  const summary: MarketSummary = {
    spotPrice,
    spotChange,
    spotChangePct,
    open: Math.round((prevClose + (rand() - 0.5) * prevClose * 0.005) * 100) / 100,
    high: Math.round((spotPrice + rand() * spotPrice * 0.01) * 100) / 100,
    low: Math.round((spotPrice - rand() * spotPrice * 0.01) * 100) / 100,
    prevClose,
    indiaVIX,
    vixChange,
    pcr,
    maxPain: maxPainStrike,
    totalCallOI,
    totalPutOI,
    totalCallVolume,
    totalPutVolume,
    atmStrike,
  };

  return {
    symbol,
    spotPrice,
    expiries,
    selectedExpiry,
    data,
    summary,
    timestamp: new Date().toISOString(),
  };
}

// Format numbers for Indian display
export function formatIndianNumber(num: number): string {
  if (num >= 10000000) {
    return (num / 10000000).toFixed(2) + ' Cr';
  }
  if (num >= 100000) {
    return (num / 100000).toFixed(2) + ' L';
  }
  if (num >= 1000) {
    return num.toLocaleString('en-IN');
  }
  return num.toString();
}

export function formatNumber(num: number, decimals: number = 2): string {
  return num.toFixed(decimals);
}
