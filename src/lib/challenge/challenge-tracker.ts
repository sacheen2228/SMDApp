// ═══════════════════════════════════════════════════════════════════════════
// Challenge Tracker — ₹15K → ₹1L Challenge State Machine
// FIXED: progress calc, drawdown from peak, PF display, R-multiple, equity curve
// Persists equity curve in memory (resets on server restart).
// ═══════════════════════════════════════════════════════════════════════════

import {
  type CapitalConfig,
  type DrawdownState,
  DEFAULT_CAPITAL_CONFIG,
  checkDrawdown,
  getMilestones,
} from "./capital-manager";

export type ChallengeStatus = "ACTIVE" | "TARGET_REACHED" | "FAILED" | "PAUSED";

export interface ChallengeTrade {
  id: string;
  timestamp: string;
  symbol: string;
  strategy: string;
  direction: string;
  entry: number;
  exit?: number;
  quantity: number;
  lotSize: number;
  pnl: number;
  pnlPct: number;
  rMultiple: number;
  status: "OPEN" | "WIN" | "LOSS" | "BREAKEVEN" | "EXPIRED";
  exitReason?: string;
  score: number;
  holdingBars?: number;
  stopLoss: number;
  target: number;
}

export interface EquityPoint {
  timestamp: string;
  capital: number;
  tradeId?: string;
}

export interface DailySnapshot {
  date: string;
  openCapital: number;
  closeCapital: number;
  highCapital: number;
  lowCapital: number;
  pnl: number;
  trades: number;
  wins: number;
  losses: number;
}

export interface ChallengeState {
  challengeNumber: number;
  status: ChallengeStatus;
  startingCapital: number;
  currentCapital: number;
  peakCapital: number;
  targetCapital: number;
  config: CapitalConfig;
  startDate: string;
  lastUpdate: string;
  trades: ChallengeTrade[];
  equityCurve: EquityPoint[];
  dailySnapshots: DailySnapshot[];
  currentDrawdown: DrawdownState;
  milestones: Array<{ target: number; label: string; reached: boolean; progress: number }>;
  progressPct: number;
  progressLabel: string;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdownPct: number;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  grossWins: number;
  grossLosses: number;
}

// ── In-memory state ──
let challenge: ChallengeState | null = null;
let challengeHistory: ChallengeState[] = [];

