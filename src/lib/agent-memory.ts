// Agent Memory — persistent memory for Hermes Agent
// Stores trade patterns, setup memories, prediction accuracy, user preferences.
// File-based JSON store (SQLite-free for portability, runs on main thread).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { JarvisSignal } from "@/lib/jarvis/types";

const MEMORY_DIR = join(process.cwd(), "data", "agent-memory");
const FILES = {
  tradePatterns: "trade-patterns.json",
  setupMemory: "setup-memory.json",
  predictions: "predictions.json",
  preferences: "preferences.json",
  alerts: "alert-history.json",
  jarvisSignals: "jarvis-signals.json",
} as const;

interface TradePattern {
  id: string;
  symbol: string;
  strategy: string;
  setup: string;
  entry: { price: number; time: string };
  exit?: { price: number; time: string; pnl: number };
  tags: string[];
  confidence: number;
  timestamp: string;
}

interface SetupMemory {
  setup: string;
  symbol: string;
  winRate: number;
  avgPnL: number;
  totalTrades: number;
  lastSeen: string;
  notes: string[];
}

interface Prediction {
  id: string;
  symbol: string;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  basis: string;
  entryPrice: number;
  targetPrice?: number;
  stopLoss?: number;
  result?: "WIN" | "LOSS" | "PARTIAL" | "EXPIRED";
  actualPnL?: number;
  timestamp: string;
  resolvedAt?: string;
}

interface UserPreferences {
  defaultSymbol: string;
  defaultCapital: number;
  riskPerTradePct: number;
  preferredStrategies: string[];
  ignoredAlerts: string[];
  lastUpdated: string;
}

interface AlertRecord {
  id: string;
  type: string;
  symbol: string;
  message: string;
  severity: string;
  acknowledged: boolean;
  timestamp: string;
}

function ensureDir() {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

function loadJson<T>(file: string): T[] {
  ensureDir();
  const path = join(MEMORY_DIR, file);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T[];
  } catch { return []; }
}

function saveJson<T>(file: string, data: T[]) {
  ensureDir();
  writeFileSync(join(MEMORY_DIR, file), JSON.stringify(data, null, 2));
}

function loadPrefs(): UserPreferences {
  ensureDir();
  const path = join(MEMORY_DIR, FILES.preferences);
  if (!existsSync(path)) {
    const defaults: UserPreferences = {
      defaultSymbol: "NIFTY",
      defaultCapital: 100000,
      riskPerTradePct: 2,
      preferredStrategies: [],
      ignoredAlerts: [],
      lastUpdated: new Date().toISOString(),
    };
    saveJson(FILES.preferences, [defaults]);
    return defaults;
  }
  try {
    const arr = JSON.parse(readFileSync(path, "utf-8")) as UserPreferences[];
    return arr[0] || loadPrefs();
  } catch { return loadPrefs(); }
}

