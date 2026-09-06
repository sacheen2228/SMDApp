// Broker configuration API — encrypted credential storage
// POST: save credentials (encrypted), connect, disconnect
// GET: status only (never exposes secrets)

import { NextRequest, NextResponse } from "next/server";
import { encryptCredentials, decryptCredentials, maskValue } from "@/lib/encryption";
import { brokerSessionManager } from "@/lib/broker-session-manager";

interface BrokerCredentials {
  apiKey?: string;
  secretKey?: string;
  username?: string;
  password?: string;
  sessionToken?: string;
  dob?: string;
  vendorId?: string;
 totpKey?: string;
}

// In-memory store (survives until server restart; for SQLite persistence use BrokerConfig model)
const brokerConfigs = new Map<string, {
  encrypted: string;
  iv: string;
  tag: string;
  status: string;
  lastConnectedAt?: Date;
  lastError?: string;
}>();

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const broker = url.searchParams.get("broker") || "ICICI_BREEZE";

  const config = brokerConfigs.get(broker);
  const sessionState = brokerSessionManager.getState(broker);

  if (!config) {
    return NextResponse.json({
      broker,
      configured: false,
      status: "NOT_CONFIGURED",
      connectionState: "NOT_CONFIGURED",
    });
  }

  // Decrypt to check validity but NEVER return secrets
  let credentialsValid = false;
  let maskedCredentials: Record<string, string> = {};
  try {
    const creds = decryptCredentials<BrokerCredentials>({
      encrypted: config.encrypted,
      iv: config.iv,
      tag: config.tag,
    });
    credentialsValid = true;
    if (creds.apiKey) maskedCredentials.apiKey = maskValue(creds.apiKey);
    if (creds.secretKey) maskedCredentials.secretKey = maskValue(creds.secretKey);
    if (creds.username) maskedCredentials.username = maskValue(creds.username);
  } catch {
    credentialsValid = false;
  }

  return NextResponse.json({
    broker,
    configured: true,
    credentialsValid,
    maskedCredentials,
    status: config.status,
    connectionState: sessionState?.state || config.status,
    lastConnectedAt: config.lastConnectedAt?.toISOString() || null,
    lastError: config.lastError || null,
    sessionState: sessionState || null,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, broker, credentials } = body;

    if (!broker) {
      return NextResponse.json({ error: "broker required" }, { status: 400 });
    }

    switch (action) {
      case "save-credentials": {
        if (!credentials || typeof credentials !== "object") {
          return NextResponse.json({ error: "credentials object required" }, { status: 400 });
        }

        const encrypted = encryptCredentials(credentials);
        brokerConfigs.set(broker, {
          encrypted: encrypted.encrypted,
          iv: encrypted.iv,
          tag: encrypted.tag,
          status: "CONFIGURED",
        });

        // Also persist to disk
        const { writeFileSync, mkdirSync } = await import("fs");
        const { join } = await import("path");
        const configDir = join(process.cwd(), "data", "broker");
        try { mkdirSync(configDir, { recursive: true }); } catch {}
        writeFileSync(join(configDir, `${broker}.json`), JSON.stringify({
          encrypted: encrypted.encrypted,
          iv: encrypted.iv,
          tag: encrypted.tag,
          status: "CONFIGURED",
        }, null, 2));

        return NextResponse.json({
          success: true,
          broker,
          status: "CONFIGURED",
          message: "Credentials encrypted and saved",
        });
      }

      case "connect": {
        const config = brokerConfigs.get(broker);
        if (!config) {
          return NextResponse.json({ error: "No credentials configured" }, { status: 400 });
        }

        const creds = decryptCredentials<BrokerCredentials>({
          encrypted: config.encrypted,
          iv: config.iv,
          tag: config.tag,
        });

        const result = await brokerSessionManager.connect(broker, creds);

        if (result.success) {
          config.status = "CONNECTED";
          config.lastConnectedAt = new Date();
          config.lastError = undefined;
        } else {
          config.status = "AUTH_ERROR";
          config.lastError = result.error;
        }

        return NextResponse.json({
          success: result.success,
          broker,
          status: config.status,
          error: result.error,
        });
      }

      case "disconnect": {
        await brokerSessionManager.disconnect(broker);
        const config = brokerConfigs.get(broker);
        if (config) {
          config.status = "DISCONNECTED";
        }
        return NextResponse.json({ success: true, broker, status: "DISCONNECTED" });
      }

      case "test-connection": {
        const config = brokerConfigs.get(broker);
        if (!config) {
          return NextResponse.json({ error: "No credentials configured" }, { status: 400 });
        }

        const creds = decryptCredentials<BrokerCredentials>({
          encrypted: config.encrypted,
          iv: config.iv,
          tag: config.tag,
        });

        const result = await brokerSessionManager.testConnection(broker, creds);
        return NextResponse.json({
          success: result.success,
          broker,
          latencyMs: result.latencyMs,
          error: result.error,
        });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
