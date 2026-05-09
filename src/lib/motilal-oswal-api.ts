// Motilal Oswal OpenAPI Integration Service
// Handles authentication, session management, and market data retrieval
// Based on MOFSL OpenAPI V3.1 SDK endpoints
//
// API Docs: https://invest.motilaloswal.com/moAPI/APIDocumentation/Introduction
//
// IMPORTANT: This API requires requests from a registered Static IP.
// The app will fall back to Yahoo Finance + simulation if MO API is unreachable.
//
// KEY FINDINGS from official docs:
// - Base URL: https://openapi.motilaloswal.com
// - Login: POST /rest/login/v7/authdirectapi with { userid, password(SHA256), 2FA, totp }
// - Password hash: SHA-256(password + apiKey) lowercase hex
// - 2FA: Date of birth in DD/MM/YYYY format
// - LTP data: POST /rest/report/v3/getltpdata with { exchange, scripcode }
// - Index LTP: POST /rest/report/v3/getindexltpdata with { exchange, scripcode(string) }
// - LTP values are in PAISA (multiply by 0.01 for rupees)
// - Scrip master: POST /rest/report/v3/getscripsbyexchangename with { exchangename }
// - All calls need: Authorization, ApiKey, apisecretkey, accesstoken headers

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
  scripcode: number | string;
  ltp: number;       // in rupees (converted from paisa)
  close: number;
  high: number;
  low: number;
  open: number;
  volume: number;
  ask: number;
  bid: number;
}

interface MOScripMasterEntry {
  exchange: string;
  exchangename: string;
  scripcode: number;
  scripname: string;
  scripshortname: string;
  marketlot: number;
  instrumentname: string;
  expirydate: string;
  strikeprice: number;
  optiontype: string;
  issuspended: number;
  markettype: string;
}

// ─── Cached State ────────────────────────────────────────────────
let cachedTokens: MOAuthTokens | null = null;
let scripMasterCache: MOScripMasterEntry[] | null = null;
let scripMasterCacheTime: number = 0;
let moApiReachable: boolean | null = null; // null = not tested yet

// ─── API Endpoints (from MOFSL OpenAPI V3.1 SDK) ────────────────
const ENDPOINTS = {
  login: '/rest/login/v7/authdirectapi',
  accessToken: '/rest/login/v1/getaccesstoken',
  getProfile: '/rest/login/v5/getprofile',
  ltpData: '/rest/report/v3/getltpdata',
  indexLtp: '/rest/report/v3/getindexltpdata',
  scripMaster: '/rest/report/v3/getscripsbyexchangename',
  optionChain: '/rest/report/v3/getoptionchaindata',
};

// ─── Configuration ───────────────────────────────────────────────
function getBaseUrl(): string {
  return process.env.MO_BASE_URL || 'https://openapi.motilaloswal.com';
}

function getApiKey(): string {
  return process.env.MO_API_KEY || '';
}

function getApiSecret(): string {
  return process.env.MO_API_SECRET || '';
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

function getStaticIP(): string {
  return process.env.MO_STATIC_IP || '';
}

// ─── Headers (as per official API docs) ──────────────────────────
function getHeaders(authToken?: string, accessToken?: string): Record<string, string> {
  const staticIP = getStaticIP();
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'MOSL/V.1.1.0',
    'ApiKey': getApiKey(),
    'ClientLocalIp': staticIP || '127.0.0.1',
    'ClientPublicIp': staticIP || '127.0.0.1',
    'MacAddress': '00:00:00:00:00:00',
    'SourceId': 'WEB',
    'vendorinfo': getUserId(),
    'osname': 'Linux',
    'osversion': '5.0',
    'devicemodel': 'Server',
    'manufacturer': 'Cloud',
    'productname': 'Sacheen',
    'productversion': '1.0',
    'browsername': 'Chrome',
    'browserversion': '120.0',
  };

  // Add apisecretkey (mandatory for all authenticated calls)
  if (getApiSecret()) {
    headers['apisecretkey'] = getApiSecret();
  }

  if (authToken) {
    headers['Authorization'] = authToken;
  }
  if (accessToken) {
    headers['accesstoken'] = accessToken;
  }

  return headers;
}

