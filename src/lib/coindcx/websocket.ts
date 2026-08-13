import { COINDCX_CONFIG } from './auth';

export type WSChannel =
  | 'ticker'
  | 'orderbook'
  | 'trades'
  | 'candles'
  | 'position'
  | 'order'
  | 'balance';

export interface WSMessage<T = unknown> {
  channel: string;
  event: 'subscribe' | 'unsubscribe' | 'update' | 'snapshot' | 'error';
  data: T;
  timestamp: number;
}

export interface WSTickerData {
  market: string;
  last_price: string;
  bid: string;
  ask: string;
  volume_24h: string;
  change_24h: string;
  high_24h: string;
  low_24h: string;
}

export interface WSOrderBookData {
  market: string;
  asks: Array<[string, string]>;
  bids: Array<[string, string]>;
  timestamp: number;
}

export interface WSTradeData {
  market: string;
  price: string;
  quantity: string;
  side: 'buy' | 'sell';
  timestamp: number;
  trade_id: string;
}

export interface WSCandleData {
  market: string;
  interval: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  timestamp: number;
}

export interface WSPositionData {
  market: string;
  side: 'long' | 'short';
  size: string;
  entry_price: string;
  mark_price: string;
  liquidation_price: string;
  unrealized_pnl: string;
  leverage: number;
}

export interface WSOrderData {
  id: string;
  client_order_id: string;
  market: string;
  side: 'buy' | 'sell';
  order_type: string;
  price: string;
  quantity: string;
  filled_quantity: string;
  status: string;
  timestamp: number;
}

export interface WSBalanceData {
  currency: string;
  available: string;
  locked: string;
  total: string;
}

type WSHandler<T> = (data: T) => void;

class CoinDCXWebSocket {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private subscriptions: Map<string, { channel: WSChannel; market: string; handlers: Set<WSHandler<unknown>> }> = new Map();
  private messageHandlers: Map<string, Set<WSHandler<unknown>>> = new Map();
  private isConnecting = false;
  private shouldReconnect = true;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      if (this.isConnecting) {
        const checkConnected = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            clearInterval(checkConnected);
            resolve();
          }
        }, 100);
        return;
      }

      this.isConnecting = true;
      this.shouldReconnect = true;

      try {
        this.ws = new WebSocket(COINDCX_CONFIG.WS_URL);

        this.ws.onopen = () => {
          console.log('[CoinDCX WS] Connected');
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.resubscribeAll();
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message: WSMessage = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (e) {
            console.error('[CoinDCX WS] Parse error:', e);
          }
        };

        this.ws.onerror = (error) => {
          console.error('[CoinDCX WS] Error:', error);
          this.isConnecting = false;
          reject(error);
        };

        this.ws.onclose = () => {
          console.log('[CoinDCX WS] Disconnected');
          this.isConnecting = false;
          if (this.shouldReconnect) {
            this.scheduleReconnect();
          }
        };
      } catch (e) {
        this.isConnecting = false;
        reject(e);
      }
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscriptions.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[CoinDCX WS] Max reconnect attempts reached');
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;
    console.log(`[CoinDCX WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch(console.error);
    }, delay);
  }

  private resubscribeAll(): void {
    for (const [key, sub] of this.subscriptions) {
      this.sendSubscribe(sub.channel, sub.market);
    }
  }

  private sendSubscribe(channel: WSChannel, market: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const payload = {
        channel,
        market,
        event: 'subscribe',
      };
      this.ws.send(JSON.stringify(payload));
    }
  }

  private sendUnsubscribe(channel: WSChannel, market: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const payload = {
        channel,
        market,
        event: 'unsubscribe',
      };
      this.ws.send(JSON.stringify(payload));
    }
  }

  private handleMessage(message: WSMessage): void {
    const key = `${message.channel}:${message.data?.market || 'global'}`;
    const handlers = this.messageHandlers.get(key);
    if (handlers) {
      handlers.forEach(h => h(message.data));
    }
  }

  subscribe<T>(channel: WSChannel, market: string, handler: WSHandler<T>): () => void {
    const key = `${channel}:${market}`;

    if (!this.messageHandlers.has(key)) {
      this.messageHandlers.set(key, new Set());
    }
    this.messageHandlers.get(key)!.add(handler as WSHandler<unknown>);

    if (!this.subscriptions.has(key)) {
      this.subscriptions.set(key, { channel, market, handlers: new Set() });
      this.sendSubscribe(channel, market);
    }

    return () => this.unsubscribe(channel, market, handler);
  }

  unsubscribe(channel: WSChannel, market: string, handler?: WSHandler<unknown>): void {
    const key = `${channel}:${market}`;

    if (handler) {
      const handlers = this.messageHandlers.get(key);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.messageHandlers.delete(key);
        }
      }
    } else {
      this.messageHandlers.delete(key);
    }

    const sub = this.subscriptions.get(key);
    if (sub && (!handler || this.messageHandlers.get(key)?.size === 0)) {
      this.subscriptions.delete(key);
      this.sendUnsubscribe(channel, market);
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getState(): WebSocket['readyState'] | null {
    return this.ws?.readyState ?? null;
  }
}

export const wsClient = new CoinDCXWebSocket();

export async function initWebSocket(): Promise<void> {
  await wsClient.connect();
}

export function subscribeTicker(market: string, handler: (data: WSTickerData) => void): () => void {
  return wsClient.subscribe('ticker', market, handler);
}

export function subscribeOrderBook(market: string, handler: (data: WSOrderBookData) => void): () => void {
  return wsClient.subscribe('orderbook', market, handler);
}

export function subscribeTrades(market: string, handler: (data: WSTradeData) => void): () => void {
  return wsClient.subscribe('trades', market, handler);
}

export function subscribeCandles(market: string, interval: string, handler: (data: WSCandleData) => void): () => void {
  return wsClient.subscribe(`candles_${interval}`, market, handler);
}

export function subscribePosition(market: string, handler: (data: WSPositionData) => void): () => void {
  return wsClient.subscribe('position', market, handler);
}

export function subscribeOrders(handler: (data: WSOrderData) => void): () => void {
  return wsClient.subscribe('order', 'all', handler);
}

export function subscribeBalances(handler: (data: WSBalanceData) => void): () => void {
  return wsClient.subscribe('balance', 'all', handler);
}