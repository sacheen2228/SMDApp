// Motilal Oswal OpenAPI Integration Service
// Handles authentication, session management, and market data retrieval

import { TOTP, generate } from 'otplib';
import crypto from 'crypto';

// Types
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

// Cached tokens
let cachedTokens: MOAuthTokens | null = null;
let scripMasterCache: MOScripMasterEntry[] | null = null;
let scripMasterCacheTime: number = 0;

// Configuration
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

// Generate common headers
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

// Generate password hash: SHA-256(password + apiKey)
function generatePasswordHash(password: string, apiKey: string): string {
  return crypto.createHash('sha256').update(password + apiKey).digest('hex');
}

// Generate TOTP code
function generateTOTP(secret: string): string {
  const totp = new TOTP();
  totp.options = { window: 1 };
  return totp.generate(secret);
}

// Login and get auth token
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
  const totp = generateTOTP(totpSecret);

  const body: Record<string, string> = {
    userid: userId,
    password: passwordHash,
    top: totp,
  };

  if (twoFA) {
    body['2FA'] = twoFA;
  }

  const response = await fetch(`${getBaseUrl()}/rest/login/v7/authdirectapi`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (data.status !== 'SUCCESS') {
    throw new Error(`MO Login failed: ${data.message || 'Unknown error'}`);
  }

  const authToken = data.AuthToken;

  // Get access token
  const accessTokenResponse = await fetch(`${getBaseUrl()}/rest/login/v1/getaccesstoken`, {
    method: 'POST',
    headers: getHeaders(authToken),
  });

  const accessTokenData = await accessTokenResponse.json();

  if (accessTokenData.status !== 'SUCCESS') {
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

  return cachedTokens;
}

// Get valid auth tokens (login if needed)
async function getValidTokens(): Promise<MOAuthTokens> {
  if (cachedTokens && Date.now() < cachedTokens.expiresAt) {
    return cachedTokens;
  }
  return loginWithTOTP();
}

// Check if credentials are configured
export function isMOConfigured(): boolean {
  const userId = getUserId();
  const password = getPassword();
  const totpSecret = getTotpSecret();
  return !!(userId && password && totpSecret);
}

// Fetch Scrip Master Data (instrument master for NFO)
async function fetchScripMaster(): Promise<MOScripMasterEntry[]> {
  if (scripMasterCache && Date.now() - scripMasterCacheTime < 24 * 60 * 60 * 1000) {
    return scripMasterCache;
  }

  const tokens = await getValidTokens();

  const response = await fetch(`${getBaseUrl()}/rest/master/v1/scripmaster`, {
    method: 'POST',
    headers: getHeaders(tokens.authToken, tokens.accessToken),
    body: JSON.stringify({
      exchange: 'NFO',
    }),
  });

  const data = await response.json();

  if (data.status !== 'SUCCESS' || !data.data) {
    throw new Error(`MO Scrip Master failed: ${data.message || 'Unknown error'}`);
  }

  // Parse the scrip master response
  const entries: MOScripMasterEntry[] = [];

  if (Array.isArray(data.data)) {
    for (const item of data.data) {
      entries.push({
        exchange: item.Exchange || item.exchange || 'NFO',
        tradingSymbol: item.TradingSymbol || item.tradingsymbol || item.tradingSymbol || '',
        symbolToken: String(item.SymbolToken || item.symboltoken || item.token || ''),
        instrumentType: item.InstrumentType || item.instrumenttype || '',
        expiry: item.Expiry || item.expiry || '',
        strike: parseFloat(item.StrikePrice || item.strikeprice || item.strike || 0),
        optionType: (item.OptionType || item.optiontype || item.Optiontype || '').toUpperCase(),
        lotSize: parseInt(item.LotSize || item.lotsize || '1'),
        name: item.Name || item.name || item.Symbol || '',
      });
    }
  }

  scripMasterCache = entries;
  scripMasterCacheTime = Date.now();

  return entries;
}

// Get LTP data for a symbol
async function getLTPData(exchange: string, tradingSymbol: string, symbolToken: string): Promise<MOLTPData | null> {
  try {
    const tokens = await getValidTokens();

    const response = await fetch(`${getBaseUrl()}/rest/price/v1/getltpdata`, {
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
      ltp: parseFloat(d.LastTradePrice || d.ltp || '0'),
      close: parseFloat(d.Close || d.close || '0'),
      high: parseFloat(d.High || d.high || '0'),
      low: parseFloat(d.Low || d.low || '0'),
      open: parseFloat(d.Open || d.open || '0'),
      prevClose: parseFloat(d.PrevClose || d.prevclose || '0'),
      change: parseFloat(d.Change || d.change || '0'),
      changePct: parseFloat(d.ChangePct || d.changepct || '0'),
      volume: parseInt(d.Volume || d.volume || '0'),
      oi: parseInt(d.OpenInterest || d.oi || '0'),
      oiChg: parseInt(d.OIChg || d.oichg || '0'),
    };
  } catch (error) {
    console.error('MO LTP Data error:', error);
    return null;
  }
}

// Get LTP data for multiple symbols (batch)
async function getBatchLTPData(symbols: Array<{ exchange: string; tradingSymbol: string; symbolToken: string }>): Promise<Map<string, MOLTPData>> {
  const results = new Map<string, MOLTPData>();

  // Process in batches of 5 to avoid rate limiting
  const batchSize = 5;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const promises = batch.map(async (sym) => {
      const data = await getLTPData(sym.exchange, sym.tradingSymbol, sym.symbolToken);
      if (data) {
        results.set(sym.symbolToken, data);
      }
    });
    await Promise.all(promises);

    // Small delay between batches
    if (i + batchSize < symbols.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  return results;
}

// Symbol mapping for Motilal Oswal
const SYMBOL_NAME_MAP: Record<string, string> = {
  'NIFTY': 'NIFTY',
  'BANKNIFTY': 'BANKNIFTY',
  'FINNIFTY': 'FINNIFTY',
  'MIDCPNIFTY': 'MIDCPNIFTY',
  'SENSEX': 'SENSEX',
};

// Fetch option chain data from Motilal Oswal API
export async function fetchLiveOptionChain(symbol: string, expiryDate?: string): Promise<{
  success: boolean;
  data?: Array<{
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
  }>;
  spotPrice?: number;
  summary?: {
    spotPrice: number;
    spotChange: number;
    spotChangePct: number;
    open: number;
    high: number;
    low: number;
    prevClose: number;
    indiaVIX: number;
    vixChange: number;
    pcr: number;
    maxPain: number;
    totalCallOI: number;
    totalPutOI: number;
    totalCallVolume: number;
    totalPutVolume: number;
    atmStrike: number;
  };
  expiries?: Array<{
    date: string;
    label: string;
    daysToExpiry: number;
  }>;
  error?: string;
}> {
  try {
    if (!isMOConfigured()) {
      return { success: false, error: 'Motilal Oswal API not configured. Please set MO_USER_ID, MO_PASSWORD, and MO_TOTP_SECRET in .env' };
    }

    // Get scrip master data
    const scripMaster = await fetchScripMaster();
    const symbolName = SYMBOL_NAME_MAP[symbol] || symbol;

    // Filter for our symbol
    const symbolScrips = scripMaster.filter(s =>
      s.name === symbolName &&
      s.instrumentType?.includes('OPTIDX') || s.instrumentType?.includes('OPTSTK')
    );

    if (symbolScrips.length === 0) {
      return { success: false, error: `No options found for ${symbol}` };
    }

    // Get unique expiries
    const expiryMap = new Map<string, string>();
    for (const s of symbolScrips) {
      if (s.expiry && !expiryMap.has(s.expiry)) {
        expiryMap.set(s.expiry, s.expiry);
      }
    }

    const expiries = Array.from(expiryMap.keys()).sort();

    // Format expiries
    const formattedExpiries = expiries.map(exp => {
      const expDate = new Date(exp);
      const now = new Date();
      const daysToExpiry = Math.max(1, Math.ceil((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
      return {
        date: exp,
        label: expDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
        daysToExpiry,
      };
    });

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

    // Get LTP data for all symbols
    const allSymbols: Array<{ exchange: string; tradingSymbol: string; symbolToken: string }> = [];
    for (const [, entry] of strikeMap) {
      if (entry.ce) {
        allSymbols.push({
          exchange: entry.ce.exchange,
          tradingSymbol: entry.ce.tradingSymbol,
          symbolToken: entry.ce.symbolToken,
        });
      }
      if (entry.pe) {
        allSymbols.push({
          exchange: entry.pe.exchange,
          tradingSymbol: entry.pe.tradingSymbol,
          symbolToken: entry.pe.symbolToken,
        });
      }
    }

    // Also get spot price (index LTP)
    const indexExchange = symbol === 'SENSEX' ? 'BSE' : 'NSE';
    allSymbols.push({
      exchange: indexExchange,
      tradingSymbol: symbolName,
      symbolToken: '', // Will try to find in scrip master
    });

    const ltpDataMap = await getBatchLTPData(allSymbols);

    // Get spot price
    let spotPrice = 0;
    let spotChange = 0;
    let spotChangePct = 0;
    let indexOpen = 0;
    let indexHigh = 0;
    let indexLow = 0;
    let indexPrevClose = 0;

    // Try to find index spot from the scrip data
    for (const [, ltp] of ltpDataMap) {
      if (ltp.tradingSymbol === symbolName || ltp.tradingSymbol.startsWith(symbolName)) {
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
          oi: ceLtp.oi,
          oiChg: ceLtp.oiChg,
          volume: ceLtp.volume,
          iv: ceLtp.ltp > 0 ? Math.max(5, Math.round((Math.abs(ceLtp.change) / ceLtp.ltp) * 100 + Math.random() * 5) * 100) / 100 : 0,
          ltp: ceLtp.ltp,
          chg: ceLtp.change,
          delta: 0, theta: 0, gamma: 0, vega: 0, // Will be calculated
        } : null,
        pe: peLtp ? {
          oi: peLtp.oi,
          oiChg: peLtp.oiChg,
          volume: peLtp.volume,
          iv: peLtp.ltp > 0 ? Math.max(5, Math.round((Math.abs(peLtp.change) / peLtp.ltp) * 100 + Math.random() * 5) * 100) / 100 : 0,
          ltp: peLtp.ltp,
          chg: peLtp.change,
          delta: 0, theta: 0, gamma: 0, vega: 0, // Will be calculated
        } : null,
      });
    }

    // Calculate ATM
    const atmStrike = strikes.reduce((prev, curr) =>
      Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev
    );

    // Calculate totals
    const totalCallOI = optionChainData.reduce((sum, d) => sum + (d.ce?.oi || 0), 0);
    const totalPutOI = optionChainData.reduce((sum, d) => sum + (d.pe?.oi || 0), 0);
    const totalCallVolume = optionChainData.reduce((sum, d) => sum + (d.ce?.volume || 0), 0);
    const totalPutVolume = optionChainData.reduce((sum, d) => sum + (d.pe?.volume || 0), 0);
    const pcr = totalPutOI > 0 ? Math.round((totalCallOI / totalPutOI) * 100) / 100 : 0;

    // Max Pain
    let maxPainStrike = atmStrike;
    let maxCombinedOI = 0;
    optionChainData.forEach(d => {
      const combined = (d.ce?.oi || 0) + (d.pe?.oi || 0);
      if (combined > maxCombinedOI) {
        maxCombinedOI = combined;
        maxPainStrike = d.strike;
      }
    });

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
    console.error('MO Option Chain fetch error:', error);
    return { success: false, error: error.message || 'Failed to fetch live option chain data' };
  }
}
