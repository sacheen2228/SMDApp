import { NextRequest, NextResponse } from "next/server";
import { sendTelegramMessage, sendTradeAlert, sendSignalAlert, sendSystemAlert } from "@/lib/telegram";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { type, ...params } = body;

    let sent = false;
    switch (type) {
      case "trade":
        sent = await sendTradeAlert(params);
        break;
      case "signal":
        sent = await sendSignalAlert(params);
        break;
      case "system":
        sent = await sendSystemAlert(params.message);
        break;
      case "message":
        sent = await sendTelegramMessage(params.text, params.chatId);
        break;
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
    usage: "POST with { type: 'trade'|'signal'|'system'|'message', ...params }",
  });
}
