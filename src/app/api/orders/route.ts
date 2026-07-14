// API Route - Orders
// Place, get, modify, cancel orders via ICICI Breeze

import { NextRequest, NextResponse } from 'next/server';
import { placeOrder, getOrderList, cancelOrder, modifyOrder } from '@/lib/icici-breeze/orders';
import type { OrderRequest } from '@/types';

// ─── GET: Get all orders ──────────────────────────────────────────
export async function GET() {
  try {
    const orders = await getOrderList();

    return NextResponse.json({
      success: true,
      data: orders,
    });
  } catch (error: any) {
    // Breeze auth / session failure should not crash the tab — degrade gracefully.
    console.warn('[API] Get orders degraded (Breeze unavailable):', error?.message);
    return NextResponse.json({
      success: true,
      degraded: true,
      data: [],
      message: 'Breeze not authenticated — live orders unavailable',
    });
  }
}

// ─── POST: Place new order ────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    const orderRequest: OrderRequest = {
      stockCode: body.stockCode,
      exchangeCode: body.exchangeCode || 'NFO',
      product: body.product || 'options',
      action: body.action,
      orderType: body.orderType || 'limit',
      quantity: String(body.quantity),
      price: String(body.price),
      validity: body.validity || 'day',
      stoploss: body.stoploss,
      expiryDate: body.expiryDate,
      right: body.right,
      strikePrice: body.strikePrice,
      userRemark: body.userRemark || 'Angel Order',
    };
    
    const result = await placeOrder(orderRequest);
    
    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error('[API] Place order error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to place order' },
      { status: 500 }
    );
  }
}

// ─── PUT: Modify order ────────────────────────────────────────────
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    
    if (!body.orderId) {
      return NextResponse.json(
        { success: false, error: 'Order ID is required' },
        { status: 400 }
      );
    }
    
    const result = await modifyOrder(body.orderId, {
      quantity: body.quantity,
      price: body.price,
      orderType: body.orderType,
      stoploss: body.stoploss,
    });
    
    return NextResponse.json({
      success: result.success,
      message: result.message,
    });
  } catch (error: any) {
    console.error('[API] Modify order error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to modify order' },
      { status: 500 }
    );
  }
}

// ─── DELETE: Cancel order ─────────────────────────────────────────
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const orderId = searchParams.get('orderId');
    
    if (!orderId) {
      return NextResponse.json(
        { success: false, error: 'Order ID is required' },
        { status: 400 }
      );
    }
    
    const result = await cancelOrder(orderId);
    
    return NextResponse.json({
      success: result.success,
      message: result.message,
    });
  } catch (error: any) {
    console.error('[API] Cancel order error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to cancel order' },
      { status: 500 }
    );
  }
}
