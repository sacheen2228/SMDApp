import { NSEClient } from 'nse-bse-api/nse';

let nseClient: NSEClient | null = null;

function getNSEClient(): NSEClient {
  if (!nseClient) {
    nseClient = new NSEClient('./downloads', { timeout: 15000 });
  }
  return nseClient;
}

export async function getNSEOptionChain(symbol: string, expiry?: string) {
  const client = getNSEClient();
  // NSE V3 expects expiry as "DD-Mon-YYYY"; accept that or ISO and normalize.
  let expiryParam = expiry;
  if (expiryParam && /^\d{4}-\d{2}-\d{2}$/.test(expiryParam)) {
    const d = new Date(expiryParam);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    expiryParam = `${d.getUTCDate().toString().padStart(2, '0')}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
  }
  try {
    // SENSEX is on BSE, try BSE type first
    const isBSE = symbol.toUpperCase() === 'SENSEX' || symbol.toUpperCase() === 'BANKEX';
    const data = await client.optionChainV3({
      symbol,
      type: isBSE ? 'BSE' : 'Indices',
      ...(expiryParam ? { expiry: expiryParam } : {}),
    });
    return data;
  } catch (err: any) {
    // Fallback: try as Indices for all
    try {
      const data = await client.optionChainV3({ symbol, type: 'Indices', ...(expiryParam ? { expiry: expiryParam } : {}) });
      return data;
    } catch (err2: any) {
      console.error('[NSE API] Option chain error:', err2.message);
      return null;
    }
  }
}

export async function getNSEMarketStatus() {
  const client = getNSEClient();
  try {
    const status = await client.market.getStatus();
    return status;
  } catch (err: any) {
    console.error('[NSE API] Market status error:', err.message);
    return null;
  }
}

export async function getNSEHistoricalData(symbol: string, from: Date, to: Date) {
  const client = getNSEClient();
  try {
    const data = await client.fetch_equity_historical_data({
      symbol,
      from_date: from.toISOString().split('T')[0],
      to_date: to.toISOString().split('T')[0],
    });
    return data;
  } catch (err: any) {
    console.error('[NSE API] Historical data error:', err.message);
    return null;
  }
}

export async function getNSEGainers() {
  const client = getNSEClient();
  try {
    const data = await client.listEquityStocksByIndex('NIFTY 50');
    const stocks = Array.isArray(data) ? data : [];
    return stocks.sort((a: any, b: any) => (b.pChange || 0) - (a.pChange || 0)).slice(0, 10);
  } catch (err: any) {
    console.error('[NSE API] Gainers error:', err.message);
    return [];
  }
}

export async function getNSELosers() {
  const client = getNSEClient();
  try {
    const data = await client.listEquityStocksByIndex('NIFTY 50');
    const stocks = Array.isArray(data) ? data : [];
    return stocks.sort((a: any, b: any) => (a.pChange || 0) - (b.pChange || 0)).slice(0, 10);
  } catch (err: any) {
    console.error('[NSE API] Losers error:', err.message);
    return [];
  }
}

export async function getNSEFnoLots() {
  const client = getNSEClient();
  try {
    return await client.fnoLots();
  } catch (err: any) {
    console.error('[NSE API] F&O lots error:', err.message);
    return {};
  }
}

export function cleanupNSE() {
  if (nseClient) {
    nseClient.exit();
    nseClient = null;
  }
}
