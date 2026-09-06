// Server-side encryption for broker credentials
// AES-256-GCM — credentials never exposed to frontend

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    // Auto-generate on first use (stored in env for persistence)
    const gen = randomBytes(KEY_LENGTH).toString("hex");
    console.warn("[Crypto] ENCRYPTION_KEY not set. Generated:", gen);
    return Buffer.from(gen, "hex");
  }
  const buf = Buffer.from(key, "hex");
  if (buf.length !== KEY_LENGTH) {
    throw new Error(`ENCRYPTION_KEY must be ${KEY_LENGTH * 2} hex chars`);
  }
  return buf;
}

export interface EncryptedData {
  encrypted: string;
  iv: string;
  tag: string;
}

export function encrypt(plaintext: string): EncryptedData {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const tag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
  };
}

export function decrypt(data: EncryptedData): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(data.iv, "hex");
  const tag = Buffer.from(data.tag, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(data.encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

export function encryptCredentials<T extends Record<string, any>>(creds: T): EncryptedData {
  return encrypt(JSON.stringify(creds));
}

export function decryptCredentials<T extends Record<string, any>>(data: EncryptedData): T {
  return JSON.parse(decrypt(data)) as T;
}

export function maskValue(val: string, showChars: number = 4): string {
  if (!val) return "";
  if (val.length <= showChars) return "•".repeat(val.length);
  return "•".repeat(val.length - showChars) + val.slice(-showChars);
}
