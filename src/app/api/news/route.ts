// News API Endpoint
// Returns market-wide sentiment + per-stock news

import { NextRequest, NextResponse } from "next/server";
import { getCachedMarketNews, fetchStockNews } from "@/lib/news-engine";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol");

    if (symbol) {
      // Fetch news for specific stock
      const articles = await fetchStockNews(symbol);
      return NextResponse.json({
        success: true,
        symbol,
        articles,
        count: articles.length,
        timestamp: new Date().toISOString(),
      });
    }

    // Fetch market-wide sentiment
    const sentiment = await getCachedMarketNews();

    return NextResponse.json({
      success: true,
      data: sentiment,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[News API] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "News fetch failed" },
      { status: 500 }
    );
  }
}
