// Client for the Market Recorder API (mirrors trade-audit-client.ts).
const BASE = process.env.NEXT_PUBLIC_MARKET_RECORDER_URL ?? "";

async function getJson(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Market Recorder request failed: ${res.status}`);
  return res.json();
}

export async function recordNow(symbols?: string[]) {
  const res = await fetch(`${BASE}/api/market-recorder/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(symbols ? { symbols } : {}),
  });
  if (!res.ok) throw new Error(`record failed: ${res.status}`);
  return res.json();
}

export async function getSnapshots(symbol: string, date?: string) {
  const q = new URLSearchParams({ symbol });
  if (date) q.set("date", date);
  return getJson(`${BASE}/api/market-recorder/snapshots?${q.toString()}`);
}
