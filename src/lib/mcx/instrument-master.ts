// MCX Commodity Module — Instrument Master
// Dynamic contract loading from Motilal API + static fallback specs

import { getScrips, type MotilalScrip } from '@/lib/motilal/market';
import { getSessionToken } from '@/lib/motilal/auth';
import type { MCXCommodity, MCXContractSpec, MCXInstrument, MCXCategory } from './types';
import { MCX_APPROVED_CONTRACTS } from './types';

// ── Static contract specifications (lot sizes, tick sizes, expiry rules) ──
// These are the base specs. Dynamic token/expiry loaded from Motilal API.
export const MCX_CONTRACT_SPECS: Record<MCXCommodity, MCXContractSpec> = {
  CRUDEOIL: {
    symbol: 'CRUDEOIL',
    category: 'ENERGY',
    label: 'Crude Oil',
    lotSize: 100,
    tickSize: 1,
    maxLots: 10,
    typicalPremium: 500,
    deliveryUnit: '100 BBL',
    deliveryType: 'Physical',
    activeMonths: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
    lastTradingDay: 19,
    tradingStartTime: '09:00',
    tradingEndTime: '23:30',
    eveningSession: true,
    higherRiskFilter: false,
    lowerLiquidityFilter: false,
  },
  CRUDEOILM: {
    symbol: 'CRUDEOILM',
    category: 'ENERGY',
    label: 'Crude Oil Mini',
    lotSize: 10,
    tickSize: 1,
    maxLots: 25,
    typicalPremium: 50,
    deliveryUnit: '10 BBL',
    deliveryType: 'Physical',
    activeMonths: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
    lastTradingDay: 19,
    tradingStartTime: '09:00',
    tradingEndTime: '23:30',
    eveningSession: true,
    higherRiskFilter: false,
    lowerLiquidityFilter: false,
  },
  NATURALGAS: {
    symbol: 'NATURALGAS',
    category: 'ENERGY',
    label: 'Natural Gas',
    lotSize: 1250,
    tickSize: 0.1,
    maxLots: 10,
    typicalPremium: 200,
    deliveryUnit: '10 mmBtu',
    deliveryType: 'Physical',
    activeMonths: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
    lastTradingDay: 19,
    tradingStartTime: '09:00',
    tradingEndTime: '23:30',
    eveningSession: true,
    higherRiskFilter: true, // Aggressive moves
    lowerLiquidityFilter: false,
  },
  NATGASMINI: {
    symbol: 'NATGASMINI',
    category: 'ENERGY',
    label: 'Natural Gas Mini',
    lotSize: 250,
    tickSize: 0.1,
    maxLots: 25,
    typicalPremium: 40,
    deliveryUnit: '2 mmBtu',
    deliveryType: 'Physical',
    activeMonths: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
    lastTradingDay: 19,
    tradingStartTime: '09:00',
    tradingEndTime: '23:30',
    eveningSession: true,
    higherRiskFilter: true,
    lowerLiquidityFilter: true, // Lower liquidity
  },
  GOLD: {
    symbol: 'GOLD',
    category: 'PRECIOUS_METALS',
    label: 'Gold',
    lotSize: 1,
    tickSize: 1,
    maxLots: 10,
    typicalPremium: 1000,
    deliveryUnit: '1 Kg',
    deliveryType: 'Physical',
    activeMonths: ['2', '4', '6', '8', '10', '12'],
    lastTradingDay: 5,
    tradingStartTime: '09:00',
    tradingEndTime: '23:30',
    eveningSession: true,
    higherRiskFilter: false,
    lowerLiquidityFilter: false,
  },
  GOLDM: {
    symbol: 'GOLDM',
    category: 'PRECIOUS_METALS',
    label: 'Gold Mini',
    lotSize: 100,
    tickSize: 1,
    maxLots: 25,
    typicalPremium: 100,
    deliveryUnit: '100g',
    deliveryType: 'Physical',
    activeMonths: ['2', '4', '6', '8', '10', '12'],
    lastTradingDay: 5,
    tradingStartTime: '09:00',
    tradingEndTime: '23:30',
    eveningSession: true,
    higherRiskFilter: false,
    lowerLiquidityFilter: false,
  },
  GOLDGUINEA: {
    symbol: 'GOLDGUINEA',
    category: 'PRECIOUS_METALS',
    label: 'Gold Guinea',
    lotSize: 1,
    tickSize: 10,
    maxLots: 10,
    typicalPremium: 5000,
    deliveryUnit: '8g',
    deliveryType: 'Physical',
    activeMonths: ['2', '4', '6', '8', '10', '12'],
    lastTradingDay: 5,
    tradingStartTime: '09:00',
    tradingEndTime: '23:30',
    eveningSession: true,
    higherRiskFilter: false,
    lowerLiquidityFilter: true, // Lower liquidity
  },
  SILVER: {
    symbol: 'SILVER',
    category: 'PRECIOUS_METALS',
    label: 'Silver',
    lotSize: 30,
    tickSize: 1,
    maxLots: 10,
    typicalPremium: 800,
    deliveryUnit: '30 Kg',
    deliveryType: 'Physical',
    activeMonths: ['3', '5', '7', '9', '11', '12'],
    lastTradingDay: 5,
    tradingStartTime: '09:00',
    tradingEndTime: '23:30',
    eveningSession: true,
    higherRiskFilter: false,
    lowerLiquidityFilter: false,
  },
  SILVERM: {
    symbol: 'SILVERM',
    category: 'PRECIOUS_METALS',
    label: 'Silver Mini',
    lotSize: 5,
    tickSize: 1,
    maxLots: 25,
    typicalPremium: 150,
    deliveryUnit: '5 Kg',
    deliveryType: 'Physical',
    activeMonths: ['3', '5', '7', '9', '11', '12'],
    lastTradingDay: 5,
    tradingStartTime: '09:00',
    tradingEndTime: '23:30',
    eveningSession: true,
    higherRiskFilter: false,
    lowerLiquidityFilter: false,
  },
  SILVERMIC: {
    symbol: 'SILVERMIC',
    category: 'PRECIOUS_METALS',
    label: 'Silver Micro',
    lotSize: 1,
    tickSize: 1,
    maxLots: 25,
    typicalPremium: 30,
    deliveryUnit: '1 Kg',
    deliveryType: 'Physical',
    activeMonths: ['3', '5', '7', '9', '11', '12'],
    lastTradingDay: 5,
    tradingStartTime: '09:00',
    tradingEndTime: '23:30',
    eveningSession: true,
    higherRiskFilter: false,
    lowerLiquidityFilter: true, // Lower liquidity
  },
};

