// ICICI Breeze API - Positions & Holdings using official SDK

import { getBreezeClient } from './auth';
import type { Position, Holding, Funds } from '@/types';

// ─── Get Positions ────────────────────────────────────────────────
export async function getPositions(): Promise<Position[]> {
  const breeze = getBreezeClient();
  const result = await breeze.getPortfolioPositions();

  const positions = result?.Success || [];
  if (!Array.isArray(positions)) return [];

  return positions.map((pos: any) => ({
    stockCode: pos.stock_code || '',
    exchangeCode: pos.exchange_code || '',
    product: pos.product || '',
    quantity: pos.quantity || '0',
    averagePrice: pos.average_price || '0',
    ltp: pos.ltp || '0',
    pnl: pos.pnl || '0',
    pnlPercentage: pos.pnl_percentage || '0',
    buyQuantity: pos.buy_quantity || '0',
    buyAverage: pos.buy_average || '0',
    sellQuantity: pos.sell_quantity || '0',
    sellAverage: pos.sell_average || '0',
  }));
}

// ─── Get Holdings ─────────────────────────────────────────────────
export async function getHoldings(): Promise<Holding[]> {
  const breeze = getBreezeClient();
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const result = await breeze.getPortfolioHoldings({
    exchangeCode: 'NFO',
    fromDate: from.toISOString(),
    toDate: now.toISOString(),
  });

  const holdings = result?.Success || [];
  if (!Array.isArray(holdings)) return [];

  return holdings.map((hold: any) => ({
    stockCode: hold.stock_code || '',
    exchangeCode: hold.exchange_code || '',
    quantity: hold.quantity || '0',
    averagePrice: hold.average_price || '0',
    ltp: hold.ltp || '0',
    pnl: hold.pnl || '0',
    pnlPercentage: hold.pnl_percentage || '0',
  }));
}

// ─── Get Funds ────────────────────────────────────────────────────
export async function getFunds(): Promise<Funds> {
  const breeze = getBreezeClient();
  const result = await breeze.getFunds();

  const funds = result?.Success || {};
  return {
    bankAccount: funds.bank_account || '',
    totalBankBalance: parseFloat(funds.total_bank_balance || '0'),
    allocatedEquity: parseFloat(funds.allocated_equity || '0'),
    allocatedFno: parseFloat(funds.allocated_fno || '0'),
    allocatedCommodity: parseFloat(funds.allocated_commodity || '0'),
    allocatedCurrency: parseFloat(funds.allocated_currency || '0'),
    blockByTradeEquity: parseFloat(funds.block_by_trade_equity || '0'),
    blockByTradeFno: parseFloat(funds.block_by_trade_fno || '0'),
    blockByTradeCommodity: parseFloat(funds.block_by_trade_commodity || '0'),
    blockByTradeCurrency: parseFloat(funds.block_by_trade_currency || '0'),
    blockByTradeBalance: parseFloat(funds.block_by_trade_balance || '0'),
    unallocatedBalance: parseFloat(funds.unallocated_balance || '0'),
  };
}

// ─── Get Margin ───────────────────────────────────────────────────
export async function getMargin(exchangeCode: 'NSE' | 'NFO' = 'NSE'): Promise<any> {
  const breeze = getBreezeClient();
  return breeze.getMargin({ exchangeCode });
}
