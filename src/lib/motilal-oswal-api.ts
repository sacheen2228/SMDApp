// Motilal Oswal OpenAPI Integration Service
// Handles authentication, session management, and market data retrieval
// Based on MOFSL OpenAPI V3.1 SDK endpoints

import { TOTP } from 'otplib';
import crypto from 'crypto';

// ─── Types ───────────────────────────────────────────────────────
interface MOAuthTokens {
  authToken: string;
  accessToken: string;
  userId: string;
  expiresAt: number;
}

interface MOLTPData {
  exchange: string;
  tradingSymbol: string;
  symbolToken: string;
  ltp: number;
  close: number;
  high: number;
  low: number;
  open: number;
  prevClose: number;
  change: number;
  changePct: number;
  volume: number;
  oi: number;
  oiChg: number;
}

interface MOScripMasterEntry {
  exchange: string;
  tradingSymbol: string;
  symbolToken: string;
  instrumentType: string;
  expiry: string;
  strike: number;
  optionType: string;
  lotSize: number;
  name: string;
}

// ─── Cached State ────────────────────────────────────────────────
let cachedTokens: MOAuthTokens | null = null;
let scripMasterCache: MOScripMasterEntry[] | null = null;
let scripMasterCacheTime: number = 0;

// ─── API Endpoints (from MOFSL OpenAPI V3.1 SDK) ────────────────
const ENDPOINTS = {
  login: '/rest/login/v7/authdirectapi',
  accessToken: '/rest/login/v1/getaccesstoken',
  getProfile: '/rest/login/v5/getprofile',
  ltpData: '/rest/report/v3/getltpdata',
  scripMaster: '/rest/report/v3/getscripsbyexchangename',
  indexLtp: '/rest/report/v3/getindexltp',
};

// ─── Configuration ───────────────────────────────────────────────
function getBaseUrl(): string {
  return process.env.MO_BASE_URL || 'https://openapi.motilaloswal.com';
}

function getApiKey(): string {
  return process.env.MO_API_KEY || '';
}

function getTotpSecret(): string {
  return process.env.MO_TOTP_SECRET || '';
}

function getUserId(): string {
  return process.env.MO_USER_ID || '';
}

function getPassword(): string {
  return process.env.MO_PASSWORD || '';
}

function getTwoFA(): string {
  return process.env.MO_TWO_FA || '';
}

// ─── Headers ─────────────────────────────────────────────────────
function getHeaders(authToken?: string, accessToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'MOSL/V.1.1.0',
    'ApiKey': getApiKey(),
    'ClientLocalIp': '127.0.0.1',
    'ClientPublicIp': '127.0.0.1',
    'MacAddress': '00:00:00:00:00:00',
    'SourceId': 'WEB',
    'vendorinfo': getUserId(),
    'osname': 'Linux',
    'osversion': '5.0',
    'devicemodel': 'Server',
    'manufacturer': 'Cloud',
    'productname': 'OptionChain',
    'productversion': '1.0',
  };

  if (authToken) {
    headers['Authorization'] = authToken;
  }
  if (accessToken) {
    headers['accesstoken'] = accessToken;
  }

  return headers;
}

// ─── Password Hash: SHA-256(password + apiKey) ──────────────────
function generatePasswordHash(password: string, apiKey: string): string {
  return crypto.createHash('sha256').update(password + apiKey).digest('hex');
}

// ─── TOTP Generation ─────────────────────────────────────────────
function generateTOTP(secret: string): string {
  const totp = new TOTP();
  totp.options = { window: 1 };
  return totp.generate(secret);
}

