// ICICI Breeze API - Authentication using official SDK
// Uses breezeconnect npm package
// Enhanced with concurrent refresh lock + health tracking

import { BreezeConnect } from 'breezeconnect';
import fs from 'fs';
import path from 'path';
import { providerHealth } from '../provider-health';

// ─── Session Cache ────────────────────────────────────────────────
const SESSION_FILE = path.join(process.cwd(), '.breeze-session.json');

interface CachedSession {
  apiSession: string;
  createdAt: number;
  expiresAt: number;
}

// ─── Session State ────────────────────────────────────────────────
export type BreezeStatus = "LIVE" | "EXPIRED" | "ERROR" | "UNKNOWN" | "NOT_CONFIGURED";

interface BreezeSessionState {
  status: BreezeStatus;
  authenticated: boolean;
  sessionToken?: string;
  createdAt?: string;
  expiresAt?: string;
  lastSuccessfulRequest?: string;
  consecutiveAuthFailures: number;
}

// ─── Singleton Breeze Client ──────────────────────────────────────
let breezeClient: BreezeConnect | null = null;
let currentApiSession: string | null = null;
let sessionState: BreezeSessionState = {
  status: "UNKNOWN",
  authenticated: false,
  consecutiveAuthFailures: 0,
};

// ─── Concurrent Refresh Lock ──────────────────────────────────────
let refreshPromise: Promise<boolean> | null = null;

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

// ─── Get Session State ────────────────────────────────────────────
export function getSessionState(): BreezeSessionState {
  return { ...sessionState };
}

// ─── Validate Session ─────────────────────────────────────────────
export async function validateSession(): Promise<boolean> {
  try {
    const breeze = getBreezeClient();
    await breeze.getCustomerDetails();
    sessionState.status = "LIVE";
    sessionState.authenticated = true;
    sessionState.lastSuccessfulRequest = new Date().toISOString();
    sessionState.consecutiveAuthFailures = 0;
    providerHealth.recordSuccess("breeze", 0);
    return true;
  } catch {
    sessionState.status = "ERROR";
    sessionState.authenticated = false;
    return false;
  }
}

// ─── Initialize Session (with concurrent refresh protection) ──────
export async function initSession(): Promise<boolean> {
  // If a refresh is already in progress, wait for it
  if (refreshPromise) {
    console.log('[Breeze] Waiting for existing refresh...');
    return refreshPromise;
  }

  // Start a new refresh
  refreshPromise = doInitSession();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function doInitSession(): Promise<boolean> {
  try {
    // Try loading cached session from disk
    try {
      const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
      const cached: CachedSession = JSON.parse(raw);
      if (cached.expiresAt > Date.now()) {
        currentApiSession = cached.apiSession;
        const breeze = getBreezeClient();
        if (!breeze.sessionKey || !breeze.userId) {
          const config = getConfig();
          await Promise.race([
            breeze.generateSession(config.secretKey, cached.apiSession),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Breeze SDK timeout')), 8_000)),
          ]);
        }
        sessionState.status = "LIVE";
        sessionState.authenticated = true;
        sessionState.sessionToken = cached.apiSession.substring(0, 10) + '...';
        sessionState.createdAt = new Date(cached.createdAt).toISOString();
        sessionState.expiresAt = new Date(cached.expiresAt).toISOString();
        providerHealth.recordSuccess("breeze", 0);
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

    sessionState.status = "NOT_CONFIGURED";
    sessionState.authenticated = false;
    return false;
  } catch (err: any) {
    console.error('[Breeze SDK] initSession error:', err);
    sessionState.status = "ERROR";
    sessionState.authenticated = false;
    sessionState.consecutiveAuthFailures++;
    providerHealth.recordFailure("breeze", "AUTH", err.message);
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

  const result = await Promise.race([
    breeze.generateSession(config.secretKey, session),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Breeze SDK timeout')), 8_000)),
  ]);

  // Breeze SDK returns undefined on success (no error object = success)
  // Only treat as error if result explicitly has an error
  if (result && (result as any)?.Status === 401) {
    const errMsg = (result as any)?.Error || 'Authentication failed — token may be expired';
    console.error('[Breeze SDK] Session generation failed:', errMsg);
    sessionState.status = "EXPIRED";
    sessionState.authenticated = false;
    sessionState.consecutiveAuthFailures++;
    providerHealth.recordFailure("breeze", "AUTH", errMsg);
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

  sessionState.status = "LIVE";
  sessionState.authenticated = true;
  sessionState.sessionToken = session.substring(0, 10) + '...';
  sessionState.createdAt = new Date(cached.createdAt).toISOString();
  sessionState.expiresAt = new Date(cached.expiresAt).toISOString();
  sessionState.consecutiveAuthFailures = 0;
  providerHealth.recordSuccess("breeze", 0);

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

// ─── Auto-Retry Wrapper (with concurrent refresh protection) ──────
// Wraps any Breeze SDK call and retries once on auth errors (401/403/token expired).
// Uses shared refresh promise to prevent duplicate refresh attempts.
const AUTH_ERROR_PATTERNS = [401, 403, '401', '403', 'INVALID', 'SESSION', 'EXPIRED', 'UNAUTHORIZED'];

export async function withAuthRetry<T>(fn: (client: BreezeConnect) => Promise<T>): Promise<T> {
  if (!currentApiSession) {
    const ok = await initSession();
    if (!ok) throw new Error('Breeze session not available. Update .env BREEZE_SESSION_TOKEN.');
  }
  const client = getBreezeClient();
  try {
    return await Promise.race([
      fn(client),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Breeze SDK call timeout')), 10_000)),
    ]);
  } catch (err: any) {
    const msg = String(err?.message || err?.status || err || '');
    if (msg.includes('timeout')) throw err;
    const isAuthErr = AUTH_ERROR_PATTERNS.some(p => msg.toUpperCase().includes(String(p).toUpperCase()));
    if (isAuthErr) {
      console.warn('[Breeze Auth] Auth error detected, re-initializing session...');
      // Reset state
      currentApiSession = null;
      breezeClient = null;
      sessionState.status = "EXPIRED";
      sessionState.authenticated = false;

      // Use shared refresh lock
      const ok = await initSession();
      if (!ok) throw new Error('Breeze session expired and re-init failed. Update .env BREEZE_SESSION_TOKEN.');

      // Retry original request ONCE
      return await Promise.race([
        fn(getBreezeClient()),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Breeze SDK call timeout')), 10_000)),
      ]);
    }
    throw err;
  }
}
