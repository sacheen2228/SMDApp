// ICICI Breeze API - Authentication using official SDK
// Uses breezeconnect npm package

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
    return false;
  }
}

// ─── Initialize Session ───────────────────────────────────────────
export async function initSession(): Promise<boolean> {
  try {
    // Try cached session first
    if (currentApiSession) {
      return true;
    }

    // Try loading cached session from disk
    try {
      const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
      const cached: CachedSession = JSON.parse(raw);
      if (cached.expiresAt > Date.now()) {
        currentApiSession = cached.apiSession;
        return true;
      }
    } catch {
      // No cached session or expired
    }

    // Try env session token
    const config = getConfig();
    if (config.sessionToken) {
      await generateSession(config.sessionToken);
      return true;
    }

    return false;
  } catch (err) {
    console.error('[Breeze SDK] initSession error:', err);
    return false;
  }
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

// ─── Get or Create Breeze Client ──────────────────────────────────
export function getBreezeClient(): BreezeConnect {
  const appKey = process.env.BREEZE_APP_KEY;
  if (!appKey) throw new Error('Missing BREEZE_APP_KEY in .env');

  if (!breezeClient) {
    breezeClient = new BreezeConnect({ appKey });
  }
  return breezeClient;
}

// ─── Export BreezeConnect class ────────────────────────────────────
export { BreezeConnect };

// ─── Auto-Retry Wrapper ────────────────────────────────────────────
// Wraps any Breeze SDK call and retries once on auth errors (401/403/token expired).
// Re-initializes session before retry. User must update .env token if it's truly expired.
const AUTH_ERROR_PATTERNS = [401, 403, '401', '403', 'INVALID', 'SESSION', 'EXPIRED', 'UNAUTHORIZED'];

export async function withAuthRetry<T>(fn: (client: BreezeConnect) => Promise<T>): Promise<T> {
  if (!currentApiSession) {
    await initSession();
  }
  const client = getBreezeClient();
  try {
    return await fn(client);
  } catch (err: any) {
    const msg = String(err?.message || err?.status || err || '');
    const isAuthErr = AUTH_ERROR_PATTERNS.some(p => msg.toUpperCase().includes(String(p).toUpperCase()));
    if (isAuthErr) {
      console.warn('[Breeze Auth] Auth error detected, re-initializing session...');
      currentApiSession = null;
      breezeClient = null;
      const ok = await initSession();
      if (!ok) throw new Error('Breeze session expired and re-init failed. Update .env BREEZE_SESSION_TOKEN.');
      return await fn(getBreezeClient());
    }
    throw err;
  }
}
