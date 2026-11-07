import { NextRequest } from 'next/server';
import { fetchLiveOptionChain } from '@/lib/live-option-chain';
import { runDynamicOptionsEngine, validateOptionChainData } from '@/lib/dynamic-options-engine';
import { breezeStream } from '@/lib/icici-breeze/market-stream';
import { motilalStream } from '@/lib/motilal/market-stream';

export const dynamic = 'force-dynamic';

type ChainStore = {
  symbol: string;
  spot: number;
  strikes: Map<number, { ce: any; pe: any }>;
};

const store = new Map<string, ChainStore>();

function buildInput(symbol: string, cs: ChainStore) {
  const strikes = Array.from(cs.strikes.entries()).map(([strike, legs]) => ({
    strike,
    ce: legs.ce || { ltp:0,bid:0,ask:0,oi:0,oiChg:0,volume:0,iv:0,delta:0,gamma:0,theta:0,vega:0 },
    pe: legs.pe || { ltp:0,bid:0,ask:0,oi:0,oiChg:0,volume:0,iv:0,delta:0,gamma:0,theta:0,vega:0 },
  }));
  return {
    symbol,
    spot: cs.spot,
    vix: 15,
    pcr: 1,
    maxPain: cs.spot,
    atmStrike: strikes.reduce((p,c)=>Math.abs(c.strike-cs.spot)<Math.abs(p.strike-cs.spot)?c:p, strikes[0]).strike,
    strikes,
    totalCallOI: strikes.reduce((a,s)=>a+(s.ce?.oi||0),0),
    totalPutOI: strikes.reduce((a,s)=>a+(s.pe?.oi||0),0),
    callOiChg: strikes.reduce((a,s)=>a+(s.ce?.oiChg||0),0),
    putOiChg: strikes.reduce((a,s)=>a+(s.pe?.oiChg||0),0),
    lotSize: symbol==='SENSEX'?15:50,
  };
}

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get('symbol') || 'NIFTY';
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: any) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
      };

      // Initialise store with REST snapshot
      const chainResult = await fetchLiveOptionChain(symbol);
      if (chainResult.success && chainResult.data) {
        const cs: ChainStore = { symbol, spot: chainResult.data.summary.spotPrice || 0, strikes: new Map() };
        (chainResult.data.data||[]).forEach((r:any)=>{
          cs.strikes.set(r.strike,{ ce:r.ce||{}, pe:r.pe||{} });
        });
        store.set(symbol, cs);
      }

      const cs = store.get(symbol) || { symbol, spot:0, strikes:new Map() };

      // Send initial snapshot
      try {
        const input = buildInput(symbol, cs);
        const validation = validateOptionChainData(input);
        if (validation.valid) {
          const result = runDynamicOptionsEngine(input);
          send({ type:'update', timestamp:new Date().toISOString(), data: result });
        } else {
          send({ type:'validation', valid:false, errors:validation.errors, warnings:validation.warnings });
        }
      } catch {}

      // Subscribe to Breeze ticks
      const onTick = (tick:any) => {
        const s = store.get(symbol);
        if (!s) return;
        const strike = Number(tick.strike);
        if (!s.strikes.has(strike)) s.strikes.set(strike,{ ce:{}, pe:{} });
        const legs = s.strikes.get(strike)!;
        const leg = tick.optionType==='CE' ? legs.ce : legs.pe;
        leg.ltp = tick.ltp;
        leg.bid = tick.bid;
        leg.ask = tick.ask;
        leg.oi = tick.oi;
        leg.oiChg = tick.oiChg;
        leg.volume = tick.volume;
        if (tick.iv) leg.iv = tick.iv;
        if (tick.delta) leg.delta = tick.delta;
        if (tick.gamma) leg.gamma = tick.gamma;
        if (tick.theta) leg.theta = tick.theta;
        if (tick.vega) leg.vega = tick.vega;

        // Rebuild and push update
        try {
          const input = buildInput(symbol, s);
          const validation = validateOptionChainData(input);
          if (validation.valid) {
            const result = runDynamicOptionsEngine(input);
            send({ type:'update', timestamp:new Date().toISOString(), data: result });
          }
        } catch {}
      };

      breezeStream.on('tick', onTick);
      motilalStream.on('tick', onTick);
      // @ts-ignore
      req.signal?.addEventListener?.('abort', () => {
        breezeStream.off('tick', onTick);
        motilalStream.off('tick', onTick);
      });
    },
    cancel() {}
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