// ── Dynamic instrument cache ──
let mcxInstruments: Map<MCXCommodity, MCXInstrument> = new Map();
let lastInstrumentLoad = 0;
const INSTRUMENT_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ── Load MCX instruments from Motilal API ──
export async function loadMCXInstruments(): Promise<Map<MCXCommodity, MCXInstrument>> {
  const now = Date.now();
  if (mcxInstruments.size > 0 && now - lastInstrumentLoad < INSTRUMENT_CACHE_TTL) {
    return mcxInstruments;
  }

  const token = getSessionToken();
  if (!token) {
    // Return static fallback specs when not logged in
    return getStaticInstruments();
  }

  try {
    const scrips = await getScrips('MCX', token);
    if (!scrips || scrips.length === 0) {
      return getStaticInstruments();
    }

    const instruments = new Map<MCXCommodity, MCXInstrument>();

    for (const scrip of scrips) {
      const symbol = normalizeMCXSymbol(scrip.symbol);
      if (!symbol || !MCX_APPROVED_CONTRACTS.includes(symbol)) continue;

      // Only keep FUTURES and OPTIONS with valid expiry
      if (!scrip.expirydate || scrip.expirydate === '0000-00-00') continue;

      const spec = MCX_CONTRACT_SPECS[symbol];

      // Pick the nearest active expiry (not expired)
      const expiryDate = new Date(scrip.expirydate);
      if (expiryDate < new Date()) continue;

      const existing = instruments.get(symbol);
      if (!existing || new Date(scrip.expirydate) < new Date(existing.expiry)) {
        instruments.set(symbol, {
          symbol,
          exchange: 'MCX',
          token: scrip.scripcode,
          contractName: scrip.name || scrip.symbol,
          expiry: scrip.expirydate,
          instrumentType: scrip.optiontype ? 'OPTIONS' : 'FUTURES',
          lotSize: scrip.lotsize || spec?.lotSize || 0,
          tickSize: spec?.tickSize || 1,
          tradingStatus: 'ACTIVE',
          strikePrice: scrip.strikeprice || undefined,
          optionType: scrip.optiontype || undefined,
        });
      }
    }

    if (instruments.size > 0) {
      mcxInstruments = instruments;
      lastInstrumentLoad = now;
    }

    return instruments.size > 0 ? instruments : getStaticInstruments();
  } catch {
    return getStaticInstruments();
  }
}