// ─── Password Hash: SHA-256(password + apiKey) ──────────────────
// As per MO API docs: hash = SHA-256(password_string + apikey_string)
function generatePasswordHash(password: string, apiKey: string): string {
  return crypto.createHash('sha256').update(password + apiKey).digest('hex');
}

// ─── TOTP Generation ─────────────────────────────────────────────
function generateTOTP(secret: string): string {
  const totp = new TOTP();
  totp.options = { window: 1 };
  return totp.generate(secret);
}

// ─── Check if MO API is reachable ────────────────────────────────
async function checkMOApiReachable(): Promise<boolean> {
  if (moApiReachable !== null) {
    return moApiReachable;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    // Try a simple HEAD request to the base URL
    await fetch(`${getBaseUrl()}/rest/login/v7/authdirectapi`, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    });

    clearTimeout(timeoutId);
    moApiReachable = true;
    return true;
  } catch {
    console.warn('[MO API] Server is unreachable - will use fallback data sources');
    moApiReachable = false;
    // Re-check every 5 minutes
    setTimeout(() => { moApiReachable = null; }, 5 * 60 * 1000);
    return false;
  }
}

// ─── Login with TOTP ─────────────────────────────────────────────
async function loginWithTOTP(): Promise<MOAuthTokens> {
  const userId = getUserId();
  const password = getPassword();
  const apiKey = getApiKey();
  const totpSecret = getTotpSecret();
  const twoFA = getTwoFA();

  if (!userId || !password) {
    throw new Error('Missing Motilal Oswal credentials (MO_USER_ID, MO_PASSWORD)');
  }

  // Generate password hash: SHA-256(password + apiKey)
  const passwordHash = generatePasswordHash(password, apiKey);

  // Build login body per official API docs
  const body: Record<string, string> = {
    userid: userId,
    password: passwordHash,
  };

  // Add 2FA (date of birth in DD/MM/YYYY format) if provided
  if (twoFA) {
    body['2FA'] = twoFA;
  }

  // Add TOTP if secret is configured
  if (totpSecret) {
    const totpCode = generateTOTP(totpSecret);
    body['totp'] = totpCode;
    console.log(`[MO API] Generated TOTP: ${totpCode}`);
  }

  console.log(`[MO API] Logging in as ${userId}...`);

  const response = await fetch(`${getBaseUrl()}${ENDPOINTS.login}`, {
    method: 'POST',
    headers: getHeaders(), // No auth token yet for login
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  const data = await response.json();

  if (data.status !== 'SUCCESS') {
    console.error('[MO API] Login failed:', JSON.stringify(data));
    throw new Error(`MO Login failed: ${data.message || data.errorcode || 'Unknown error'}`);
  }

  const authToken = data.AuthToken;
  console.log('[MO API] Login successful, AuthToken received');

  // Get access token (no body needed, just headers)
  const accessTokenResponse = await fetch(`${getBaseUrl()}${ENDPOINTS.accessToken}`, {
    method: 'POST',
    headers: getHeaders(authToken, authToken), // Use authToken as initial accessToken
    signal: AbortSignal.timeout(10000),
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
    expiresAt: Date.now() + 22 * 60 * 60 * 1000, // Token expires daily at 6 AM
  };

  moApiReachable = true;
  console.log('[MO API] Access token obtained successfully');
  return cachedTokens;
}

// ─── Get Valid Auth Tokens ───────────────────────────────────────
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
  return !!(userId && password);
}

// ─── Convert paisa to rupees ────────────────────────────────────
function paisaToRupees(paisa: number): number {
  return paisa * 0.01;
}

// ─── Fetch Scrip Master Data ─────────────────────────────────────
async function fetchScripMaster(exchangeName: string = 'NFO'): Promise<MOScripMasterEntry[]> {
  if (scripMasterCache && Date.now() - scripMasterCacheTime < 4 * 60 * 60 * 1000) {
    return scripMasterCache.filter(s => s.exchangename === exchangeName);
  }

  const tokens = await getValidTokens();

  console.log(`[MO API] Fetching scrip master for ${exchangeName}...`);

  const response = await fetch(`${getBaseUrl()}${ENDPOINTS.scripMaster}`, {
    method: 'POST',
    headers: getHeaders(tokens.authToken, tokens.accessToken),
    body: JSON.stringify({
      exchangename: exchangeName,
    }),
    signal: AbortSignal.timeout(30000),
  });

  const data = await response.json();

  if (data.status !== 'SUCCESS' || !data.data) {
    throw new Error(`MO Scrip Master failed: ${data.message || 'Unknown error'}`);
  }

  const items = Array.isArray(data.data) ? data.data : (data.data.records || data.data.result || []);

  const entries: MOScripMasterEntry[] = [];
  for (const item of items) {
    entries.push({
      exchange: item.exchange || item.Exchange || exchangeName,
      exchangename: item.exchangename || item.ExchangeName || exchangeName,
      scripcode: parseInt(item.scripcode || item.ScripCode || item.symboltoken || item.SymbolToken || '0'),
      scripname: item.scripname || item.ScripName || item.name || '',
      scripshortname: item.scripshortname || item.ScripShortName || item.tradingsymbol || item.TradingSymbol || '',
      marketlot: parseInt(item.marketlot || item.MarketLot || item.lotsize || '1'),
      instrumentname: item.instrumentname || item.InstrumentName || item.instrumenttype || '',
      expirydate: item.expirydate || item.ExpiryDate || item.expiry || '',
      strikeprice: parseFloat(item.strikeprice || item.StrikePrice || item.strike || '0'),
      optiontype: (item.optiontype || item.OptionType || item.Option || '').toUpperCase(),
      issuspended: parseInt(item.issuspended || item.IsSuspended || '0'),
      markettype: item.markettype || item.MarketType || '',
    });
  }

  // Cache all entries
  if (scripMasterCache) {
    // Merge with existing cache
    const existingExchanges = new Set(scripMasterCache.map(s => s.exchangename));
    if (!existingExchanges.has(exchangeName)) {
      scripMasterCache = [...scripMasterCache, ...entries];
    }
  } else {
    scripMasterCache = entries;
  }
  scripMasterCacheTime = Date.now();

  console.log(`[MO API] Scrip Master loaded: ${entries.length} instruments for ${exchangeName}`);
  return entries;
}

// ─── Get LTP data for an option/stock ───────────────────────────
async function getLTPData(exchange: string, scripcode: number): Promise<MOLTPData | null> {
  try {
    const tokens = await getValidTokens();

    const response = await fetch(`${getBaseUrl()}${ENDPOINTS.ltpData}`, {
      method: 'POST',
      headers: getHeaders(tokens.authToken, tokens.accessToken),
      body: JSON.stringify({
        exchange,
        scripcode,
      }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await response.json();

    if (data.status !== 'SUCCESS' || !data.data) {
      return null;
    }

    const d = data.data;
    return {
      exchange: d.exchange || exchange,
      scripcode: d.scripcode || scripcode,
      ltp: paisaToRupees(parseFloat(d.ltp || d.LTP || '0')),
      close: paisaToRupees(parseFloat(d.close || d.Close || '0')),
      high: paisaToRupees(parseFloat(d.high || d.High || '0')),
      low: paisaToRupees(parseFloat(d.low || d.Low || '0')),
      open: paisaToRupees(parseFloat(d.open || d.Open || '0')),
      volume: parseInt(d.volume || d.Volume || '0'),
      ask: paisaToRupees(parseFloat(d.ask || d.Ask || '0')),
      bid: paisaToRupees(parseFloat(d.bid || d.Bid || '0')),
    };
  } catch (error) {
    console.error('[MO API] LTP Data error:', error);
    return null;
  }
}

// ─── Get Index LTP data ──────────────────────────────────────────
async function getIndexLTPData(exchange: string, scripcode: string): Promise<MOLTPData | null> {
  try {
    const tokens = await getValidTokens();

    const response = await fetch(`${getBaseUrl()}${ENDPOINTS.indexLtp}`, {
      method: 'POST',
      headers: getHeaders(tokens.authToken, tokens.accessToken),
      body: JSON.stringify({
        exchange,
        scripcode, // String for index LTP
      }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await response.json();

    if (data.status !== 'SUCCESS' || !data.data) {
      return null;
    }

    const d = data.data;
    return {
      exchange: d.exchange || exchange,
      scripcode: d.scripcode || scripcode,
      ltp: paisaToRupees(parseFloat(d.ltp || d.LTP || '0')),
      close: paisaToRupees(parseFloat(d.close || d.Close || '0')),
      high: paisaToRupees(parseFloat(d.high || d.High || '0')),
      low: paisaToRupees(parseFloat(d.low || d.Low || '0')),
      open: paisaToRupees(parseFloat(d.open || d.Open || '0')),
      volume: parseInt(d.volume || d.Volume || '0'),
      ask: paisaToRupees(parseFloat(d.ask || d.Ask || '0')),
      bid: paisaToRupees(parseFloat(d.bid || d.Bid || '0')),
    };
  } catch (error) {
    console.error('[MO API] Index LTP error:', error);
    return null;
  }
}

// ─── Batch LTP data fetch ────────────────────────────────────────
async function getBatchLTPData(
  symbols: Array<{ exchange: string; scripcode: number }>
): Promise<Map<number, MOLTPData>> {
  const results = new Map<number, MOLTPData>();

  const batchSize = 5;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const promises = batch.map(async (sym) => {
      const data = await getLTPData(sym.exchange, sym.scripcode);
      if (data) {
        results.set(sym.scripcode, data);
      }
    });
    await Promise.all(promises);

    // Small delay between batches to avoid rate limiting
    if (i + batchSize < symbols.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
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

const INDEX_TOKEN_MAP: Record<string, { exchange: string; scripcode: string }> = {
  'NIFTY': { exchange: 'NSE', scripcode: '26000' },
  'BANKNIFTY': { exchange: 'NSE', scripcode: '26009' },
  'FINNIFTY': { exchange: 'NSE', scripcode: '26037' },
  'MIDCPNIFTY': { exchange: 'NSE', scripcode: '26028' },
  'SENSEX': { exchange: 'BSE', scripcode: '1' },
};

// Exchange name mapping for scrip master
const EXCHANGE_MAP: Record<string, string> = {
  'NIFTY': 'NFO',
  'BANKNIFTY': 'NFO',
  'FINNIFTY': 'NFO',
  'MIDCPNIFTY': 'NFO',
  'SENSEX': 'BSE',
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

    // Check if API is reachable first
    const isReachable = await checkMOApiReachable();
    if (!isReachable) {
      return { success: false, error: 'MO API server unreachable from this network' };
    }

    const symbolName = SYMBOL_NAME_MAP[symbol] || symbol;
    const exchangeName = EXCHANGE_MAP[symbol] || 'NFO';

    // Step 1: Login
    const tokens = await getValidTokens();

    // Step 2: Fetch scrip master
    const allScripEntries = await fetchScripMaster(exchangeName);

    // Filter for our symbol's options
    const symbolScrips = allScripEntries.filter(s => {
      const shortName = s.scripshortname.toUpperCase();
      const name = s.scripname.toUpperCase();
      const matchesSymbol = shortName.startsWith(symbolName) || name.includes(symbolName);
      const isOption = s.instrumentname?.includes('OPTIDX') || s.instrumentname?.includes('OPTSTK') ||
                       s.optiontype === 'CE' || s.optiontype === 'PE';
      const notSuspended = s.issuspended === 0;
      return matchesSymbol && isOption && notSuspended;
    });

    if (symbolScrips.length === 0) {
      console.warn(`[MO API] No option instruments found for ${symbolName} on ${exchangeName}`);
      return { success: false, error: `No options found for ${symbol}` };
    }

    console.log(`[MO API] Found ${symbolScrips.length} option instruments for ${symbolName}`);

    // Get unique expiries
    const expirySet = new Set<string>();
    for (const s of symbolScrips) {
      if (s.expirydate) expirySet.add(s.expirydate);
    }

    const expiries = Array.from(expirySet).sort();

    // Format expiries for display
    const formattedExpiries = expiries.map(exp => {
      let expDate: Date;
      // Try various date formats from MO API
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
    }).filter(e => e.daysToExpiry >= 0);

    // Select expiry (nearest if not specified)
    const selectedExpiry = expiryDate || expiries[0] || '';
    const expiryScrips = symbolScrips.filter(s => s.expiry === selectedExpiry || s.expirydate === selectedExpiry);

    if (expiryScrips.length === 0) {
      return { success: false, error: `No options found for ${symbol} at expiry ${selectedExpiry}` };
    }

    // Group by strike
    const strikeMap = new Map<number, { ce?: MOScripMasterEntry; pe?: MOScripMasterEntry }>();
    for (const s of expiryScrips) {
      const strike = s.strikeprice;
      if (!strikeMap.has(strike)) strikeMap.set(strike, {});
      const entry = strikeMap.get(strike)!;
      if (s.optiontype === 'CE') entry.ce = s;
      else if (s.optiontype === 'PE') entry.pe = s;
    }

    const strikes = Array.from(strikeMap.keys()).sort((a, b) => a - b);
    console.log(`[MO API] ${strikeMap.size} strikes for ${symbolName} expiry ${selectedExpiry}`);

    // Step 3: Get spot price from index LTP
    let spotPrice = 0, spotChange = 0, spotChangePct = 0;
    let indexOpen = 0, indexHigh = 0, indexLow = 0, indexPrevClose = 0;

    const indexInfo = INDEX_TOKEN_MAP[symbolName];
    if (indexInfo) {
      const indexLtp = await getIndexLTPData(indexInfo.exchange, indexInfo.scripcode);
      if (indexLtp && indexLtp.ltp > 0) {
        spotPrice = indexLtp.ltp;
        indexOpen = indexLtp.open;
        indexHigh = indexLtp.high;
        indexLow = indexLtp.low;
        indexPrevClose = indexLtp.close;
        if (indexPrevClose > 0) {
          spotChange = Math.round((spotPrice - indexPrevClose) * 100) / 100;
          spotChangePct = Math.round((spotChange / indexPrevClose) * 10000) / 100;
        }
        console.log(`[MO API] Index spot: ${symbolName} = ${spotPrice}`);
      }
    }

    // Step 4: Get LTP data for all option contracts
    const allSymbols: Array<{ exchange: string; scripcode: number; strike: number; type: string }> = [];
    for (const [strike, entry] of strikeMap) {
      if (entry.ce) allSymbols.push({ exchange: entry.ce.exchange, scripcode: entry.ce.scripcode, strike, type: 'CE' });
      if (entry.pe) allSymbols.push({ exchange: entry.pe.exchange, scripcode: entry.pe.scripcode, strike, type: 'PE' });
    }

    console.log(`[MO API] Fetching LTP data for ${allSymbols.length} option contracts...`);
    const ltpDataMap = await getBatchLTPData(allSymbols.map(s => ({ exchange: s.exchange, scripcode: s.scripcode })));
    console.log(`[MO API] Received LTP data for ${ltpDataMap.size} contracts`);

    // Step 5: Build option chain data
    const optionChainData: Array<{ strike: number; ce: any; pe: any }> = [];

    for (const strike of strikes) {
      const entry = strikeMap.get(strike)!;
      const ceLtp = entry.ce ? ltpDataMap.get(entry.ce.scripcode) : null;
      const peLtp = entry.pe ? ltpDataMap.get(entry.pe.scripcode) : null;

      optionChainData.push({
        strike,
        ce: ceLtp ? {
          oi: 0,           // MO LTP endpoint doesn't return OI - will be estimated
          oiChg: 0,
          volume: ceLtp.volume || 0,
          iv: 0,           // Will be calculated from price
          ltp: ceLtp.ltp || 0,
          chg: ceLtp.close > 0 ? Math.round((ceLtp.ltp - ceLtp.close) * 100) / 100 : 0,
          delta: 0, theta: 0, gamma: 0, vega: 0, // Will be calculated
        } : null,
        pe: peLtp ? {
          oi: 0,
          oiChg: 0,
          volume: peLtp.volume || 0,
          iv: 0,
          ltp: peLtp.ltp || 0,
          chg: peLtp.close > 0 ? Math.round((peLtp.ltp - peLtp.close) * 100) / 100 : 0,
          delta: 0, theta: 0, gamma: 0, vega: 0,
        } : null,
      });
    }

    // Calculate ATM
    const atmStrike = spotPrice > 0
      ? strikes.reduce((prev, curr) => Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev)
      : strikes[Math.floor(strikes.length / 2)];

    // Calculate totals
    const totalCallOI = optionChainData.reduce((sum, d) => sum + (d.ce?.oi || 0), 0);
    const totalPutOI = optionChainData.reduce((sum, d) => sum + (d.pe?.oi || 0), 0);
    const totalCallVolume = optionChainData.reduce((sum, d) => sum + (d.ce?.volume || 0), 0);
    const totalPutVolume = optionChainData.reduce((sum, d) => sum + (d.pe?.volume || 0), 0);
    const pcr = totalPutOI > 0 ? Math.round((totalCallOI / totalPutOI) * 100) / 100 : 0;

    return {
      success: true,
      data: optionChainData,
      spotPrice,
      summary: {
        spotPrice, spotChange, spotChangePct,
        open: indexOpen, high: indexHigh, low: indexLow, prevClose: indexPrevClose,
        indiaVIX: 0, vixChange: 0,
        pcr, maxPain: atmStrike,
        totalCallOI, totalPutOI, totalCallVolume, totalPutVolume, atmStrike,
      },
      expiries: formattedExpiries,
    };
  } catch (error: any) {
    console.error('[MO API] Option Chain fetch error:', error);
    return { success: false, error: error.message || 'Failed to fetch live option chain data' };
  }
}

// ─── Test Connection ─────────────────────────────────────────────
export async function testMOConnection(): Promise<{
  success: boolean;
  message: string;
  details?: any;
}> {
  try {
    if (!isMOConfigured()) {
      return { success: false, message: 'API not configured. Set MO_USER_ID, MO_PASSWORD in .env' };
    }

    // Check reachability first
    const isReachable = await checkMOApiReachable();
    if (!isReachable) {
      return {
        success: false,
        message: 'MO API server unreachable. Your Static IP may not match or the server is down.',
        details: {
          configuredIP: getStaticIP(),
          baseUrl: getBaseUrl(),
          hint: 'Ensure the app runs from a network with the registered Static IP',
        },
      };
    }

    // Try to login
    const tokens = await getValidTokens();

    // Try to get profile
    const profileResponse = await fetch(`${getBaseUrl()}${ENDPOINTS.getProfile}`, {
      method: 'POST',
      headers: getHeaders(tokens.authToken, tokens.accessToken),
      signal: AbortSignal.timeout(10000),
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
