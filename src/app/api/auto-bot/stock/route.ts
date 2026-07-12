import { NextRequest, NextResponse } from "next/server";
import { getBreezeClient, initSession } from "@/lib/icici-breeze/auth";

interface Candle {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function nseSymbol(ticker: string): string {
  return ticker.replace(".NS", "");
}

export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get("ticker") || "";
  if (!ticker) return NextResponse.json({ error: "Missing ticker" }, { status: 400 });

  const sym = nseSymbol(ticker);
  const isIndian = ticker.endsWith(".NS");
  const result: { daily: Candle[]; hourly: Candle[]; price: number | null } = {
    daily: [],
    hourly: [],
    price: null,
  };

  // Live quote via Breeze for Indian stocks
  if (isIndian) {
    try {
      await initSession();
      const breeze = getBreezeClient();
      const quote = await breeze.getQuotes({ stockCode: sym, exchangeCode: "NSE" });
      if (quote?.Success?.[0]) {
        result.price = Number(quote.Success[0].ltp) || null;
      }
    } catch {
      // fall through
    }
  }

  return NextResponse.json(result);
}
