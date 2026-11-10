import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAlertClaimStats } from "@/lib/alert-claim";

// Visibility for the atomic entry-claim funnel:
//   • counts (pending/sent/failed/unregistered)
//   • the most recent claims with their registration outcome
export async function GET() {
  try {
    const [stats, recent] = await Promise.all([
      getAlertClaimStats(),
      db.alertClaim.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          tradeDate: true,
          expiry: true,
          symbol: true,
          strike: true,
          optionType: true,
          side: true,
          strategy: true,
          status: true,
          attempts: true,
          maxAttempts: true,
          tradeId: true,
          tradeRegistered: true,
          registrationError: true,
          lastError: true,
          sentAt: true,
          createdAt: true,
        },
      }),
    ]);
    return NextResponse.json({ success: true, stats, recent });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || String(err) },
      { status: 500 },
    );
  }
}
