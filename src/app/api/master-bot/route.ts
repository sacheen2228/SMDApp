import { NextResponse } from "next/server";
import { generateTradePlan } from "@/lib/masterbot-strategy";
import { sendTelegramMessage } from "@/lib/telegram";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await generateTradePlan();

    // Format Telegram alert
    if (result.plan.length > 0) {
      const p = result.plan[0];
      const msg = [
        `🎯 *MASTER BOT TRADE PLAN*`,
        ``,
        `*${p.index} ${p.direction} ${p.strike}*`,
        `Setup: ${p.setup} (${p.confidence})`,
        `Spot: ${p.spot.toFixed(0)} | Lots: ${p.lots}`,
        ``,
        `Entry Premium: ₹${p.entryPremium.toFixed(2)}`,
        `SL Premium: ₹${p.slPremium.toFixed(2)} (-${((1 - p.slPremium / p.entryPremium) * 100).toFixed(0)}%)`,
        `TP Premium: ₹${p.tpPremium.toFixed(2)} (R:R ${p.rr.toFixed(1)})`,
        ``,
        `Total Premium: ₹${p.totalPremium.toFixed(0)}`,
        `Max Risk: ₹${p.maxRisk.toFixed(0)} (${((p.maxRisk / 100000) * 100).toFixed(1)}% capital)`,
        `Exit: ${p.exitTime}`,
        ``,
        `*Reasons:*`,
        ...p.reasons.map((r) => `• ${r}`),
        ``,
        `⚠️ ${p.expiryNote || "No expiry warnings."}`,
      ].join("\n");

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