function generateId(): string {
  return `CH${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ── Initialize new challenge ──
export function initChallenge(
  challengeNumber = 1,
  config: CapitalConfig = DEFAULT_CAPITAL_CONFIG,
): ChallengeState {
  const now = new Date().toISOString();
  challenge = {
    challengeNumber,
    status: "ACTIVE",
    startingCapital: config.startingCapital,
    currentCapital: config.startingCapital,
    peakCapital: config.startingCapital,
    targetCapital: config.targetCapital,
    config,
    startDate: now,
    lastUpdate: now,
    trades: [],
    equityCurve: [{ timestamp: now, capital: config.startingCapital }],
    dailySnapshots: [],
    currentDrawdown: checkDrawdown(config.startingCapital, config.startingCapital, 0, config.startingCapital, config),
    milestones: getMilestones(config.startingCapital, config.startingCapital),
    progressPct: 0,
    progressLabel: "STARTED",
    totalTrades: 0,
    winCount: 0,
    lossCount: 0,
    winRate: 0,
    profitFactor: 0,
    expectancy: 0,
    maxDrawdownPct: 0,
    consecutiveLosses: 0,
    maxConsecutiveLosses: 0,
    grossWins: 0,
    grossLosses: 0,
  };
  return challenge;
}

// ── Get current challenge ──
export function getChallenge(): ChallengeState {
  if (!challenge) return initChallenge();
  return challenge;
}

// ── Get challenge history ──
export function getChallengeHistory(): ChallengeState[] {
  return challengeHistory;
}

// ── Record equity point ──
function recordEquityPoint(capital: number, tradeId?: string) {
  const ch = getChallenge();
  ch.equityCurve.push({ timestamp: new Date().toISOString(), capital, tradeId });
  // Keep last 1000 points
  if (ch.equityCurve.length > 1000) ch.equityCurve = ch.equityCurve.slice(-1000);
}

// ── Calculate progress (FIXED: shows negative when behind target) ──
function calculateProgress(ch: ChallengeState): { pct: number; label: string } {
  const range = ch.targetCapital - ch.startingCapital;
  const current = ch.currentCapital - ch.startingCapital;
  const pct = range > 0 ? Math.round((current / range) * 100) : 0;
  const clampedPct = Math.max(-100, Math.min(100, pct));

  let label = "STARTED";
  if (ch.status === "TARGET_REACHED") label = "TARGET REACHED";
  else if (ch.status === "FAILED") label = "CHALLENGE FAILED";
  else if (clampedPct < 0) label = "BEHIND TARGET";
  else if (clampedPct >= 100) label = "TARGET REACHED";
  else if (clampedPct >= 75) label = "75% THERE";
  else if (clampedPct >= 50) label = "HALFWAY";
  else if (clampedPct >= 25) label = "25% THERE";
  else if (clampedPct > 0) label = "AHEAD";

  return { pct: clampedPct, label };
}

// ── Calculate profit factor (FIX: show — when no trades) ──
function calculateProfitFactor(ch: ChallengeState): number {
  if (ch.grossLosses === 0 && ch.grossWins === 0) return 0; // 0 = display as "—"
  if (ch.grossLosses === 0) return 99; // All wins
  return Math.round((ch.grossWins / ch.grossLosses) * 100) / 100;
}

// ── Record a new trade ──
export function recordTrade(trade: Omit<ChallengeTrade, "id" | "timestamp" | "pnl" | "pnlPct" | "rMultiple" | "status">): ChallengeTrade {
  const ch = getChallenge();
  const entry: ChallengeTrade = {
    ...trade,
    id: generateId(),
    timestamp: new Date().toISOString(),
    pnl: 0,
    pnlPct: 0,
    rMultiple: 0,
    status: "OPEN",
  };
  ch.trades.push(entry);
  ch.totalTrades++;
  ch.lastUpdate = new Date().toISOString();
  return entry;
}

// ── Close a trade (FIXED: R-multiple uses actual SL, proper P&L calc) ──
export function closeTrade(
  tradeId: string,
  exitPrice: number,
  exitReason: string,
): ChallengeTrade | null {
  const ch = getChallenge();
  const trade = ch.trades.find(t => t.id === tradeId && t.status === "OPEN");
  if (!trade) return null;

  const isLong = trade.direction.includes("BUY") || trade.direction === "LONG" || trade.direction === "CALL";
  const pnlPerShare = isLong ? exitPrice - trade.entry : trade.entry - exitPrice;

  trade.exit = exitPrice;
  trade.exitReason = exitReason;
  trade.pnl = Math.round(pnlPerShare * trade.quantity);
  trade.pnlPct = trade.entry > 0 ? Math.round((pnlPerShare / trade.entry) * 10000) / 100 : 0;

  // R-multiple based on ACTUAL stop loss (FIXED: was hardcoded 5%)
  const riskPerShare = Math.abs(trade.entry - trade.stopLoss);
  trade.rMultiple = riskPerShare > 0 ? Math.round((pnlPerShare / riskPerShare) * 100) / 100 : 0;

  trade.status = trade.pnl > 0 ? "WIN" : trade.pnl < 0 ? "LOSS" : "BREAKEVEN";

  // Update capital
  ch.currentCapital += trade.pnl;
  if (ch.currentCapital > ch.peakCapital) ch.peakCapital = ch.currentCapital;
  ch.currentCapital = Math.max(ch.currentCapital, 0);

  // Update gross P&L for profit factor
  if (trade.pnl > 0) {
    ch.winCount++;
    ch.grossWins += trade.pnl;
    ch.consecutiveLosses = 0;
  } else if (trade.pnl < 0) {
    ch.lossCount++;
    ch.grossLosses += Math.abs(trade.pnl);
    ch.consecutiveLosses++;
    ch.maxConsecutiveLosses = Math.max(ch.maxConsecutiveLosses, ch.consecutiveLosses);
  }

  // Win rate
  ch.winRate = ch.totalTrades > 0 ? Math.round((ch.winCount / ch.totalTrades) * 10000) / 100 : 0;

  // Profit factor (FIXED: uses grossWins/grossLosses)
  ch.profitFactor = calculateProfitFactor(ch);

  // Expectancy
  ch.expectancy = ch.totalTrades > 0 ? Math.round((ch.trades.reduce((s, t) => s + t.pnl, 0) / ch.totalTrades) * 100) / 100 : 0;

  // Drawdown from peak (FIXED: uses peakCapital, not startingCapital)
  ch.currentDrawdown = checkDrawdown(ch.currentCapital, ch.peakCapital, trade.pnl, ch.startingCapital, ch.config);
  ch.maxDrawdownPct = Math.max(ch.maxDrawdownPct, ch.currentDrawdown.totalDrawdownPct);

  // Record equity point
  recordEquityPoint(ch.currentCapital, trade.id);

  // Update milestones and progress
  ch.milestones = getMilestones(ch.currentCapital, ch.startingCapital);
  const progress = calculateProgress(ch);
  ch.progressPct = progress.pct;
  ch.progressLabel = progress.label;

  // Check failure
  if (ch.currentDrawdown.challengeFailed) {
    ch.status = "FAILED";
  }
  // Check target
  if (ch.currentCapital >= ch.targetCapital) {
    ch.status = "TARGET_REACHED";
  }

  ch.lastUpdate = new Date().toISOString();
  return trade;
}

// ── Get today's P&L ──
export function getTodayPnL(): number {
  const ch = getChallenge();
  const today = new Date().toISOString().split("T")[0];
  return ch.trades
    .filter(t => t.timestamp.startsWith(today) && t.status !== "OPEN")
    .reduce((s, t) => s + t.pnl, 0);
}

// ── Get daily summary (FIXED: real per-day tracking from equity curve) ──
export function getDailySummary(): DailySnapshot[] {
  const ch = getChallenge();
  const byDay: Record<string, ChallengeTrade[]> = {};
  for (const t of ch.trades) {
    const day = t.timestamp.split("T")[0];
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(t);
  }

  let runningCapital = ch.startingCapital;
  return Object.entries(byDay).map(([date, trades]) => {
    const closed = trades.filter(t => t.status !== "OPEN");
    const pnl = closed.reduce((s, t) => s + t.pnl, 0);
    const openCap = runningCapital;
    runningCapital += pnl;
    return {
      date,
      openCapital: openCap,
      closeCapital: runningCapital,
      highCapital: Math.max(openCap, runningCapital),
      lowCapital: Math.min(openCap, runningCapital),
      pnl,
      trades: closed.length,
      wins: closed.filter(t => t.status === "WIN").length,
      losses: closed.filter(t => t.status === "LOSS").length,
    };
  });
}

// ── Reset challenge (FIXED: archives history before reset) ──
export function resetChallenge(): ChallengeState {
  const ch = getChallenge();
  // Archive current challenge
  challengeHistory.push({ ...ch, trades: [...ch.trades], equityCurve: [...ch.equityCurve] });
  if (challengeHistory.length > 20) challengeHistory = challengeHistory.slice(-20);
  const nextNumber = ch.status === "FAILED" ? ch.challengeNumber + 1 : ch.challengeNumber;
  return initChallenge(nextNumber);
}

// ── Force pause/resume ──
export function pauseChallenge(): void {
  const ch = getChallenge();
  if (ch.status === "ACTIVE") ch.status = "PAUSED";
}

export function resumeChallenge(): void {
  const ch = getChallenge();
  if (ch.status === "PAUSED") ch.status = "ACTIVE";
}
