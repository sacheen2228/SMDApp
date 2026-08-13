import { createHmac } from 'crypto';

export const COINDCX_CONFIG = {
  API_KEY: process.env.COINDCX_API_KEY || '',
  API_SECRET: process.env.COINDCX_API_SECRET || '',
  BASE_URL: 'https://api.coindcx.com',
  WS_URL: 'wss://stream.coindcx.com',
  PUBLIC_URL: 'https://public.coindcx.com',
} as const;

export function generateSignature(payload: string): string {
  return createHmac('sha256', COINDCX_CONFIG.API_SECRET).update(payload).digest('hex');
}

export function createSignedPayload(payload: object): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(payload);
  const signature = generateSignature(body);
  return {
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-AUTH-APIKEY': COINDCX_CONFIG.API_KEY,
      'X-AUTH-SIGNATURE': signature,
    },
  };
}
