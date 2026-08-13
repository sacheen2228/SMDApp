import { NextResponse } from 'next/server';
import {
  getBalances,
  createOrder,
  getOrderStatus,
  getActiveOrders,
  cancelOrder,
  cancelAllOrders,
  getOrderHistory,
} from '@/lib/coindcx/futures';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'balances';
    const market = searchParams.get('market');
    const orderId = searchParams.get('orderId');
    const limit = parseInt(searchParams.get('limit') || '50');

    switch (action) {
      case 'balances':
        const balances = await getBalances();
        return NextResponse.json({ success: true, data: balances });

      case 'active_orders':
        const orders = await getActiveOrders(market || undefined);
        return NextResponse.json({ success: true, data: orders });

      case 'order':
        if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 });
        const order = await getOrderStatus(orderId);
        return NextResponse.json({ success: true, data: order });

      case 'order_history':
        if (!market) return NextResponse.json({ error: 'market required' }, { status: 400 });
        const history = await getOrderHistory(market, limit);
        return NextResponse.json({ success: true, data: history });

      default:
        return NextResponse.json({ error: 'invalid action' }, { status: 400 });
    }
  } catch (error: any) {
    console.error('[CoinDCX Trading API] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, ...params } = body;

    switch (action) {
      case 'create_order':
        if (!params.market || !params.side || !params.total_quantity) {
          return NextResponse.json({ error: 'market, side, total_quantity required' }, { status: 400 });
        }
        const order = await createOrder({
          market: params.market,
          side: params.side,
          order_type: params.order_type || 'market_order',
          total_quantity: params.total_quantity,
          price_per_unit: params.price_per_unit,
        });
        return NextResponse.json({ success: true, data: order });

      case 'cancel_order':
        if (!params.orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 });
        const cancelled = await cancelOrder(params.orderId);
        return NextResponse.json({ success: true, data: cancelled });

      case 'cancel_all':
        const cancelledAll = await cancelAllOrders(params.market);
        return NextResponse.json({ success: true, data: cancelledAll });

      default:
        return NextResponse.json({ error: 'invalid action' }, { status: 400 });
    }
  } catch (error: any) {
    console.error('[CoinDCX Trading API] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
