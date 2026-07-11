import { NextResponse } from "next/server";
import { pollUpdates, setWebhook, getWebhookInfo, deleteWebhook } from "@/lib/telegram-bot";

export async function GET() {
  try {
    const processed = await pollUpdates();
    return NextResponse.json({ success: true, processed });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { action } = body;

    if (action === "set_webhook") {
      const url = body.url;
      if (!url) return NextResponse.json({ success: false, error: "url required" }, { status: 400 });
      const ok = await setWebhook(url);
      const info = await getWebhookInfo();
      return NextResponse.json({ success: ok, info });
    }

    if (action === "webhook_info") {
      const info = await getWebhookInfo();
      return NextResponse.json({ success: true, info });
    }

    if (action === "delete_webhook") {
      const ok = await deleteWebhook();
      return NextResponse.json({ success: ok });
    }

    return NextResponse.json({ success: false, error: "unknown action" }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