// ── Get static instruments when API unavailable ──
function getStaticInstruments(): Map<MCXCommodity, MCXInstrument> {
  const instruments = new Map<MCXCommodity, MCXInstrument>();
  for (const symbol of MCX_APPROVED_CONTRACTS) {
    const spec = MCX_CONTRACT_SPECS[symbol];
    const now = new Date();
    const month = (now.getMonth() + 1) % 12 || 12;
    const year = now.getFullYear();
    const expiry = `${year}-${String(month).padStart(2, '0')}-${String(spec.lastTradingDay).padStart(2, '0')}`;

    instruments.set(symbol, {
      symbol,
      exchange: 'MCX',
      token: 0,
      contractName: spec.label,
      expiry,
      instrumentType: 'FUTURES',
      lotSize: spec.lotSize,
      tickSize: spec.tickSize,
      tradingStatus: 'DATA_UNAVAILABLE',
    });
  }
  return instruments;
}

// ── Normalize Motilal scrip symbol to our MCXCommodity type ──
function normalizeMCXSymbol(raw: string): MCXCommodity | null {
  const upper = raw.toUpperCase().replace(/[^A-Z]/g, '');
  // Direct match
  if (MCX_APPROVED_CONTRACTS.includes(upper as MCXCommodity)) {
    return upper as MCXCommodity;
  }
  // Partial matches
  if (upper.includes('CRUDEOIL') && upper.includes('MINI')) return 'CRUDEOILM';
  if (upper.includes('CRUDEOIL')) return 'CRUDEOIL';
  if (upper.includes('NATURALGAS') && upper.includes('MINI')) return 'NATGASMINI';
  if (upper.includes('NATURALGAS') || upper.includes('NATGAS')) return 'NATURALGAS';
  if (upper.includes('GOLD') && upper.includes('GUINEA')) return 'GOLDGUINEA';
  if (upper.includes('GOLD') && upper.includes('MINI')) return 'GOLDM';
  if (upper.includes('GOLD')) return 'GOLD';
  if (upper.includes('SILVER') && upper.includes('MICRO')) return 'SILVERMIC';
  if (upper.includes('SILVER') && upper.includes('MINI')) return 'SILVERM';
  if (upper.includes('SILVER')) return 'SILVER';
  return null;
}

// ── Get contract spec for a commodity ──
export function getMCXContractSpec(symbol: MCXCommodity): MCXContractSpec {
  return MCX_CONTRACT_SPECS[symbol];
}

// ── Get lot size for a commodity ──
export function getMCXLotSize(symbol: MCXCommodity): number {
  return MCX_CONTRACT_SPECS[symbol]?.lotSize || 0;
}

// ── Get all approved MCX symbols ──
export function getMCXApprovedContracts(): MCXCommodity[] {
  return [...MCX_APPROVED_CONTRACTS];
}

// ── Get MCX symbols by category ──
export function getMCXByCategory(category: MCXCategory): MCXCommodity[] {
  return MCX_APPROVED_CONTRACTS.filter(s => MCX_CONTRACT_SPECS[s].category === category);
}

// ── Check if symbol is a valid MCX commodity ──
export function isMCXCommodity(symbol: string): symbol is MCXCommodity {
  return MCX_APPROVED_CONTRACTS.includes(symbol as MCXCommodity);
}

// ── Check if commodity has higher risk filtering ──
export function isMCXHigherRisk(symbol: MCXCommodity): boolean {
  return MCX_CONTRACT_SPECS[symbol]?.higherRiskFilter || false;
}

// ── Check if commodity has lower liquidity filtering ──
export function isMCXLowerLiquidity(symbol: MCXCommodity): boolean {
  return MCX_CONTRACT_SPECS[symbol]?.lowerLiquidityFilter || false;
}
