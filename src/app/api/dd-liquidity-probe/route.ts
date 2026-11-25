import { NextResponse } from "next/server";
import { getOptionChain } from "@/lib/icici-breeze/option-chain";
import { evaluateLegLiquidity } from "@/lib/DailyDerivatives";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const symbol = (new URL(req.url).searchParams.get("symbol") || "NIFTY").toUpperCase();
  try {
    const { getSessionState } = await import("@/lib/icici-breeze/auth");
    const session = getSessionState();

    // Raw SDK probe — what does Breeze publish for the options book?
    let raw: any = null;
    try {
      const { getBreezeClient } = await import("@/lib/icici-breeze/auth");
      const breeze = getBreezeClient();
      const r: any = await breeze.getOptionChainQuotes({
        stockCode: symbol === "SENSEX" ? "BSESEN" : "NIFTY",
        exchangeCode: symbol === "SENSEX" ? "BFO" : "NFO",
        productType: "options",
        expiryDate: "01-Dec-2026",
        right: "call",
      });
      raw = {
        Status: r?.Status,
        Error: r?.Error,
        Message: r?.Message,
        n: Array.isArray(r?.Success) ? r.Success.length : -1,
        sample: Array.isArray(r?.Success) && r.Success.length
          ? {
              strike: r.Success[0].strike_price,
              ltp: r.Success[0].ltp,
              best_bid_price: r.Success[0].best_bid_price,
              best_offer_price: r.Success[0].best_offer_price,
            }
          : null,
      };
    } catch (e: any) {
      raw = { threw: String(e?.message ?? e) };
    }

    const chain: any = await getOptionChain(symbol);
    if (!chain) return NextResponse.json({ ok: false, error: "no chain", session, raw });
    const leg = (q: any) => {
      const l = evaluateLegLiquidity(q.bid, q.ask);
      return {
        strike: q.strikePrice,
        ltp: q.ltp,
        bid: q.bid,
        ask: q.ask,
        state: l.state,
        spreadPct: l.spreadPct,
      };
    };
    const near = (arr: any[]) =>
      arr.filter((q) => Math.abs(q.strikePrice - chain.atmStrike) <= 500).map(leg);
    const summary = (arr: any[]) => {
      const states: Record<string, number> = {};
      const spreads: number[] = [];
      for (const x of arr) {
        const l = evaluateLegLiquidity(x.bid, x.ask);
        states[l.state] = (states[l.state] || 0) + 1;
        if (l.spreadPct != null) spreads.push(l.spreadPct);
      }
      spreads.sort((a, b) => a - b);
      return {
        total: arr.length,
        states,
        median: spreads.length ? spreads[Math.floor(spreads.length / 2)] : null,
        max: spreads.length ? spreads[spreads.length - 1] : null,
        over8: spreads.filter((s) => s > 8).length,
      };
    };
    return NextResponse.json({
      ok: true,
      symbol,
      session,
      expiry: chain.expiryDate,
      spot: chain.spotPrice,
      atm: chain.atmStrike,
      calls: { near: near(chain.calls || []), summary: summary(chain.calls || []) },
      puts: { near: near(chain.puts || []), summary: summary(chain.puts || []) },
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 },
    );
  }
}
