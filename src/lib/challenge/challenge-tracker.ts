// ═══════════════════════════════════════════════════════════════════════════
// Challenge Tracker — ₹15K → ₹1L Challenge State Machine
// Tracks capital journey, milestones, daily P&L, trade history.
// Persists state in memory (resets on server restart — use for paper trading).
// ═══════════════════════════════════════════════════════════════════════════

import {
  type CapitalConfig,
  type DrawdownState,
  DEFAULT_CAPITAL_CONFIG,
  checkDrawdown,
  getMilestones,
  getChallengeProgress,
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
  drawdown: number;
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
  dailySnapshots: DailySnapshot[];
  currentDrawdown: DrawdownState;
  milestones: Array<{ target: number; label: string; reached: boolean; progress: number }>;
  progressPct: number;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdownPct: number;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
}

// ── In-memory state ──
let challenge: ChallengeState | null = null;

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
    dailySnapshots: [],
    currentDrawdown: checkDrawdown(config.startingCapital, config.startingCapital, 0, config.startingCapital, config),
    milestones: getMilestones(config.startingCapital, config.startingCapital),
    progressPct: 0,
    totalTrades: 0,
    winCount: 0,
    lossCount: 0,
    winRate: 0,
    profitFactor: 0,
    expectancy: 0,
    maxDrawdownPct: 0,
    consecutiveLosses: 0,
    maxConsecutiveLosses: 0,
  };
  return challenge;
}

// ── Get current challenge ──
export function getChallenge(): ChallengeState {
  if (!challenge) return initChallenge();
  return challenge;
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

// ── Close a trade ──
export function closeTrade(
  tradeId: string,
  exitPrice: number,
  exitReason: string,
): ChallengeTrade | null {
  const ch = getChallenge();
  const trade = ch.trades.find(t => t.id === tradeId && t.status === "OPEN");
  if (!trade) return null;

  const pnlPerShare = trade.direction.includes("BUY") || trade.direction === "LONG" || trade.direction === "CALL"
    ? exitPrice - trade.entry
    : trade.entry - exitPrice;

  trade.exit = exitPrice;
  trade.exitReason = exitReason;
  trade.pnl = Math.round(pnlPerShare * trade.quantity);
  trade.pnlPct = trade.entry > 0 ? Math.round((pnlPerShare / trade.entry) * 10000) / 100 : 0;

  // R-multiple
  const riskPerShare = Math.abs(trade.entry - (trade.entry * 0.95)); // approximate 5% SL
  trade.rMultiple = riskPerShare > 0 ? Math.round((pnlPerShare / riskPerShare) * 100) / 100 : 0;

  trade.status = trade.pnl > 0 ? "WIN" : trade.pnl < 0 ? "LOSS" : "BREAKEVEN";

  // Update capital
  ch.currentCapital += trade.pnl;
  if (ch.currentCapital > ch.peakCapital) ch.peakCapital = ch.currentCapital;
  ch.currentCapital = Math.max(ch.currentCapital, 0);

  // Update stats
  if (trade.pnl > 0) { ch.winCount++; ch.consecutiveLosses = 0; }
  else if (trade.pnl < 0) { ch.lossCount++; ch.consecutiveLosses++; ch.maxConsecutiveLosses = Math.max(ch.maxConsecutiveLosses, ch.consecutiveLosses); }

  ch.winRate = ch.totalTrades > 0 ? Math.round((ch.winCount / ch.totalTrades) * 10000) / 100 : 0;

  const totalWins = ch.trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const totalLosses = Math.abs(ch.trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  ch.profitFactor = totalLosses > 0 ? Math.round((totalWins / totalLosses) * 100) / 100 : totalWins > 0 ? 99 : 0;
  ch.expectancy = ch.totalTrades > 0 ? Math.round((ch.trades.reduce((s, t) => s + t.pnl, 0) / ch.totalTrades) * 100) / 100 : 0;

  // Update drawdown
  ch.currentDrawdown = checkDrawdown(ch.currentCapital, ch.peakCapital, trade.pnl, ch.startingCapital, ch.config);
  ch.maxDrawdownPct = Math.max(ch.maxDrawdownPct, ch.currentDrawdown.totalDrawdownPct);
  ch.milestones = getMilestones(ch.currentCapital, ch.startingCapital);
  ch.progressPct = getChallengeProgress(ch.currentCapital, ch.config);

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

// ── Get daily summary ──
export function getDailySummary(): DailySnapshot[] {
  const ch = getChallenge();
  const byDay: Record<string, ChallengeTrade[]> = {};
  for (const t of ch.trades) {
    const day = t.timestamp.split("T")[0];
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(t);
  }

  return Object.entries(byDay).map(([date, trades]) => {
    const closed = trades.filter(t => t.status !== "OPEN");
    const pnl = closed.reduce((s, t) => s + t.pnl, 0);
    return {
      date,
      openCapital: ch.startingCapital, // simplified
      closeCapital: ch.currentCapital,
      highCapital: ch.currentCapital,
      lowCapital: ch.currentCapital,
      pnl,
      trades: closed.length,
      wins: closed.filter(t => t.status === "WIN").length,
      losses: closed.filter(t => t.status === "LOSS").length,
      drawdown: 0,
    };
  });
}

// ── Reset challenge (failure → new challenge) ──
export function resetChallenge(): ChallengeState {
  const ch = getChallenge();
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
