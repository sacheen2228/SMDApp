import { NextResponse } from "next/server";
import { generateTradePlan, formatMasterBotPlanMessage } from "@/lib/master-bot-engine";
import { sendTelegramMessage } from "@/lib/telegram";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await generateTradePlan();

    // Format Telegram alert
    if (result.plan.length > 0) {
      const p = result.plan[0];
      const msg = formatMasterBotPlanMessage(p);

      await sendTelegramMessage(msg);
    }

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("Master Bot error:", err);
    return NextResponse.json(
      { error: err.message || "Failed to generate trade plan" },
      { status: 500 }
    );
  }
}
