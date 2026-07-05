import { NextRequest, NextResponse } from "next/server";
import { runCorrelationAnalysis } from "@/lib/correlation-engine";
import { sendTelegramMessage } from "@/lib/telegram";

export async function GET(request: NextRequest) {
  try {
    const result = await runCorrelationAnalysis();

    // Send Telegram alert for TRADE signals
    if (result.signal === "TRADE") {
      const emoji = "📊";
      const msg = `
${emoji} <b>Nifty-Sensex Correlation Signal</b>

🚦 Signal: <b>${result.signal}</b>
📈 Nifty: <b>${result.niftyPrice.toLocaleString("en-IN")}</b>
📉 Sensex: <b>${result.sensexPrice.toLocaleString("en-IN")}</b>

🔗 Correlation:
  Overall: ${result.overallCorrelation.toFixed(4)}
  5-day: ${result.last5dCorrelation.toFixed(4)}
  20-day: ${result.last20dCorrelation.toFixed(4)}

📐 Beta: ${result.beta.toFixed(3)}
📏 Today gap: ${result.todayReturnDiff.toFixed(3)}%

💡 <b>${result.action}</b>
📝 ${result.reason}

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
      `.trim();
      sendTelegramMessage(msg).catch(() => {});
    }

    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    console.error("[API] Correlation error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Correlation analysis failed" },
      { status: 500 }
    );
  }
}
