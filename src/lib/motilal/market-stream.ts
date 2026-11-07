import { EventEmitter } from 'events';

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
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
};

class MotilalMarketStream extends EventEmitter {
  private enabled = false;

  async connect() {
    // Initialise MoAPI WebSocket / LiveFeed
    // e.g., Motilal Oswal LiveFeed SDK connect
    this.enabled = true;
    this.emit('connected');
  }

  async subscribe(symbol: string, expiry: string, strikes: number[]) {
    // Subscribe to option symbols for symbol/expiry
    this.emit('subscribed', { symbol, strikes });
  }

  handleTick(raw: any) {
    const tick: Tick = {
      symbol: raw.symbol || raw.instrument,
      strike: Number(raw.strike || raw.strikePrice),
      optionType: raw.optionType === 'CALL' || raw.optionType === 'CE' ? 'CE' : 'PE',
      ltp: Number(raw.ltp || raw.lastPrice || 0),
      bid: Number(raw.bid || 0),
      ask: Number(raw.ask || 0),
      oi: Number(raw.openInterest || raw.oi || 0),
      oiChg: Number(raw.oiChange || raw.oiChg || 0),
      volume: Number(raw.volume || raw.totalTradedQuantity || 0),
      iv: Number(raw.iv || raw.impliedVolatility || 0),
      delta: Number(raw.delta || 0),
      gamma: Number(raw.gamma || 0),
      theta: Number(raw.theta || 0),
      vega: Number(raw.vega || 0),
    };
    this.emit('tick', tick);
  }

  async disconnect() {
    this.enabled = false;
    this.emit('disconnected');
  }
}

export const motilalStream = new MotilalMarketStream();
