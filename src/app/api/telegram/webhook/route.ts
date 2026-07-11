import { NextRequest, NextResponse } from "next/server";
import { processMessage } from "@/lib/telegram-bot";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const msg = body?.message;
    if (msg?.text && msg.chat?.id) {
      await processMessage(msg.chat.id, msg.text);
    }
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
