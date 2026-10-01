import crypto from "crypto";

/*
 * Motilal Oswal (MO) API Client - Minimal Version
 * Connects to MO API for live trading
 */

// Config from .env
const MOTILAL_API_KEY = process.env.MOTILAL_API_KEY || '';
const MOTILAL_SECRET_KEY = process.env.MOTILAL_SECRET_KEY || '';
const MOTILAL_USERID = process.env.MOTILAL_USERID || '';
const MOTILAL_PASSWORD = process.env.MOTILAL_PASSWORD || '';
const MOTILAL_DOB = process.env.MOTILAL_DOB || '';

// Session state
let sessionToken: string | null = null;
let accessToken: string | null = null;
let sessionExpiry: number = 0;
let isVerified: boolean = false;

// Simple TOTP generation (same as motilal/auth.ts)
function generateTOTP(secret: string): string {
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / 30);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.toUpperCase()) {
    const val = chars.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  const counterBytes: number[] = [];
  let tmp = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = tmp & 0xff;
    tmp = Math.floor(tmp / 256);
  }
  const key = Buffer.from(bytes);
  const data = Buffer.from(counterBytes);
  const hmacResult = crypto.createHmac('sha1', key).update(data).digest();
  const offset = hmacResult[hmacResult.length - 1] & 0x0f;
  const code =
    ((hmacResult[offset] & 0x7f) << 24) |
    ((hmacResult[offset + 1] & 0xff) << 16) |
    ((hmacResult[offset + 2] & 0xff) << 8) |
    (hmacResult[offset + 3] & 0xff);
  return (code % 1000000).toString().padStart(6, '0');
}

// Headers
function getHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: sessionToken || '',
    apikey: MOTILAL_API_KEY,
    apisecretkey: MOTILAL_SECRET_KEY,
    clientlocalip: '192.168.1.1',
    clientpublicip: '192.168.1.1',
    macaddress: 'AA:BB:CC:DD:EE:FF',
    sourceid: 'WEB',
    vendorinfo: 'ETHN366887',
    osname: 'Ubuntu 20.04',
    osversion: '20.04',
    installedappid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    devicemodel: 'VMware Virtual Platform',
    manufacturer: 'unknown',
    productname: 'Investor',
    productversion: '1',
    browsername: 'Chrome',
    browserversion: '120.0',
    sdkversion: 'Node 1.0',
    latitude: '19.0760',
    longitude: '72.8777',
    accesstoken: accessToken || '',
  };
}

// Login with OTP
export async function login(userid: string, password: string, dob: string) {
  const hashedPassword = Buffer.from(
    crypto.createHash('sha256').update(password + MOTILAL_API_KEY).digest('hex'),
    'hex'
  ).toString('hex');
  
  const response = await fetch(
    'https://openapi.motilaloswal.com/rest/login/v7/authdirectapi',
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ userid, password: hashedPassword, '2FA': dob }),
    }
  );
  
  const data = await response.json();
  
  if (data.status === 'SUCCESS' && data.AuthToken) {
    sessionToken = data.AuthToken;
    sessionExpiry = Date.now() + 24 * 60 * 60 * 1000;
    isVerified = data.isAuthTokenVerified === 'TRUE';
    if (isVerified) {
      // Get access token
      const tokenResp = await fetch(
        'https://openapi.motilaloswal.com/rest/login/v1/getaccesstoken',
        {
          method: 'POST',
          headers: getHeaders(),
        }
      );
      const tokenData = await tokenResp.json();
      if (tokenData.status === 'SUCCESS' && tokenData.accesstoken) {
        accessToken = tokenData.accesstoken;
      }
    }
    return { success: true, token: sessionToken };
  }
  return { success: false, error: data.message || 'Login failed' };
}

// Verify OTP
export async function verifyOTP(otp: string) {
  if (!sessionToken) return { success: false, error: 'Not logged in' };
  
  const response = await fetch(
    'https://openapi.motilaloswal.com/rest/login/v5/verifyotp',
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ otp }),
    }
  );
  
  const data = await response.json();
  
  if (data.status === 'SUCCESS') {
    isVerified = true;
    const tokenResp = await fetch(
      'https://openapi.motilaloswal.com/rest/login/v1/getaccesstoken',
      {
        method: 'POST',
        headers: getHeaders(),
      }
    );
    const tokenData = await tokenResp.json();
    if (tokenData.status === 'SUCCESS' && tokenData.accesstoken) {
      accessToken = tokenData.accesstoken;
    }
    return { success: true };
  }
  return { success: false, error: data.message };
}

// Get quote
export async function getQuote(instrumentToken: number) {
  if (!sessionToken) throw new Error('Not logged in');
  
  const response = await fetch(
    `https://openapi.motilaloswal.com/rest/api/v1/market/quote?instrument_token=${instrumentToken}`,
    {
      method: 'GET',
      headers: getHeaders(),
    }
  );
  
  const data = await response.json();
  return data;
}

// Place order
export async function placeOrder(order: any) {
  if (!sessionToken) throw new Error('Not logged in');
  
  const response = await fetch(
    'https://openapi.motilaloswal.com/rest/api/v1/order/place',
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(order),
    }
  );
  
  const data = await response.json();
  return data;
}

// Get positions
export async function getPositions() {
  if (!sessionToken) throw new Error('Not logged in');
  
  const response = await fetch(
    'https://openapi.motilaloswal.com/rest/api/v1/portfolio/positions',
    {
      method: 'GET',
      headers: getHeaders(),
    }
  );
  
  const data = await response.json();
  return data;
}