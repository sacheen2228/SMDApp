// ICICI Breeze API - Authentication using official SDK
// Uses breezeconnect npm package
// Note: SDK's getOptionChainQuotes has a validation bug (|| should be &&)
// so we monkey-patch it after client creation

import { BreezeConnect } from 'breezeconnect';
import fs from 'fs';
import path from 'path';

// ─── Session Cache ────────────────────────────────────────────────
const SESSION_FILE = path.join(process.cwd(), '.breeze-session.json');

interface CachedSession {
  apiSession: string;
  createdAt: number;
  expiresAt: number;
}

// ─── Singleton Breeze Client ──────────────────────────────────────
let breezeClient: BreezeConnect | null = null;
let currentApiSession: string | null = null;

// ─── Patched getOptionChainQuotes (bypass broken SDK validation) ──
function patchOptionChainQuotes(client: BreezeConnect) {
  const orig = (client as any).getOptionChainQuotes;
  if (orig.__patched) return;

  (client as any).getOptionChainQuotes = async function(params: any) {
    const { stockCode = "", exchangeCode = "", expiryDate = "", productType = "", right = "", strikePrice = "" } = params;

    // Validation (fixed logic using && instead of ||)
    if (exchangeCode === "" || exchangeCode === null) {
      return { Success: "", Status: 500, Error: "Exchange code cannot be empty" };
    }
    const ecLower = exchangeCode.toLowerCase();
    if (ecLower !== "nfo" && ecLower !== "bfo") {
      return { Success: "", Status: 500, Error: "Exchange code should be nfo or bfo" };
    }
    if (productType === "" || productType === null) {
      return { Success: "", Status: 500, Error: "Product type cannot be empty" };
    }
    if (productType.toLowerCase() !== "futures" && productType.toLowerCase() !== "options") {
      return { Success: "", Status: 500, Error: "Product-type should be either futures or options" };
    }
    if (stockCode === null || stockCode === "") {
      return { Success: "", Status: 500, Error: "Stock code cannot be empty" };
    }

    // Build body
    const body: any = {
      stock_code: stockCode,
      exchange_code: exchangeCode,
    };
    if (expiryDate) body.expiry_date = expiryDate;
    if (productType) body.product_type = productType;
    if (right) body.right = right;
    if (strikePrice) body.strike_price = strikePrice;

    // Call the SDK's generateHeaders and makeRequest directly
    const headers = (client as any).generateHeaders(body);
    const result = await (client as any).makeRequest("GET", "optionchain", body, headers);
    return result?.data;
  };
  (client as any).getOptionChainQuotes.__patched = true;
}

// ─── Get or Create Breeze Client ──────────────────────────────────
export function getBreezeClient(): BreezeConnect {
  const appKey = process.env.BREEZE_APP_KEY;
  if (!appKey) throw new Error('Missing BREEZE_APP_KEY in .env');

  if (!breezeClient) {
    breezeClient = new BreezeConnect({ appKey });
    patchOptionChainQuotes(breezeClient);
  }
  return breezeClient;
}

// ─── Generate Session ─────────────────────────────────────────────
export async function generateSession(apiSession?: string): Promise<any> {
  const config = getConfig();
  const session = apiSession || config.sessionToken;

  if (!session) {
    throw new Error('No API session provided. Login at https://api.icicidirect.com/apiuser/login?api_key=' + encodeURIComponent(config.appKey));
  }

  const breeze = getBreezeClient();
  console.log('[Breeze SDK] Generating session with:', session.substring(0, 10) + '...');

    const result = await breeze.generateSession(config.secretKey, session);

    // Check if session generation actually succeeded
    if (!result || (result as any)?.Status === 401 || (result as any)?.Error) {
      const errMsg = (result as any)?.Error || 'Authentication failed — token may be expired';
      console.error('[Breeze SDK] Session generation failed:', errMsg);
      throw new Error(`Breeze auth failed: ${errMsg}. Please generate a new session token at https://api.icicidirect.com/apiuser/login?api_key=${encodeURIComponent(config.appKey)}`);
    }

    currentApiSession = session;

    // Cache the session
    const cached: CachedSession = {
      apiSession: session,
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    };
    try {
      fs.writeFileSync(SESSION_FILE, JSON.stringify(cached, null, 2));
    } catch {}

    console.log('[Breeze SDK] Session generated successfully');
    return result;
}

// ─── Initialize from Cache ────────────────────────────────────────
export async function initSession(): Promise<boolean> {
  // Try cached session first
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const cached: CachedSession = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
      if (Date.now() < cached.expiresAt) {
        console.log('[Breeze SDK] Restoring cached session');
        await generateSession(cached.apiSession);
        return true;
      }
    }
  } catch {}

  // Try env token
  const envToken = process.env.BREEZE_SESSION_TOKEN;
  if (envToken) {
    try {
      console.log('[Breeze SDK] Trying env BREEZE_SESSION_TOKEN...');
      await generateSession(envToken);
      return true;
    } catch (err: any) {
      console.warn('[Breeze SDK] Env token failed:', err.message);
    }
  }

  return false;
}

// ─── Get Config ───────────────────────────────────────────────────
export function getConfig() {
  const appKey = process.env.BREEZE_APP_KEY || '';
  const secretKey = process.env.BREEZE_SECRET_KEY || '';
  const sessionToken = process.env.BREEZE_SESSION_TOKEN || '';

  if (!appKey || !secretKey) {
    throw new Error('Missing BREEZE_APP_KEY or BREEZE_SECRET_KEY in .env');
  }

  return { appKey, secretKey, sessionToken };
}

// ─── Validate Session ─────────────────────────────────────────────
export async function validateSession(): Promise<boolean> {
  try {
    const breeze = getBreezeClient();
    await breeze.getCustomerDetails();
    return true;
  } catch {
    // Try re-init
    try {
      return await initSession();
    } catch {
      return false;
    }
  }
}

export { BreezeConnect };
