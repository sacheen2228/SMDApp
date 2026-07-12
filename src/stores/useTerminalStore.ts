// Terminal instrument selection store
// Controls which symbol all terminal panels fetch data for

import { create } from 'zustand';
import { getLotSize } from '@/lib/symbol-config';

export type InstrumentType = 'INDEX' | 'EQUITY';

export interface Instrument {
  symbol: string;
  label: string;
  type: InstrumentType;
  exchange: 'NSE' | 'BSE';
  lotSize: number;
}

// Index lot sizes derived from src/lib/symbol-config.ts (single source
// of truth) — previously hardcoded here with stale pre-Jan-2026 values
// (e.g. NIFTY was 75 before the Jan 2026 NSE revision to 65).
export const INDEX_INSTRUMENTS: Instrument[] = [
  { symbol: 'NIFTY', label: 'NIFTY 50', type: 'INDEX', exchange: 'NSE', lotSize: getLotSize('NIFTY') },
  { symbol: 'BANKNIFTY', label: 'BANK NIFTY', type: 'INDEX', exchange: 'NSE', lotSize: getLotSize('BANKNIFTY') },
  { symbol: 'FINNIFTY', label: 'FIN NIFTY', type: 'INDEX', exchange: 'NSE', lotSize: getLotSize('FINNIFTY') },
  { symbol: 'MIDCPNIFTY', label: 'MIDCAP NIFTY', type: 'INDEX', exchange: 'NSE', lotSize: getLotSize('MIDCPNIFTY') },
  { symbol: 'NIFTYNXT50', label: 'NIFTY NEXT 50', type: 'INDEX', exchange: 'NSE', lotSize: getLotSize('NIFTYNXT50') },
  { symbol: 'SENSEX', label: 'SENSEX', type: 'INDEX', exchange: 'BSE', lotSize: getLotSize('SENSEX') },
  { symbol: 'BANKEX', label: 'BANKEX (BSE)', type: 'INDEX', exchange: 'BSE', lotSize: getLotSize('BANKEX') },
];

export const EQUITY_INSTRUMENTS: Instrument[] = [
  { symbol: 'RELIANCE', label: 'RELIANCE', type: 'EQUITY', exchange: 'NSE', lotSize: 250 },
  { symbol: 'TCS', label: 'TCS', type: 'EQUITY', exchange: 'NSE', lotSize: 175 },
  { symbol: 'INFY', label: 'INFOSYS', type: 'EQUITY', exchange: 'NSE', lotSize: 500 },
  { symbol: 'HDFCBANK', label: 'HDFC BANK', type: 'EQUITY', exchange: 'NSE', lotSize: 550 },
  { symbol: 'ICICIBANK', label: 'ICICI BANK', type: 'EQUITY', exchange: 'NSE', lotSize: 700 },
  { symbol: 'SBIN', label: 'SBI', type: 'EQUITY', exchange: 'NSE', lotSize: 1500 },
  { symbol: 'BHARTIARTL', label: 'BHARTI AIRTEL', type: 'EQUITY', exchange: 'NSE', lotSize: 475 },
  { symbol: 'ITC', label: 'ITC', type: 'EQUITY', exchange: 'NSE', lotSize: 1600 },
  { symbol: 'KOTAKBANK', label: 'KOTAK BANK', type: 'EQUITY', exchange: 'NSE', lotSize: 400 },
  { symbol: 'LT', label: 'L&T', type: 'EQUITY', exchange: 'NSE', lotSize: 150 },
];

export const ALL_INSTRUMENTS = [...INDEX_INSTRUMENTS, ...EQUITY_INSTRUMENTS];

export function getInstrument(symbol: string): Instrument | undefined {
  return ALL_INSTRUMENTS.find(i => i.symbol === symbol);
}

interface TerminalState {
  symbol: string;
  expiry: string;
  customSymbol: string;
  showSearch: boolean;

  setSymbol: (symbol: string) => void;
  setExpiry: (expiry: string) => void;
  setCustomSymbol: (symbol: string) => void;
  setShowSearch: (show: boolean) => void;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  symbol: 'NIFTY',
  expiry: '',
  customSymbol: '',
  showSearch: false,

  setSymbol: (symbol) => set({ symbol, expiry: '' }),
  setExpiry: (expiry) => set({ expiry }),
  setCustomSymbol: (customSymbol) => set({ customSymbol }),
  setShowSearch: (showSearch) => set({ showSearch }),
}));
