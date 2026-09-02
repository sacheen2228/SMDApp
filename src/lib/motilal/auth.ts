import { createHash, createHmac } from "crypto";

// ── Motilal Oswal API Configuration ──
export const MOTILAL_CONFIG = {
  API_KEY: process.env.MOTILAL_API_KEY || "",
  SECRET_KEY: process.env.MOTILAL_SECRET_KEY || "",
  TOTP_KEY: process.env.MOTILAL_TOTP_KEY || "",
  PRIMARY_IP: process.env.MOTILAL_PRIMARY_IP || "49.36.8.203",
  SECONDARY_IP: process.env.MOTILAL_SECONDARY_IP || "192.168.31.214",
  BASE_URL: "https://openapi.motilaloswal.com",
  WS_URL: "wss://openapi.motilaloswal.com/ws",
};

// ── Session state ──
let sessionToken: string | null = null;
let accessToken: string | null = null;
let sessionExpiry: number = 0;

// ── SHA-256 hash (Motilal requires SHA-256(password + apiKey)) ──
function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

// ── Generate TOTP code (30-second interval) ──
function generateTOTP(secret: string): string {
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / 30);

  // Base32 decode
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.toUpperCase()) {
    const val = chars.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }

  // Convert to bytes
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }

  // Counter as 8-byte big-endian
  const counterBytes: number[] = [];
  let tmp = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = tmp & 0xff;
    tmp = Math.floor(tmp / 256);
  }

  // HMAC-SHA1
  const key = Buffer.from(bytes);
  const data = Buffer.from(counterBytes);
  const hmacResult = createHmac("sha1", key).update(data).digest();

  const offset = hmacResult[hmacResult.length - 1] & 0x0f;
  const code =
    ((hmacResult[offset] & 0x7f) << 24) |
    ((hmacResult[offset + 1] & 0xff) << 16) |
    ((hmacResult[offset + 2] & 0xff) << 8) |
    (hmacResult[offset + 3] & 0xff);

  return (code % 1000000).toString().padStart(6, "0");
}

// ── Common headers for all API calls ──
function getHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: sessionToken || "",
    "User-Agent": "MOSL/V.1.1.0",
    apikey: MOTILAL_CONFIG.API_KEY,
    apisecretkey: MOTILAL_CONFIG.SECRET_KEY,
    macaddress: "AA:BB:CC:DD:EE:FF",
    clientlocalip: MOTILAL_CONFIG.SECONDARY_IP,
    clientpublicip: MOTILAL_CONFIG.PRIMARY_IP,
    sourceid: "WEB",
    vendorinfo: "T0000",
    osname: "Ubuntu 20.04",
    osversion: "20.04",
    installedappid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    devicemodel: "VMware Virtual Platform",
    manufacturer: "unknown",
    productname: "Investor",
    productversion: "1",
    browsername: "Chrome",
    browserversion: "120.0",
    sdkversion: "Node 1.0",
    latitude: "19.0760",
    longitude: "72.8777",
    accesstoken: accessToken || "",
  };
}

// ── Login with TOTP ──
export async function loginWithTOTP(
  userid: string,
  password: string,
  dob: string
): Promise<{ success: boolean; token?: string; error?: string }> {
  try {
    const hashedPassword = sha256(password + MOTILAL_CONFIG.API_KEY);
    const totp = generateTOTP(MOTILAL_CONFIG.TOTP_KEY);

    const response = await fetch(
      `${MOTILAL_CONFIG.BASE_URL}/rest/login/v7/authdirectapi`,
      {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          userid,
          password: hashedPassword,
          "2FA": dob,
          totp,
        }),
      }
    );

    const data = await response.json();

    if (data.status === "SUCCESS" && data.AuthToken) {
      sessionToken = data.AuthToken;
      sessionExpiry = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

      // Get access token
      const tokenResult = await getAccessToken();
      if (tokenResult.success) {
        return { success: true, token: sessionToken };
      }
      return { success: true, token: sessionToken };
    }

    return { success: false, error: data.message || "Login failed" };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// ── Get Access Token ──
async function getAccessToken(): Promise<{
  success: boolean;
  token?: string;
  error?: string;
}> {
  try {
    const response = await fetch(
      `${MOTILAL_CONFIG.BASE_URL}/rest/login/v1/getaccesstoken`,
      {
        method: "POST",
        headers: getHeaders(),
      }
    );

    const data = await response.json();

    if (data.status === "SUCCESS" && data.accesstoken) {
      accessToken = data.accesstoken;
      return { success: true, token: accessToken };
    }

    return { success: false, error: data.message };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// ── Check if session is valid ──
export function isSessionValid(): boolean {
  return sessionToken !== null && Date.now() < sessionExpiry;
}

// ── Get session token ──
export function getSessionToken(): string | null {
  return sessionToken;
}

// ── Logout ──
export async function logout(): Promise<void> {
  try {
    if (sessionToken) {
      await fetch(`${MOTILAL_CONFIG.BASE_URL}/rest/login/v5/logout`, {
        method: "POST",
        headers: getHeaders(),
      });
    }
  } catch {
    // ignore
  } finally {
    sessionToken = null;
    accessToken = null;
    sessionExpiry = 0;
  }
}

// ── Auto-login with env credentials ──
export async function autoLogin(): Promise<boolean> {
  // This requires userid, password, and dob from env or hardcoded
  // For now, return false - manual login needed
  return false;
}
