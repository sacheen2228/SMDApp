import { COINDCX_CONFIG, generateSignature } from './auth';

function createHeaders(payload: object = {}): Record<string, string> {
  const body = JSON.stringify(payload);
  const signature = generateSignature(body);
  return {
    'Content-Type': 'application/json',
    'X-AUTH-APIKEY': COINDCX_CONFIG.API_KEY,
    'X-AUTH-SIGNATURE': signature,
  };
}

async function request<T>(
  endpoint: string,
  options: { method?: 'GET' | 'POST'; body?: object; auth?: boolean; baseUrl?: string } = {}
): Promise<T> {
  const { method = 'POST', body = {}, auth = false, baseUrl = COINDCX_CONFIG.BASE_URL } = options;
  const headers = auth ? createHeaders(body) : { 'Content-Type': 'application/json' };

  // Handle full URLs passed in endpoint
  const url = endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint}`;

  const res = await fetch(url, {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CoinDCX ${endpoint}: ${res.status} ${text}`);
  }

  return res.json();
}

export async function getPublic<T>(endpoint: string): Promise<T> {
  return request<T>(endpoint, { method: 'GET', auth: false });
}

export async function postPublic<T>(endpoint: string, body: object): Promise<T> {
  return request<T>(endpoint, { method: 'POST', body, auth: false });
}

export async function getPrivate<T>(endpoint: string): Promise<T> {
  return request<T>(endpoint, { method: 'POST', body: {}, auth: true });
}

export async function postPrivate<T>(endpoint: string, body: object): Promise<T> {
  return request<T>(endpoint, { method: 'POST', body, auth: true });
}

export function hasCredentials(): boolean {
  return !!(COINDCX_CONFIG.API_KEY && COINDCX_CONFIG.API_SECRET);
}

export { COINDCX_CONFIG } from './auth';