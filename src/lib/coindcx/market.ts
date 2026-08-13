import { getPublic, postPrivate, hasCredentials } from './client';
import { COINDCX_CONFIG } from './auth';

export interface TickerData {
  market: string;
  change_24_hour: string;
  high: string;
  low: string;
  volume: string;
  last_price: string;
  bid: string;
  ask: string;
  timestamp: number;
}

export interface MarketDetail {
  coindcx_name: string;
  base_currency_short_name: string;
  target_currency_short_name: string;
  min_quantity: number;
  max_quantity: number;
  min_price: number;
  max_price: number;
  min_notional: number;
  step: number;
  pair: string;
  ecode: string;
  status: 'active' | 'inactive';
}

export interface OrderBookData {
  timestamp: number;
  bids: Record<string, string>;
  asks: Record<string, string>;
}

export interface CandleData {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: number;
}

export interface TradeData {
  p: number;
  q: number;
  s: string;
  T: number;
  m: boolean;
}

let cachedNativeMarkets: MarketDetail[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 300_000;

export async function getAllTickers(): Promise<TickerData[]> {
  return getPublic<TickerData[]>('https://api.coindcx.com/exchange/ticker');
}

export async function getTicker(market: string): Promise<TickerData | null> {
  const all = await getAllTickers();
  return all.find(t => t.market === market) || null;
}

export async function getMarketsDetails(): Promise<MarketDetail[]> {
  return getPublic<MarketDetail[]>('https://api.coindcx.com/exchange/v1/markets_details');
}

export async function getNativeMarkets(): Promise<MarketDetail[]> {
  if (cachedNativeMarkets && Date.now() - cacheTime < CACHE_TTL) {
    return cachedNativeMarkets;
  }
  const all = await getMarketsDetails();
  cachedNativeMarkets = all.filter(m => m.ecode === 'B' && m.status === 'active');
  cacheTime = Date.now();
  return cachedNativeMarkets;
}

export async function getNativeMarketNames(): Promise<string[]> {
  const markets = await getNativeMarkets();
  return markets.map(m => m.coindcx_name);
}

export async function getNativeTickers(): Promise<TickerData[]> {
  const [tickers, names] = await Promise.all([getAllTickers(), getNativeMarketNames()]);
  const nameSet = new Set(names);
  return tickers.filter(t => nameSet.has(t.market));
}

export async function getOrderBook(pair: string): Promise<OrderBookData> {
  return getPublic<OrderBookData>(`https://public.coindcx.com/market_data/orderbook?pair=${pair}`);
}

export async function getCandles(
  pair: string,
  interval: string = '15m',
  limit: number = 100,
  endTime?: number
): Promise<CandleData[]> {
  let url = `https://public.coindcx.com/market_data/candles?pair=${pair}&interval=${interval}&limit=${limit}`;
  if (endTime) url += `&endTime=${endTime}`;
  return getPublic<CandleData[]>(url);
}

export async function getTrades(pair: string, limit: number = 50): Promise<TradeData[]> {
  return getPublic<TradeData[]>(`https://public.coindcx.com/market_data/trade_history?pair=${pair}&limit=${limit}`);
}

export async function getBalances(): Promise<Array<{ currency: string; balance: number; locked_balance: number }>> {
  if (!hasCredentials()) throw new Error('API credentials required');
  return postPrivate<Array<{ currency: string; balance: number; locked_balance: number }>>(
    '/exchange/v1/users/balances',
    { timestamp: Date.now() }
  );
}
