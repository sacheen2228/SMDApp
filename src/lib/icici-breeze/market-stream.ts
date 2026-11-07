import { EventEmitter } from 'events';
import { getBreezeClient } from './auth';

type Tick = {
  symbol: string;
  strike: number;
  optionType: 'CE' | 'PE';
  ltp: number;
  bid: number;
  ask: number;
  oi: number;
  oiChg: number;
  volume: number;
  iv?: number;
};

class BreezeMarketStream extends EventEmitter {
  private enabled = false;
  private symbols = new Set<string>();

  async connect() {
    // Breeze WebSocket initialization placeholder
    // Replace with actual Breeze SDK WebSocket connect
    this.enabled = true;
    this.emit('connected');
  }

  async subscribe(symbol: string, expiry: string, strikes: number[]) {
    // Build option symbols and subscribe via Breeze WebSocket
    // e.g., NIFTY24NOV...CE
    strikes.forEach(s => {
      const ce = `${symbol}${expiry}${s}CE`;
      const pe = `${symbol}${expiry}${s}PE`;
      this.symbols.add(ce);
      this.symbols.add(pe);
    });
    this.emit('subscribed', { symbol, strikes });
  }

  // Called by WebSocket onmessage handler
  handleTick(raw: any) {
    const tick: Tick = {
      symbol: raw.symbol,
      strike: Number(raw.strike),
      optionType: raw.optionType as 'CE' | 'PE',
      ltp: Number(raw.ltp),
      bid: Number(raw.bid),
      ask: Number(raw.ask),
      oi: Number(raw.openInterest),
      oiChg: Number(raw.oiChange),
      volume: Number(raw.volume),
      iv: Number(raw.iv),
    };
    this.emit('tick', tick);
  }

  async disconnect() {
    this.enabled = false;
    this.emit('disconnected');
  }
}

export const breezeStream = new BreezeMarketStream();