// ─── Login with TOTP ─────────────────────────────────────────────
async function loginWithTOTP(): Promise<MOAuthTokens> {
  const userId = getUserId();
  const password = getPassword();
  const apiKey = getApiKey();
  const totpSecret = getTotpSecret();
  const twoFA = getTwoFA();

  if (!userId || !password || !totpSecret) {
    throw new Error('Missing Motilal Oswal credentials. Set MO_USER_ID, MO_PASSWORD, and MO_TOTP_SECRET in .env');
  }

  const passwordHash = generatePasswordHash(password, apiKey);
  const totpCode = generateTOTP(totpSecret);

  const body: Record<string, string> = {
    userid: userId,
    password: passwordHash,
    totp: totpCode, // FIX: was "top" (typo)
  };

  if (twoFA) {
    body['2FA'] = twoFA;
  }

  console.log(`[MO API] Logging in as ${userId}...`);

  const response = await fetch(`${getBaseUrl()}${ENDPOINTS.login}`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (data.status !== 'SUCCESS') {
    console.error('[MO API] Login failed:', JSON.stringify(data));
    throw new Error(`MO Login failed: ${data.message || data.errorcode || 'Unknown error'}`);
  }

  const authToken = data.AuthToken;
  console.log('[MO API] Login successful, getting access token...');

  // Get access token
  const accessTokenResponse = await fetch(`${getBaseUrl()}${ENDPOINTS.accessToken}`, {
    method: 'POST',
    headers: getHeaders(authToken),
  });

  const accessTokenData = await accessTokenResponse.json();

  if (accessTokenData.status !== 'SUCCESS') {
    console.error('[MO API] Access token failed:', JSON.stringify(accessTokenData));
    throw new Error(`MO Access Token failed: ${accessTokenData.message || 'Unknown error'}`);
  }

  const accessToken = accessTokenData.accesstoken;

  cachedTokens = {
    authToken,
    accessToken,
    userId,
    // Token expires at 6 AM next day (exchange compliance)
    expiresAt: Date.now() + 23 * 60 * 60 * 1000,
  };

  console.log('[MO API] Access token obtained successfully');
  return cachedTokens;
}

// ─── Get Valid Auth Tokens (login if needed) ─────────────────────
async function getValidTokens(): Promise<MOAuthTokens> {
  if (cachedTokens && Date.now() < cachedTokens.expiresAt) {
    return cachedTokens;
  }
  return loginWithTOTP();
}

// ─── Check if credentials are configured ─────────────────────────
export function isMOConfigured(): boolean {
  const userId = getUserId();
  const password = getPassword();
  const totpSecret = getTotpSecret();
  return !!(userId && password && totpSecret);
}

// ─── Fetch Scrip Master Data ─────────────────────────────────────
async function fetchScripMaster(exchange: string = 'NFO'): Promise<MOScripMasterEntry[]> {
  if (scripMasterCache && Date.now() - scripMasterCacheTime < 4 * 60 * 60 * 1000) {
    return scripMasterCache;
  }

  const tokens = await getValidTokens();

  console.log(`[MO API] Fetching scrip master for ${exchange}...`);

  const response = await fetch(`${getBaseUrl()}${ENDPOINTS.scripMaster}`, {
    method: 'POST',
    headers: getHeaders(tokens.authToken, tokens.accessToken),
    body: JSON.stringify({
      exchange,
    }),
  });

  const data = await response.json();

  if (data.status !== 'SUCCESS' || !data.data) {
    console.error('[MO API] Scrip Master failed:', JSON.stringify(data));
    throw new Error(`MO Scrip Master failed: ${data.message || 'Unknown error'}`);
  }

  // Parse the scrip master response
  const entries: MOScripMasterEntry[] = [];

  const items = Array.isArray(data.data) ? data.data : (data.data.records || data.data.result || []);
  
  for (const item of items) {
    entries.push({
      exchange: item.Exchange || item.exchange || exchange,
      tradingSymbol: item.TradingSymbol || item.tradingsymbol || item.tradingSymbol || '',
      symbolToken: String(item.SymbolToken || item.symboltoken || item.token || item.symbol_token || ''),
      instrumentType: item.InstrumentType || item.instrumenttype || item.Instrumenttype || '',
      expiry: item.Expiry || item.expiry || item.ExpiryDate || '',
      strike: parseFloat(item.StrikePrice || item.strikeprice || item.strike || item.Strike || 0),
      optionType: (item.OptionType || item.optiontype || item.Optiontype || item.Option || '').toUpperCase(),
      lotSize: parseInt(item.LotSize || item.lotsize || item.Lotsize || '1'),
      name: item.Name || item.name || item.Symbol || item.symbol || '',
    });
  }

  scripMasterCache = entries;
  scripMasterCacheTime = Date.now();
  console.log(`[MO API] Scrip Master loaded: ${entries.length} instruments`);

  return entries;
}

// ─── Get Index LTP (spot price for indices) ──────────────────────
async function getIndexLTP(exchange: string): Promise<{
  ltp: number; change: number; changePct: number;
  open: number; high: number; low: number; prevClose: number;
} | null> {
  try {
    const tokens = await getValidTokens();

    const response = await fetch(`${getBaseUrl()}${ENDPOINTS.indexLtp}`, {
      method: 'POST',
      headers: getHeaders(tokens.authToken, tokens.accessToken),
      body: JSON.stringify({ exchange }),
    });

    const data = await response.json();

    if (data.status !== 'SUCCESS' || !data.data) {
      console.warn('[MO API] Index LTP failed:', data.message || 'No data');
      return null;
    }

    // Try to find the index data
    const indexData = Array.isArray(data.data) ? data.data : [data.data];
    
    for (const item of indexData) {
      return {
        ltp: parseFloat(item.LTP || item.ltp || item.LastTradePrice || '0'),
        change: parseFloat(item.Change || item.change || '0'),
        changePct: parseFloat(item.ChangePct || item.changepct || '0'),
        open: parseFloat(item.Open || item.open || '0'),
        high: parseFloat(item.High || item.high || '0'),
        low: parseFloat(item.Low || item.low || '0'),
        prevClose: parseFloat(item.PrevClose || item.prevclose || item.PreviousClose || '0'),
      };
    }

    return null;
  } catch (error) {
    console.error('[MO API] Index LTP error:', error);
    return null;
  }
}

// ─── Get LTP data for a symbol ───────────────────────────────────
async function getLTPData(exchange: string, tradingSymbol: string, symbolToken: string): Promise<MOLTPData | null> {
  try {
    const tokens = await getValidTokens();

    const response = await fetch(`${getBaseUrl()}${ENDPOINTS.ltpData}`, {
      method: 'POST',
      headers: getHeaders(tokens.authToken, tokens.accessToken),
      body: JSON.stringify({
        exchange,
        tradingsymbol: tradingSymbol,
        symboltoken: symbolToken,
      }),
    });

    const data = await response.json();

    if (data.status !== 'SUCCESS' || !data.data) {
      return null;
    }

    const d = data.data;
    return {
      exchange: d.Exchange || exchange,
      tradingSymbol: d.TradingSymbol || tradingSymbol,
      symbolToken: d.SymbolToken || symbolToken,
      ltp: parseFloat(d.LastTradePrice || d.ltp || d.LTP || '0'),
      close: parseFloat(d.Close || d.close || '0'),
      high: parseFloat(d.High || d.high || '0'),
      low: parseFloat(d.Low || d.low || '0'),
      open: parseFloat(d.Open || d.open || '0'),
      prevClose: parseFloat(d.PrevClose || d.prevclose || '0'),
      change: parseFloat(d.Change || d.change || '0'),
      changePct: parseFloat(d.ChangePct || d.changepct || '0'),
      volume: parseInt(d.Volume || d.volume || d.TotalVolume || '0'),
      oi: parseInt(d.OpenInterest || d.oi || d.OpenInterest || '0'),
      oiChg: parseInt(d.OIChg || d.oichg || d.OpenInterestChange || '0'),
    };
  } catch (error) {
    console.error('[MO API] LTP Data error:', error);
    return null;
  }
}

// ─── Batch LTP data fetch ────────────────────────────────────────
async function getBatchLTPData(symbols: Array<{ exchange: string; tradingSymbol: string; symbolToken: string }>): Promise<Map<string, MOLTPData>> {
  const results = new Map<string, MOLTPData>();

  // Process in batches of 3 to avoid rate limiting
  const batchSize = 3;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const promises = batch.map(async (sym) => {
      const data = await getLTPData(sym.exchange, sym.tradingSymbol, sym.symbolToken);
      if (data) {
        results.set(sym.symbolToken, data);
      }
    });
    await Promise.all(promises);

    // Delay between batches
    if (i + batchSize < symbols.length) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  return results;
}

// ─── Symbol mapping ──────────────────────────────────────────────
const SYMBOL_NAME_MAP: Record<string, string> = {
  'NIFTY': 'NIFTY',
  'BANKNIFTY': 'BANKNIFTY',
  'FINNIFTY': 'FINNIFTY',
  'MIDCPNIFTY': 'MIDCPNIFTY',
  'SENSEX': 'SENSEX',
};

// Symbol token mapping for indices (common NSE/BSE tokens)
const INDEX_TOKEN_MAP: Record<string, { exchange: string; token: string }> = {
  'NIFTY': { exchange: 'NSE', token: '26000' },
  'BANKNIFTY': { exchange: 'NSE', token: '26009' },
  'FINNIFTY': { exchange: 'NSE', token: '26037' },
  'MIDCPNIFTY': { exchange: 'NSE', token: '26028' },
  'SENSEX': { exchange: 'BSE', token: '1' },
};

// ─── Fetch Option Chain Data ─────────────────────────────────────
export async function fetchLiveOptionChain(symbol: string, expiryDate?: string): Promise<{
  success: boolean;
  data?: Array<{
    strike: number;
    ce: {
      oi: number; oiChg: number; volume: number; iv: number;
      ltp: number; chg: number; delta: number; theta: number;
      gamma: number; vega: number;
    } | null;
    pe: {
      oi: number; oiChg: number; volume: number; iv: number;
      ltp: number; chg: number; delta: number; theta: number;
      gamma: number; vega: number;
    } | null;
  }>;
  spotPrice?: number;
  summary?: {
    spotPrice: number; spotChange: number; spotChangePct: number;
    open: number; high: number; low: number; prevClose: number;
    indiaVIX: number; vixChange: number; pcr: number; maxPain: number;
    totalCallOI: number; totalPutOI: number;
    totalCallVolume: number; totalPutVolume: number; atmStrike: number;
  };
  expiries?: Array<{ date: string; label: string; daysToExpiry: number }>;
  error?: string;
}> {
  try {
    if (!isMOConfigured()) {
      return { success: false, error: 'Motilal Oswal API not configured' };
    }

    const symbolName = SYMBOL_NAME_MAP[symbol] || symbol;
    
    // Determine which exchanges to check
    const isSensex = symbol === 'SENSEX';
    const exchanges = isSensex ? ['BSE'] : ['NFO'];

    // Fetch scrip master for relevant exchanges
    let allScripEntries: MOScripMasterEntry[] = [];
    for (const exchange of exchanges) {
      try {
        const entries = await fetchScripMaster(exchange);
        allScripEntries = allScripEntries.concat(entries);
      } catch (err) {
        console.warn(`[MO API] Failed to fetch scrip master for ${exchange}:`, err);
      }
    }

    // Filter for our symbol - FIX: proper operator precedence
    const symbolScrips = allScripEntries.filter(s =>
      (s.name === symbolName || s.tradingSymbol.startsWith(symbolName)) &&
      (s.instrumentType?.includes('OPTIDX') || s.instrumentType?.includes('OPTSTK'))
    );

    if (symbolScrips.length === 0) {
      console.warn(`[MO API] No options found for ${symbolName}. Trying broader search...`);
      // Broader search - just match the name
      const broaderScrips = allScripEntries.filter(s =>
        s.name === symbolName && s.optionType && s.strike > 0
      );
      if (broaderScrips.length === 0) {
        return { success: false, error: `No options found for ${symbol}` };
      }
      symbolScrips.push(...broaderScrips);
    }

    console.log(`[MO API] Found ${symbolScrips.length} option instruments for ${symbolName}`);

    // Get unique expiries
    const expirySet = new Set<string>();
    for (const s of symbolScrips) {
      if (s.expiry) {
        expirySet.add(s.expiry);
      }
    }

    const expiries = Array.from(expirySet).sort();

    // Format expiries
    const formattedExpiries = expiries.map(exp => {
      // Handle different date formats
      let expDate: Date;
      if (/^\d{4}-\d{2}-\d{2}/.test(exp)) {
        expDate = new Date(exp);
      } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(exp)) {
        const [d, m, y] = exp.split('/');
        expDate = new Date(`${y}-${m}-${d}`);
      } else if (/^\d{13,}$/.test(exp)) {
        expDate = new Date(parseInt(exp));
      } else {
        expDate = new Date(exp);
      }
      
      const now = new Date();
      const daysToExpiry = Math.max(0, Math.ceil((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
      return {
        date: exp,
        label: !isNaN(expDate.getTime()) 
          ? expDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
          : exp,
        daysToExpiry: Math.max(daysToExpiry, 0),
      };
    }).filter(e => e.daysToExpiry >= 0); // Filter out expired

    // Select expiry
    const selectedExpiry = expiryDate || expiries[0] || '';
    const expiryScrips = symbolScrips.filter(s => s.expiry === selectedExpiry);

    if (expiryScrips.length === 0) {
      return { success: false, error: `No options found for ${symbol} at expiry ${selectedExpiry}` };
    }

    // Group by strike
    const strikeMap = new Map<number, { ce?: MOScripMasterEntry; pe?: MOScripMasterEntry }>();
    for (const s of expiryScrips) {
      const strike = s.strike;
      if (!strikeMap.has(strike)) {
        strikeMap.set(strike, {});
      }
      const entry = strikeMap.get(strike)!;
      if (s.optionType === 'CE' || s.optionType === 'CALL') {
        entry.ce = s;
      } else if (s.optionType === 'PE' || s.optionType === 'PUT') {
        entry.pe = s;
      }
    }

    console.log(`[MO API] ${strikeMap.size} strikes for ${symbolName} expiry ${selectedExpiry}`);

    // Get LTP data for all option symbols (limit to nearby strikes for performance)
    const allSymbols: Array<{ exchange: string; tradingSymbol: string; symbolToken: string }> = [];
    
    // We'll fetch all, but prioritize strikes near the money
    for (const [, entry] of strikeMap) {
      if (entry.ce && entry.ce.symbolToken) {
        allSymbols.push({
          exchange: entry.ce.exchange,
          tradingSymbol: entry.ce.tradingSymbol,
          symbolToken: entry.ce.symbolToken,
        });
      }
      if (entry.pe && entry.pe.symbolToken) {
        allSymbols.push({
          exchange: entry.pe.exchange,
          tradingSymbol: entry.pe.tradingSymbol,
          symbolToken: entry.pe.symbolToken,
        });
      }
    }

    // Fetch all LTP data
    console.log(`[MO API] Fetching LTP data for ${allSymbols.length} option contracts...`);
    const ltpDataMap = await getBatchLTPData(allSymbols);
    console.log(`[MO API] Received LTP data for ${ltpDataMap.size} contracts`);

    // Get spot price (index LTP)
    let spotPrice = 0;
    let spotChange = 0;
    let spotChangePct = 0;
    let indexOpen = 0;
    let indexHigh = 0;
    let indexLow = 0;
    let indexPrevClose = 0;

    // Try to get index LTP directly
    const indexInfo = INDEX_TOKEN_MAP[symbolName];
    if (indexInfo) {
      const indexLtp = await getLTPData(indexInfo.exchange, symbolName, indexInfo.token);
      if (indexLtp && indexLtp.ltp > 0) {
        spotPrice = indexLtp.ltp;
        spotChange = indexLtp.change;
        spotChangePct = indexLtp.changePct;
        indexOpen = indexLtp.open;
        indexHigh = indexLtp.high;
        indexLow = indexLtp.low;
        indexPrevClose = indexLtp.prevClose;
      }
    }

    // Fallback: try to find from LTP data
    if (spotPrice === 0) {
      for (const [, ltp] of ltpDataMap) {
        if (ltp.tradingSymbol === symbolName || ltp.tradingSymbol.startsWith(symbolName + ' ')) {
          spotPrice = ltp.ltp;
          spotChange = ltp.change;
          spotChangePct = ltp.changePct;
          indexOpen = ltp.open;
          indexHigh = ltp.high;
          indexLow = ltp.low;
          indexPrevClose = ltp.prevClose;
          break;
        }
      }
    }

    // If still no spot price, estimate from ATM strike
    if (spotPrice === 0 && ltpDataMap.size > 0) {
      // Find the strike with highest combined CE+PE volume
      let bestStrike = 0;
      let bestVol = 0;
      for (const [token, ltp] of ltpDataMap) {
        if (ltp.volume > bestVol) {
          bestVol = ltp.volume;
          // Find the strike for this token
          for (const [strike, entry] of strikeMap) {
            if (entry.ce?.symbolToken === token || entry.pe?.symbolToken === token) {
              bestStrike = strike;
              break;
            }
          }
        }
      }
      if (bestStrike > 0) {
        spotPrice = bestStrike;
      }
    }

    console.log(`[MO API] Spot price for ${symbolName}: ${spotPrice}`);

    // Build option chain data
    const optionChainData: Array<{
      strike: number;
      ce: any;
      pe: any;
    }> = [];

    const strikes = Array.from(strikeMap.keys()).sort((a, b) => a - b);

    for (const strike of strikes) {
      const entry = strikeMap.get(strike)!;

      const ceLtp = entry.ce ? ltpDataMap.get(entry.ce.symbolToken) : null;
      const peLtp = entry.pe ? ltpDataMap.get(entry.pe.symbolToken) : null;

      optionChainData.push({
        strike,
        ce: ceLtp ? {
          oi: ceLtp.oi || 0,
          oiChg: ceLtp.oiChg || 0,
          volume: ceLtp.volume || 0,
          iv: 0, // Will be calculated by the route handler
          ltp: ceLtp.ltp || 0,
          chg: ceLtp.change || 0,
          delta: 0, theta: 0, gamma: 0, vega: 0, // Will be calculated
        } : null,
        pe: peLtp ? {
          oi: peLtp.oi || 0,
          oiChg: peLtp.oiChg || 0,
          volume: peLtp.volume || 0,
          iv: 0, // Will be calculated by the route handler
          ltp: peLtp.ltp || 0,
          chg: peLtp.change || 0,
          delta: 0, theta: 0, gamma: 0, vega: 0, // Will be calculated
        } : null,
      });
    }

    // Calculate ATM
    const atmStrike = spotPrice > 0
      ? strikes.reduce((prev, curr) =>
          Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev
        )
      : strikes[Math.floor(strikes.length / 2)];

    // Calculate totals
    const totalCallOI = optionChainData.reduce((sum, d) => sum + (d.ce?.oi || 0), 0);
    const totalPutOI = optionChainData.reduce((sum, d) => sum + (d.pe?.oi || 0), 0);
    const totalCallVolume = optionChainData.reduce((sum, d) => sum + (d.ce?.volume || 0), 0);
    const totalPutVolume = optionChainData.reduce((sum, d) => sum + (d.pe?.volume || 0), 0);
    const pcr = totalPutOI > 0 ? Math.round((totalCallOI / totalPutOI) * 100) / 100 : 0;

    // Max Pain calculation (proper method)
    let maxPainStrike = atmStrike;
    let minPainValue = Infinity;
    for (const testStrike of strikes) {
      let painValue = 0;
      for (const d of optionChainData) {
        if (d.ce && d.strike < testStrike) {
          painValue += d.ce.oi * (testStrike - d.strike);
        }
        if (d.pe && d.strike > testStrike) {
          painValue += d.pe.oi * (d.strike - testStrike);
        }
      }
      if (painValue < minPainValue) {
        minPainValue = painValue;
        maxPainStrike = testStrike;
      }
    }

    return {
      success: true,
      data: optionChainData,
      spotPrice,
      summary: {
        spotPrice,
        spotChange,
        spotChangePct,
        open: indexOpen,
        high: indexHigh,
        low: indexLow,
        prevClose: indexPrevClose,
        indiaVIX: 0,
        vixChange: 0,
        pcr,
        maxPain: maxPainStrike,
        totalCallOI,
        totalPutOI,
        totalCallVolume,
        totalPutVolume,
        atmStrike,
      },
      expiries: formattedExpiries,
    };
  } catch (error: any) {
    console.error('[MO API] Option Chain fetch error:', error);
    return { success: false, error: error.message || 'Failed to fetch live option chain data' };
  }
}

// ─── Test Connection (for debugging) ─────────────────────────────
export async function testMOConnection(): Promise<{
  success: boolean;
  message: string;
  details?: any;
}> {
  try {
    if (!isMOConfigured()) {
      return { success: false, message: 'API not configured. Set MO_USER_ID, MO_PASSWORD, and MO_TOTP_SECRET in .env' };
    }

    // Try to login
    const tokens = await getValidTokens();

    // Try to get profile
    const profileResponse = await fetch(`${getBaseUrl()}${ENDPOINTS.getProfile}`, {
      method: 'POST',
      headers: getHeaders(tokens.authToken, tokens.accessToken),
    });

    const profileData = await profileResponse.json();

    return {
      success: true,
      message: 'Connected to Motilal Oswal API successfully',
      details: {
        userId: tokens.userId,
        profile: profileData.status === 'SUCCESS' ? profileData.data : null,
      },
    };
  } catch (error: any) {
    return { success: false, message: error.message, details: null };
  }
}
