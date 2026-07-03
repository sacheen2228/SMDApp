// SD PRO Trading Dashboard - Zustand Store
// State management for trading data

import { create } from 'zustand';
import type { 
  TradingState, 
  OptionChainData, 
  Order, 
  Position, 
  Holding, 
  Funds 
} from '@/types';

export const useTradingStore = create<TradingState>((set) => ({
  // Connection
  isConnected: false,
  isLoading: false,
  error: null,
  
  // Market Data
  selectedSymbol: 'NIFTY',
  selectedExpiry: '',
  spotPrice: 0,
  optionChain: null,
  
  // Orders
  orders: [],
  pendingOrders: [],
  
  // Positions
  positions: [],
  holdings: [],
  
  // Funds
  funds: null,
  
  // UI State
  showOrderPanel: false,
  selectedStrike: null,
  selectedOption: null,
  
  // Actions
  setSelectedSymbol: (symbol) => set({ selectedSymbol: symbol }),
  setSelectedExpiry: (expiry) => set({ selectedExpiry: expiry }),
  setOptionChain: (chain) => set({ 
    optionChain: chain,
    spotPrice: chain?.spotPrice || 0 
  }),
  setOrders: (orders) => set({ 
    orders,
    pendingOrders: orders.filter(o => 
      o.status === 'pending' || o.status === 'open' || o.status === 'trigger pending'
    )
  }),
  setPositions: (positions) => set({ positions }),
  setHoldings: (holdings) => set({ holdings }),
  setFunds: (funds) => set({ funds }),
  setSelectedStrike: (strike) => set({ selectedStrike: strike }),
  setSelectedOption: (option) => set({ selectedOption: option }),
  setShowOrderPanel: (show) => set({ showOrderPanel: show }),
  setError: (error) => set({ error }),
  setIsConnected: (connected) => set({ isConnected: connected }),
}));
