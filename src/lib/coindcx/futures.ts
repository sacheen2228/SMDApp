import { postPrivate, getPrivate } from './client';
import { COINDCX_CONFIG, createSignedPayload } from './auth';

export async function getBalances(): Promise<Array<{
  currency: string;
  balance: number;
  locked_balance: number;
}>> {
  return postPrivate('/exchange/v1/users/balances', { timestamp: Date.now() });
}

export interface OrderRequest {
  market: string;
  side: 'buy' | 'sell';
  order_type: 'market_order' | 'limit_order';
  total_quantity: number;
  price_per_unit?: number;
  timestamp?: number;
}

export interface OrderResponse {
  id: string;
  market: string;
  side: 'buy' | 'sell';
  order_type: string;
  price_per_unit: number;
  total_quantity: number;
  remaining_quantity: number;
  fee: number;
  status: string;
  created_at: number;
}

export async function createOrder(params: OrderRequest): Promise<OrderResponse> {
  return postPrivate<OrderResponse>('/exchange/v1/orders/create', {
    ...params,
    timestamp: params.timestamp || Date.now(),
  });
}

export async function getOrderStatus(orderId: string): Promise<OrderResponse> {
  return postPrivate<OrderResponse>('/exchange/v1/orders/status', {
    id: orderId,
    timestamp: Date.now(),
  });
}

export async function getActiveOrders(market?: string): Promise<OrderResponse[]> {
  return postPrivate<OrderResponse[]>('/exchange/v1/orders/active_orders', {
    market,
    timestamp: Date.now(),
  });
}

export async function cancelOrder(orderId: string): Promise<{ id: string; status: string }> {
  return postPrivate<{ id: string; status: string }>('/exchange/v1/orders/cancel', {
    id: orderId,
    timestamp: Date.now(),
  });
}

export async function cancelAllOrders(market?: string): Promise<{ success: boolean }> {
  return postPrivate<{ success: boolean }>('/exchange/v1/orders/cancel_all', {
    market,
    timestamp: Date.now(),
  });
}

export async function getOrderHistory(market: string, limit = 50): Promise<OrderResponse[]> {
  return postPrivate<OrderResponse[]>('/exchange/v1/orders/trade_history', {
    market,
    limit,
    timestamp: Date.now(),
  });
}