function savePrefs(prefs: UserPreferences) {
  saveJson(FILES.preferences, [{ ...prefs, lastUpdated: new Date().toISOString() }]);
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─── Trade Patterns ───
export function recordTrade(pattern: Omit<TradePattern, "id" | "timestamp">) {
  const patterns = loadJson<TradePattern>(FILES.tradePatterns);
  patterns.push({ ...pattern, id: uid(), timestamp: new Date().toISOString() });
  // Keep last 500
  if (patterns.length > 500) patterns.splice(0, patterns.length - 500);
  saveJson(FILES.tradePatterns, patterns);
  updateSetupMemory(pattern);
}

export function getTradePatterns(symbol?: string, strategy?: string, limit = 50): TradePattern[] {
  let patterns = loadJson<TradePattern>(FILES.tradePatterns);
  if (symbol) patterns = patterns.filter(p => p.symbol === symbol);
  if (strategy) patterns = patterns.filter(p => p.strategy === strategy);
  return patterns.slice(-limit);
}

export function searchTradePatterns(query: string, limit = 20): TradePattern[] {
  const patterns = loadJson<TradePattern>(FILES.tradePatterns);
  const q = query.toLowerCase();
  return patterns
    .filter(p =>
      p.symbol.toLowerCase().includes(q) ||
      p.strategy.toLowerCase().includes(q) ||
      p.setup.toLowerCase().includes(q) ||
      p.tags.some(t => t.toLowerCase().includes(q))
    )
    .slice(-limit);
}

// ─── Setup Memory ───
function updateSetupMemory(pattern: Omit<TradePattern, "id" | "timestamp">) {
  const memories = loadJson<SetupMemory>(FILES.setupMemory);
  const key = `${pattern.symbol}|${pattern.setup}`;
  const existing = memories.find(m => `${m.symbol}|${m.setup}` === key);
  if (existing) {
    existing.totalTrades += 1;
    if (pattern.exit) {
      const win = pattern.exit.pnl > 0;
      existing.winRate = ((existing.winRate * (existing.totalTrades - 1)) + (win ? 1 : 0)) / existing.totalTrades;
      existing.avgPnL = ((existing.avgPnL * (existing.totalTrades - 1)) + pattern.exit.pnl) / existing.totalTrades;
    }
    existing.lastSeen = new Date().toISOString();
  } else {
    memories.push({
      setup: pattern.setup,
      symbol: pattern.symbol,
      winRate: pattern.exit ? (pattern.exit.pnl > 0 ? 1 : 0) : 0,
      avgPnL: pattern.exit?.pnl || 0,
      totalTrades: 1,
      lastSeen: new Date().toISOString(),
      notes: [],
    });
  }
  saveJson(FILES.setupMemory, memories);
}

export function getSetupMemory(symbol?: string): SetupMemory[] {
  let memories = loadJson<SetupMemory>(FILES.setupMemory);
  if (symbol) memories = memories.filter(m => m.symbol === symbol);
  return memories.sort((a, b) => b.totalTrades - a.totalTrades);
}

export function getBestSetups(symbol?: string, minTrades = 3): SetupMemory[] {
  return getSetupMemory(symbol)
    .filter(m => m.totalTrades >= minTrades)
    .sort((a, b) => b.winRate - a.winRate || b.avgPnL - a.avgPnL);
}

// ─── Predictions ───
export function recordPrediction(pred: Omit<Prediction, "id" | "timestamp">) {
  const preds = loadJson<Prediction>(FILES.predictions);
  preds.push({ ...pred, id: uid(), timestamp: new Date().toISOString() });
  if (preds.length > 200) preds.splice(0, preds.length - 200);
  saveJson(FILES.predictions, preds);
}

export function resolvePrediction(id: string, result: Prediction["result"], actualPnL?: number) {
  const preds = loadJson<Prediction>(FILES.predictions);
  const pred = preds.find(p => p.id === id);
  if (pred) {
    pred.result = result;
    pred.actualPnL = actualPnL;
    pred.resolvedAt = new Date().toISOString();
    saveJson(FILES.predictions, preds);
  }
}

export function getPredictionAccuracy(symbol?: string): { total: number; wins: number; accuracy: number; avgPnL: number } {
  let preds = loadJson<Prediction>(FILES.predictions).filter(p => p.result);
  if (symbol) preds = preds.filter(p => p.symbol === symbol);
  const wins = preds.filter(p => p.result === "WIN").length;
  const avgPnL = preds.length > 0 ? preds.reduce((s, p) => s + (p.actualPnL || 0), 0) / preds.length : 0;
  return { total: preds.length, wins, accuracy: preds.length > 0 ? wins / preds.length : 0, avgPnL };
}

// ─── User Preferences ───
export function getUserPreferences(): UserPreferences {
  return loadPrefs();
}

export function updateUserPreferences(update: Partial<UserPreferences>) {
  const prefs = loadPrefs();
  Object.assign(prefs, update);
  savePrefs(prefs);
}

// ─── Alert History ───
export function recordAlert(alert: Omit<AlertRecord, "id" | "timestamp" | "acknowledged">) {
  const alerts = loadJson<AlertRecord>(FILES.alerts);
  alerts.push({ ...alert, id: uid(), acknowledged: false, timestamp: new Date().toISOString() });
  if (alerts.length > 200) alerts.splice(0, alerts.length - 200);
  saveJson(FILES.alerts, alerts);
}

export function getAlertHistory(type?: string, limit = 30): AlertRecord[] {
  let alerts = loadJson<AlertRecord>(FILES.alerts);
  if (type) alerts = alerts.filter(a => a.type === type);
  return alerts.slice(-limit);
}

export function acknowledgeAlert(id: string) {
  const alerts = loadJson<AlertRecord>(FILES.alerts);
  const alert = alerts.find(a => a.id === id);
  if (alert) {
    alert.acknowledged = true;
    saveJson(FILES.alerts, alerts);
  }
}

// ─── Jarvis Signals (dedicated store — kept out of alert-history.json
// so the shared 200-record cap there isn't evicted by 60s worker writes) ───
export function recordJarvisSignal(signal: JarvisSignal) {
  const list = loadJson<JarvisSignal>(FILES.jarvisSignals);
  list.push(signal);
  if (list.length > 300) list.splice(0, list.length - 300);
  saveJson(FILES.jarvisSignals, list);
}

/** Newest first. Filter by instrument when given. */
export function getJarvisSignals(instrument?: string, limit = 10): JarvisSignal[] {
  let list = loadJson<JarvisSignal>(FILES.jarvisSignals);
  if (instrument) list = list.filter(s => s && s.instrument === instrument);
  return list.slice(-limit).reverse();
}

// ─── Summary ───
export function getMemorySummary(): string {
  const patterns = loadJson<TradePattern>(FILES.tradePatterns);
  const memories = loadJson<SetupMemory>(FILES.setupMemory);
  const preds = loadJson<Prediction>(FILES.predictions).filter(p => p.result);
  const prefs = loadPrefs();
  const wins = preds.filter(p => p.result === "WIN").length;
  const bestSetup = memories.sort((a, b) => b.winRate - a.winRate)[0];
  const recentPatterns = patterns.slice(-5);

  const parts: string[] = [];
  parts.push(`Trade patterns: ${patterns.length} recorded`);
  parts.push(`Setups tracked: ${memories.length}`);
  if (bestSetup && bestSetup.totalTrades >= 3) {
    parts.push(`Best setup: ${bestSetup.setup} on ${bestSetup.symbol} — ${(bestSetup.winRate * 100).toFixed(0)}% WR over ${bestSetup.totalTrades} trades`);
  }
  parts.push(`Predictions: ${preds.length} resolved, ${(wins / Math.max(preds.length, 1) * 100).toFixed(0)}% accuracy`);
  parts.push(`Default capital: ₹${prefs.defaultCapital.toLocaleString("en-IN")} | Risk per trade: ${prefs.riskPerTradePct}%`);
  if (recentPatterns.length > 0) {
    parts.push(`Recent trades: ${recentPatterns.map(p => `${p.symbol} ${p.strategy} ${p.exit?.pnl ? (p.exit.pnl > 0 ? "+" : "") + "₹" + p.exit.pnl.toFixed(0) : "open"}`).join(", ")}`);
  }
  return parts.join("\n");
}
