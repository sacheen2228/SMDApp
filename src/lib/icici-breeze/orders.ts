// ICICI Breeze API - Orders using official SDK

import { getBreezeClient } from './auth';
import type { Order, OrderRequest } from '@/types';

// ─── Place Order ──────────────────────────────────────────────────
export async function placeOrder(order: OrderRequest): Promise<{ orderId: string; message: string }> {
  const breeze = getBreezeClient();

  const result = await breeze.placeOrder({
    stockCode: order.stockCode,
    exchangeCode: order.exchangeCode,
    product: order.product as any,
    action: order.action as any,
    orderType: order.orderType as any,
    quantity: order.quantity,
    price: order.price,
    validity: order.validity as any,
    stoploss: order.stoploss || '',
    validityDate: order.validityDate || '',
    disclosedQuantity: order.disclosedQuantity || '0',
    expiryDate: order.expiryDate || '',
    right: order.right || 'others',
    strikePrice: order.strikePrice || '0',
    userRemark: order.userRemark || 'SDM Order',
  });

  return {
    orderId: result?.order_id || '',
    message: result?.message || 'Order placed',
  };
}

// ─── Get Order List ───────────────────────────────────────────────
export async function getOrderList(): Promise<Order[]> {
  const breeze = getBreezeClient();
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const result = await breeze.getOrderList({
    exchangeCode: 'NFO',
    fromDate: from.toISOString(),
    toDate: now.toISOString(),
  });

  const orders = result?.Success || [];
  if (!Array.isArray(orders)) return [];

  return orders.map((order: any) => ({
    orderId: order.order_id || '',
    stockCode: order.stock_code || '',
    exchangeCode: order.exchange_code || '',
    product: order.product || '',
    action: order.action || '',
    orderType: order.order_type || '',
    quantity: order.quantity || '0',
    price: order.price || '0',
    status: order.status || '',
    validity: order.validity || '',
    orderTimestamp: order.order_timestamp || '',
    lastUpdatedTimestamp: order.last_updated_timestamp || '',
    filledQuantity: order.filled_quantity || '0',
    averagePrice: order.average_price || '0',
    stoploss: order.stoploss || '',
    disclosedQuantity: order.disclosed_quantity || '',
    validityDate: order.validity_date || '',
    expiryDate: order.expiry_date || '',
    right: order.right || '',
    strikePrice: order.strike_price || '',
    userRemark: order.user_remark || '',
    errorMessage: order.error_message || '',
  }));
}

// ─── Get Order Detail ─────────────────────────────────────────────
export async function getOrderDetail(orderId: string): Promise<Order> {
  const breeze = getBreezeClient();
  const result = await breeze.getOrderDetail({
    exchangeCode: 'NFO',
    orderId,
  });

  const order = result?.Success || {};
  return {
    orderId: order.order_id || '',
    stockCode: order.stock_code || '',
    exchangeCode: order.exchange_code || '',
    product: order.product || '',
    action: order.action || '',
    orderType: order.order_type || '',
    quantity: order.quantity || '0',
    price: order.price || '0',
    status: order.status || '',
    validity: order.validity || '',
    orderTimestamp: order.order_timestamp || '',
    lastUpdatedTimestamp: order.last_updated_timestamp || '',
    filledQuantity: order.filled_quantity || '0',
    averagePrice: order.average_price || '0',
    stoploss: order.stoploss || '',
    disclosedQuantity: order.disclosed_quantity || '',
    validityDate: order.validity_date || '',
    expiryDate: order.expiry_date || '',
    right: order.right || '',
    strikePrice: order.strike_price || '',
    userRemark: order.user_remark || '',
    errorMessage: order.error_message || '',
  };
}

// ─── Cancel Order ─────────────────────────────────────────────────
export async function cancelOrder(orderId: string): Promise<{ success: boolean; message: string }> {
  try {
    const breeze = getBreezeClient();
    await breeze.cancelOrder({
      exchangeCode: 'NFO',
      orderId,
    });
    return { success: true, message: 'Order cancelled successfully' };
  } catch (error: any) {
    return { success: false, message: error.message || 'Failed to cancel order' };
  }
}

// ─── Modify Order ─────────────────────────────────────────────────
export async function modifyOrder(
  orderId: string,
  updates: Partial<OrderRequest>
): Promise<{ success: boolean; message: string }> {
  try {
    const breeze = getBreezeClient();
    await breeze.modifyOrder({
      orderId,
      exchangeCode: 'NFO',
      orderType: updates.orderType as any,
      stoploss: updates.stoploss || '',
      quantity: updates.quantity || '',
      price: updates.price || '',
      validity: 'day',
      disclosedQuantity: '0',
    });
    return { success: true, message: 'Order modified successfully' };
  } catch (error: any) {
    return { success: false, message: error.message || 'Failed to modify order' };
  }
}

// ─── Square Off Position ──────────────────────────────────────────
export async function squareOff(params: {
  stockCode: string;
  exchangeCode: string;
  product: string;
  quantity: string;
  action: 'buy' | 'sell';
}): Promise<{ success: boolean; message: string }> {
  try {
    const breeze = getBreezeClient();
    await breeze.squareOff({
      exchangeCode: params.exchangeCode as any,
      product: params.product as any,
      stockCode: params.stockCode,
      quantity: params.quantity,
      action: params.action,
      orderType: 'limit',
      price: '0',
      validity: 'day',
      stoploss: '0',
      disclosedQuantity: '0',
    });
    return { success: true, message: 'Square off order placed' };
  } catch (error: any) {
    return { success: false, message: error.message || 'Failed to square off' };
  }
}
