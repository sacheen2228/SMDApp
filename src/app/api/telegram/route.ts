import { NextRequest, NextResponse } from "next/server";
import { sendTelegramMessage, sendTradeAlert, sendSignalAlert, sendSystemAlert, verifyTelegramBot } from "@/lib/telegram";

const API_SECRET = process.env.TELEGRAM_API_SECRET || "";

function checkApiKey(request: NextRequest): { ok: true } | { ok: false; response: NextResponse } {
  // "verify" type does not require the API key (it validates the bot token via getMe).
  // All other types require x-api-key header.
  if (!API_SECRET) {
    return { ok: false, response: NextResponse.json({ error: "Telegram API secret not configured" }, { status: 503 }) };
  }
  const provided = request.headers.get("x-api-key") || "";
  if (!provided || !timingSafeEqual(Buffer.from(provided), Buffer.from(API_SECRET))) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { ok: true };
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function requireNonEmptyString(value: unknown, field: string): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim();
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { type, ...params } = body;

    // Connection test — validates the bot token via getMe (not gated by market hours,
    // not gated by API key — it's a diagnostic endpoint).
    if (type === "verify") {
      const v = await verifyTelegramBot();
      return NextResponse.json({ success: v.ok, username: v.username, error: v.description });
    }

    // All other types require API key authentication.
    const auth = checkApiKey(request);
    if (!auth.ok) return auth.response;

    let sent = false;
    switch (type) {
      case "test": {
        // Dry-run delivery check: clearly labeled, excluded from risk caps,
        // no trade registered, no expectsTrade — proves Telegram delivery
        // without fabricating a real signal.
        sent = await sendTradeAlert({
          symbol: "NIFTY",
          action: "BUY",
          optionType: "CE",
          strike: 25400,
          entry: 236.4,
          stopLoss: 211.4,
          target1: 286.4,
          confidence: 70,
          spot: 25382,
          expiry: "2026-11-17",
          lots: 1,
          lotSize: 75,
          deployedAmount: 17730,
          riskAmount: 1875,
          source: "TEST_DRY_RUN",
          strategy: "TEST_DRY_RUN",
          instrument: "CALL",
          requireExpiry: true,
          requireSpot: true,
          expectsTrade: false,
          message: "🧪 <b>TEST DRY RUN</b> — Telegram delivery check only, not a real trade.\n\nNIFTY 25400 CE @ ₹236.4 · SL ₹211.4 · T1 ₹286.4 (R:R 1:2) · ₹17,730 deployed · ₹1,875 risk.",
        });
        break;
      }
      case "trade":
        sent = await sendTradeAlert(params);
        break;
      case "signal":
        sent = await sendSignalAlert(params);
        break;
      case "system": {
        const message = requireNonEmptyString(params.message, "message");
        if (message === null) {
          return NextResponse.json({ error: "message must be a non-empty string" }, { status: 400 });
        }
        sent = await sendSystemAlert(message);
        break;
      }
      case "message": {
        const text = requireNonEmptyString(params.text, "text");
        if (text === null) {
          return NextResponse.json({ error: "text must be a non-empty string" }, { status: 400 });
        }
        sent = await sendTelegramMessage(text, params.chatId);
        break;
      }
      default:
        return NextResponse.json({ error: "Invalid type" }, { status: 400 });
    }

    return NextResponse.json({ success: sent });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    bot: "@Sacheen_SD_Bot",
    usage: "POST with { type: 'trade'|'signal'|'system'|'message', ...params }. Requires x-api-key header (except type=verify).",
  });
}
