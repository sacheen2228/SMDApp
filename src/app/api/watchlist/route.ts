import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

interface WatchlistItem {
  symbol: string;
  name: string;
  sector: string;
  addedAt: number;
  notes?: string;
}

const DATA_DIR = path.join(process.cwd(), "data");
const WATCHLIST_FILE = path.join(DATA_DIR, "watchlist.json");

const DEFAULT_WATCHLIST: WatchlistItem[] = [
  { symbol: "NIFTY", name: "NIFTY 50", sector: "Index", addedAt: Date.now() },
  { symbol: "BANKNIFTY", name: "NIFTY Bank", sector: "Index", addedAt: Date.now() },
  { symbol: "RELIANCE", name: "Reliance", sector: "Energy", addedAt: Date.now() },
  { symbol: "HDFCBANK", name: "HDFC Bank", sector: "Banking", addedAt: Date.now() },
  { symbol: "INFY", name: "Infosys", sector: "IT", addedAt: Date.now() },
  { symbol: "TCS", name: "TCS", sector: "IT", addedAt: Date.now() },
  { symbol: "ICICIBANK", name: "ICICI Bank", sector: "Banking", addedAt: Date.now() },
  { symbol: "HDFC", name: "HDFC", sector: "Finance", addedAt: Date.now() },
  { symbol: "SBIN", name: "SBI", sector: "Banking", addedAt: Date.now() },
  { symbol: "BHARTIARTL", name: "Bharti Airtel", sector: "Telecom", addedAt: Date.now() },
];

function loadWatchlist(): WatchlistItem[] {
  try {
    if (fs.existsSync(WATCHLIST_FILE)) {
      const raw = fs.readFileSync(WATCHLIST_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return [...DEFAULT_WATCHLIST];
}

function saveWatchlist(items: WatchlistItem[]): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(items, null, 2), "utf-8");
}

export async function GET() {
  try {
    const items = loadWatchlist();
    return NextResponse.json({ items });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to load watchlist" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { symbol, name, sector } = body;

    if (!symbol) {
      return NextResponse.json({ error: "symbol is required" }, { status: 400 });
    }

    const items = loadWatchlist();
    const exists = items.find((i) => i.symbol === symbol.toUpperCase());
    if (exists) {
      return NextResponse.json({ error: `${symbol} already in watchlist` }, { status: 409 });
    }

    items.push({
      symbol: symbol.toUpperCase(),
      name: name || symbol.toUpperCase(),
      sector: sector || "Other",
      addedAt: Date.now(),
    });

    saveWatchlist(items);
    return NextResponse.json({ items });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to add to watchlist" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get("symbol");

    if (!symbol) {
      return NextResponse.json({ error: "symbol query param is required" }, { status: 400 });
    }

    const items = loadWatchlist();
    const filtered = items.filter((i) => i.symbol !== symbol.toUpperCase());

    if (filtered.length === items.length) {
      return NextResponse.json({ error: `${symbol} not found in watchlist` }, { status: 404 });
    }

    saveWatchlist(filtered);
    return NextResponse.json({ items: filtered });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to remove from watchlist" }, { status: 500 });
  }
}
