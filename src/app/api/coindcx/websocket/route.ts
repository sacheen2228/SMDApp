import { NextResponse } from 'next/server';

const COINDCX_WS_URL = 'wss://stream.coindcx.com';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const channels = searchParams.get('channels')?.split(',') || ['ticker'];
    const markets = searchParams.get('markets')?.split(',') || ['BTCUSDT', 'ETHUSDT'];

    const wsInfo = {
      url: COINDCX_WS_URL,
      channels,
      markets,
      subscribeMessage: {
        event: 'subscribe',
        channel: channels.join(','),
        markets: markets.join(','),
      },
      exampleMessages: {
        ticker: {
          event: 'subscribe',
          channel: 'ticker',
          markets: 'BTCUSDT,ETHUSDT',
        },
        orderbook: {
          event: 'subscribe',
          channel: 'orderbook',
          markets: 'BTCUSDT',
        },
        trades: {
          event: 'subscribe',
          channel: 'trades',
          markets: 'BTCUSDT',
        },
        candles: {
          event: 'subscribe',
          channel: 'candles_1m',
          markets: 'BTCUSDT',
        },
        position: {
          event: 'subscribe',
          channel: 'position',
          markets: 'BTCUSDT',
        },
        order: {
          event: 'subscribe',
          channel: 'order',
        },
        balance: {
          event: 'subscribe',
          channel: 'balance',
        },
      },
    };

    return NextResponse.json({ success: true, data: wsInfo });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}