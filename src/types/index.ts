// SD PRO Trading Dashboard - Type System
// Universal Market Engine types for ICICI Breeze integration

// ─── Market Data Types ────────────────────────────────────────────
export interface MarketQuote {
  symbol: string;
  exchange: 'NSE' | 'NFO' | 'BSE';
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  change: number;
  changePct: number;
  lastTradeTime: string;
}

export interface OptionQuote {
  symbol: string;
  strikePrice: number;
  expiryDate: string;
  optionType: 'call' | 'put';
  ltp: number;
  bid: number;
  ask: number;
  volume: number;
  openInterest: number;
  oiChange: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export interface OptionChainData {
  symbol: string;
  expiryDate: string;
  spotPrice: number;
  strikes: number[];
  calls: OptionQuote[];
  puts: OptionQuote[];
  atmStrike: number;
  timestamp: string;
}

// ─── Order Types ──────────────────────────────────────────────────
export type OrderAction = 'buy' | 'sell';
export type OrderType = 'limit' | 'stoploss';
export type ProductType = 'cash' | 'futures' | 'options' | 'btst';
export type Validity = 'day' | 'ioc';

export interface OrderRequest {
  stockCode: string;
  exchangeCode: 'NSE' | 'NFO';
  product: ProductType;
  action: OrderAction;
  orderType: OrderType;
  quantity: string;
  price: string;
  validity: Validity;
  stoploss?: string;
  validityDate?: string;
  disclosedQuantity?: string;
  expiryDate?: string;
  right?: 'call' | 'put' | 'others';
  strikePrice?: string;
  userRemark?: string;
}

export interface Order {
  orderId: string;
  stockCode: string;
  exchangeCode: string;
  product: string;
  action: string;
  orderType: string;
  quantity: string;
  price: string;
  status: string;
  validity: string;
  orderTimestamp: string;
  lastUpdatedTimestamp: string;
  filledQuantity: string;
  averagePrice: string;
  stoploss?: string;
  disclosedQuantity?: string;
  validityDate?: string;
  expiryDate?: string;
  right?: string;
  strikePrice?: string;
  userRemark?: string;
  errorMessage?: string;
}

// ─── Position Types ───────────────────────────────────────────────
export interface Position {
  stockCode: string;
  exchangeCode: string;
  product: string;
  quantity: string;
  averagePrice: string;
  ltp: string;
  pnl: string;
  pnlPercentage: string;
  buyQuantity: string;
  buyAverage: string;
  sellQuantity: string;
  sellAverage: string;
}

export interface Holding {
  stockCode: string;
  exchangeCode: string;
  quantity: string;
  averagePrice: string;
  ltp: string;
  pnl: string;
  pnlPercentage: string;
}

// ─── Funds Types ──────────────────────────────────────────────────
export interface Funds {
  bankAccount: string;
  totalBankBalance: number;
  allocatedEquity: number;
  allocatedFno: number;
  allocatedCommodity: number;
  allocatedCurrency: number;
  blockByTradeEquity: number;
  blockByTradeFno: number;
  blockByTradeCommodity: number;
  blockByTradeCurrency: number;
  blockByTradeBalance: number;
  unallocatedBalance: number;
}

// ─── Trade Types ──────────────────────────────────────────────────
export interface Trade {
  tradeNumber: string;
  orderId: string;
  stockCode: string;
  exchangeCode: string;
  product: string;
  action: string;
  quantity: string;
  price: string;
  tradeTimestamp: string;
}

// ─── WebSocket Types ──────────────────────────────────────────────
export type WSEventType = 
  | 'quote_update'
  | 'option_chain_update'
  | 'order_update'
  | 'position_update'
  | 'trade_update'
  | 'market_status';

export interface WSMessage {
  type: WSEventType;
  data: any;
  timestamp: string;
}

// ─── Trading Store Types ──────────────────────────────────────────
export interface TradingState {
  // Connection
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
  
  // Market Data
  selectedSymbol: string;
  selectedExpiry: string;
  spotPrice: number;
  optionChain: OptionChainData | null;
  
  // Orders
  orders: Order[];
  pendingOrders: Order[];
  
  // Positions
  positions: Position[];
  holdings: Holding[];
  
  // Funds
  funds: Funds | null;
  
  // UI State
  showOrderPanel: boolean;
  selectedStrike: number | null;
  selectedOption: 'call' | 'put' | null;
  
  // Actions
  setSelectedSymbol: (symbol: string) => void;
  setSelectedExpiry: (expiry: string) => void;
  setOptionChain: (chain: OptionChainData | null) => void;
  setOrders: (orders: Order[]) => void;
  setPositions: (positions: Position[]) => void;
  setHoldings: (holdings: Holding[]) => void;
  setFunds: (funds: Funds | null) => void;
  setSelectedStrike: (strike: number | null) => void;
  setSelectedOption: (option: 'call' | 'put' | null) => void;
  setShowOrderPanel: (show: boolean) => void;
  setError: (error: string | null) => void;
  setIsConnected: (connected: boolean) => void;
}

// ─── API Response Types ───────────────────────────────────────────
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  status: number;
}

// ─── ICICI Breeze API Types ───────────────────────────────────────
export interface BreezeCustomerDetails {
  exgTradeDate: Record<string, string>;
  exgStatus: Record<string, string>;
  segmentsAllowed: {
    Trading: string;
    Equity: string;
    Derivatives: string;
    Currency: string;
  };
  idirectUserid: string;
  sessionToken: string;
  idirectUserName: string;
  idirectOrdTyp: string;
  idirectLastloginTime: string;
}

export interface BreezeOptionChainResponse {
  success: any[];
  status: number;
  error: any;
}

// ─── Option Chain Response Types (used by live-data-engine) ──────
export interface OptionData {
  strike: number;
  ce: {
    oi: number;
    oiChg: number;
    volume: number;
    iv: number;
    ltp: number;
    chg: number;
    delta: number;
    theta: number;
    gamma: number;
    vega: number;
  } | null;
  pe: {
    oi: number;
    oiChg: number;
    volume: number;
    iv: number;
    ltp: number;
    chg: number;
    delta: number;
    theta: number;
    gamma: number;
    vega: number;
  } | null;
}

export interface ExpiryInfo {
  date: string;
  label: string;
  daysToExpiry: number;
}

export interface MarketSummary {
  spotPrice: number;
  spotChange: number;
  spotChangePct: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  indiaVIX: number;
  vixChange: number;
  pcr: number;
  maxPain: number;
  totalCallOI: number;
  totalPutOI: number;
  totalCallVolume: number;
  totalPutVolume: number;
  atmStrike: number;
}

export interface OptionChainResponse {
  symbol: string;
  spotPrice: number;
  expiries: ExpiryInfo[];
  selectedExpiry: string;
  data: OptionData[];
  summary: MarketSummary;
  timestamp: string;
}
